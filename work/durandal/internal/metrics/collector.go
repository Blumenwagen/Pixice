package metrics

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/shirou/gopsutil/v4/sensors"
)

var (
	prevBytesSent uint64
	prevBytesRecv uint64
	prevTime      time.Time

	// Process tracking for accurate CPU delta and minimizing system calls
	procMutex sync.Mutex
)

// CollectSnapshot gathers a full system metrics snapshot concurrently.
func CollectSnapshot() (Snapshot, error) {
	var snap Snapshot
	var wg sync.WaitGroup

	wg.Add(8)

	go func() { defer wg.Done(); snap.Host = collectHost() }()
	go func() { defer wg.Done(); snap.CPU = collectCPU() }()
	go func() { defer wg.Done(); snap.Memory = collectMemory() }()
	go func() { defer wg.Done(); snap.Processes = collectProcesses(50) }()
	go func() { defer wg.Done(); snap.Network = collectNetwork() }()
	go func() { defer wg.Done(); snap.Disks = collectDisks() }()
	go func() { defer wg.Done(); snap.Sensors = collectSensors() }()
	go func() { defer wg.Done(); snap.Docker = collectDocker() }()

	wg.Wait()

	// Run GPU check outside waitgroup, async or via cache to not block
	snap.GPUs = collectGPUs()

	return snap, nil
}

func collectHost() HostInfo {
	info := HostInfo{}
	h, err := host.Info()
	if err == nil {
		info.Hostname = h.Hostname
		info.OS = h.Platform + " " + h.PlatformVersion
		info.Kernel = h.KernelVersion
		info.Architecture = h.KernelArch

		upSecs := h.Uptime
		days := upSecs / 86400
		hours := (upSecs % 86400) / 3600
		mins := (upSecs % 3600) / 60
		if days > 0 {
			info.Uptime = fmt.Sprintf("%dd %dh %dm", days, hours, mins)
		} else if hours > 0 {
			info.Uptime = fmt.Sprintf("%dh %dm", hours, mins)
		} else {
			info.Uptime = fmt.Sprintf("%dm", mins)
		}
	} else {
		info.Hostname, _ = os.Hostname()
	}

	importUser, err := os.UserHomeDir()
	if err == nil {
		parts := strings.Split(importUser, "/")
		if len(parts) > 0 {
			info.User = parts[len(parts)-1]
		}
	}

	return info
}

func collectCPU() CPUInfo {
	info := CPUInfo{}

	// Short timeout blocking
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	percents, err := cpu.PercentWithContext(ctx, 0, false)
	if err == nil && len(percents) > 0 {
		info.TotalPercent = percents[0]
	}

	perCore, err := cpu.PercentWithContext(ctx, 0, true)
	if err == nil {
		info.PerCore = perCore
	}

	cpuInfo, err := cpu.InfoWithContext(ctx)
	if err == nil && len(cpuInfo) > 0 {
		info.ModelName = cpuInfo[0].ModelName
		info.Cores = int(cpuInfo[0].Cores)
	}
	info.Threads = len(info.PerCore)

	return info
}

func collectMemory() MemInfo {
	info := MemInfo{}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	v, err := mem.VirtualMemoryWithContext(ctx)
	if err == nil {
		info.TotalRAM = v.Total
		info.UsedRAM = v.Used
		info.PercentRAM = v.UsedPercent
		info.Cached = v.Cached
		info.Buffers = v.Buffers
	}

	s, err := mem.SwapMemoryWithContext(ctx)
	if err == nil {
		info.TotalSwap = s.Total
		info.UsedSwap = s.Used
		info.PercentSwap = s.UsedPercent
	}

	return info
}

var pageSize uint64

type procStat struct {
	utime uint64
	stime uint64
}

type procTemp struct {
	pid    int32
	name   string
	state  string
	cpuPct float64
	memPct float32
	rss    uint64
}

var (
	procStatCache = make(map[int32]procStat)
	uidCache      = make(map[uint32]string)
	sysClockTicks = float64(100) // Default Linux CONFIG_HZ
	lastProcCheck time.Time
	sysTotalRAM   uint64
)

func init() {
	pageSize = uint64(os.Getpagesize())
	if v, err := mem.VirtualMemory(); err == nil {
		sysTotalRAM = v.Total
	}
}

// collectProcesses uses a highly optimized direct /proc parser to avoid gopsutil's
// excessive file reading and BootTime polling per process.
func collectProcesses(limit int) []ProcessInfo {
	if runtime.GOOS == "darwin" {
		return collectProcessesDarwin(limit)
	}
	if runtime.GOOS != "linux" {
		return collectProcessesPortable(limit)
	}

	dirs, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}

	procMutex.Lock()
	defer procMutex.Unlock()

	now := time.Now()
	var elapsed float64 = 1.0
	if !lastProcCheck.IsZero() {
		elapsed = now.Sub(lastProcCheck).Seconds()
	}
	lastProcCheck = now

	// We only want to track processes we actually saw this loop
	activeMap := make(map[int32]bool)
	var temps []procTemp

	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		var pid int32
		if _, err := fmt.Sscanf(d.Name(), "%d", &pid); err != nil {
			continue // Not a PID directory
		}

		activeMap[pid] = true

		statData, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			continue
		}

		// Parse name which is in (parentheses)
		startName := strings.IndexByte(string(statData), '(')
		endName := strings.LastIndexByte(string(statData), ')')
		if startName == -1 || endName == -1 || endName <= startName {
			continue
		}

		name := string(statData[startName+1 : endName])

		// Parse the rest of the stat string
		fields := strings.Fields(string(statData[endName+2:]))
		if len(fields) < 22 {
			continue
		}

		state := fields[0]

		var utime, stime, rssPages uint64
		fmt.Sscanf(fields[11], "%d", &utime)
		fmt.Sscanf(fields[12], "%d", &stime)
		fmt.Sscanf(fields[21], "%d", &rssPages)

		rss := rssPages * pageSize

		totalTime := utime + stime
		var cpuPct float64

		if prev, ok := procStatCache[pid]; ok {
			ticks := float64(totalTime - (prev.utime + prev.stime))
			// ticks per second / clock ticks = CPU seconds used. Divide by elapsed wall clock.
			cpuPct = (ticks / sysClockTicks) / elapsed * 100.0
		}

		procStatCache[pid] = procStat{utime: utime, stime: stime}

		var memPct float32
		if sysTotalRAM > 0 {
			memPct = float32(float64(rss) / float64(sysTotalRAM) * 100.0)
		}

		temps = append(temps, procTemp{
			pid:    pid,
			name:   name,
			state:  state,
			cpuPct: cpuPct,
			rss:    rss,
			memPct: memPct,
		})
	}

	// Purge
	for pid := range procStatCache {
		if !activeMap[pid] {
			delete(procStatCache, pid)
		}
	}

	// Sort
	sort.Slice(temps, func(i, j int) bool {
		return temps[i].cpuPct > temps[j].cpuPct
	})

	limitCt := limit
	if len(temps) < limitCt {
		limitCt = len(temps)
	}

	var result []ProcessInfo
	for i := 0; i < limitCt; i++ {
		t := temps[i]

		// Resolve heavy fields only for visible entries
		cmdlineData, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", t.pid))
		cmdline := string(cmdlineData)
		cmdline = strings.ReplaceAll(cmdline, "\x00", " ")
		cmdline = strings.TrimSpace(cmdline)
		if cmdline == "" {
			cmdline = t.name
		}
		if len(cmdline) > 40 {
			cmdline = cmdline[:37] + "..."
		}

		// Exact user fetching via UID ownership of /proc/pid directory
		userStr := "root"
		if info, err := os.Stat(fmt.Sprintf("/proc/%d", t.pid)); err == nil {
			if stat, ok := info.Sys().(*syscall.Stat_t); ok {
				if uname, exists := uidCache[stat.Uid]; exists {
					userStr = uname
				} else {
					if u, err := user.LookupId(fmt.Sprint(stat.Uid)); err == nil {
						uidCache[stat.Uid] = u.Username
						userStr = u.Username
					} else {
						userStr = fmt.Sprint(stat.Uid)
						uidCache[stat.Uid] = userStr
					}
				}
			}
		}

		result = append(result, ProcessInfo{
			PID:     t.pid,
			Name:    t.name,
			CPU:     t.cpuPct,
			Memory:  t.memPct,
			MemRSS:  t.rss,
			Status:  t.state,
			User:    userStr,
			Command: cmdline,
		})
	}

	return result
}

func collectProcessesPortable(limit int) []ProcessInfo {
	procs, err := process.Processes()
	if err != nil {
		return nil
	}

	result := make([]ProcessInfo, 0, len(procs))
	for _, proc := range procs {
		name, err := proc.Name()
		if err != nil {
			continue
		}

		cpuPct, _ := proc.CPUPercent()
		memPct, _ := proc.MemoryPercent()
		memInfo, _ := proc.MemoryInfo()
		statuses, _ := proc.Status()
		username, _ := proc.Username()
		cmdline, _ := proc.Cmdline()
		if cmdline == "" {
			cmdline = name
		}
		if len(cmdline) > 40 {
			cmdline = cmdline[:37] + "..."
		}

		var rss uint64
		if memInfo != nil {
			rss = memInfo.RSS
		}

		result = append(result, ProcessInfo{
			PID:     proc.Pid,
			Name:    name,
			CPU:     cpuPct,
			Memory:  memPct,
			MemRSS:  rss,
			Status:  strings.Join(statuses, ","),
			User:    username,
			Command: cmdline,
		})
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].CPU > result[j].CPU
	})
	if limit >= 0 && len(result) > limit {
		result = result[:limit]
	}

	return result
}

func collectNetwork() (info NetworkInfo) {
	// gopsutil's Darwin parser can panic on newer netstat output. A missing
	// network sample should not bring down the whole monitor.
	defer func() {
		if recover() != nil {
			info = NetworkInfo{}
		}
	}()

	counters, err := net.IOCounters(false)
	if err == nil && len(counters) > 0 {
		info.BytesSent = counters[0].BytesSent
		info.BytesRecv = counters[0].BytesRecv

		now := time.Now()
		if !prevTime.IsZero() {
			elapsed := now.Sub(prevTime).Seconds()
			if elapsed > 0 {
				info.BytesSentRate = uint64(float64(info.BytesSent-prevBytesSent) / elapsed)
				info.BytesRecvRate = uint64(float64(info.BytesRecv-prevBytesRecv) / elapsed)
			}
		}

		prevBytesSent = info.BytesSent
		prevBytesRecv = info.BytesRecv
		prevTime = now
	}

	return info
}

func collectDisks() []DiskInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	partitions, err := disk.PartitionsWithContext(ctx, true)
	if err != nil {
		return nil
	}

	var result []DiskInfo
	seen := make(map[string]bool)

	for _, p := range partitions {
		if p.Fstype == "squashfs" || p.Fstype == "tmpfs" || p.Fstype == "devtmpfs" ||
			strings.HasPrefix(p.Mountpoint, "/snap") || strings.HasPrefix(p.Mountpoint, "/var/lib/docker") ||
			strings.HasPrefix(p.Mountpoint, "/run") || strings.HasPrefix(p.Mountpoint, "/sys") || strings.HasPrefix(p.Mountpoint, "/dev") {
			continue
		}
		if seen[p.Device] {
			continue
		}
		seen[p.Device] = true

		usage, err := disk.UsageWithContext(ctx, p.Mountpoint)
		if err != nil || usage.Total == 0 {
			continue
		}

		result = append(result, DiskInfo{
			Mountpoint:  p.Mountpoint,
			Device:      p.Device,
			Filesystem:  p.Fstype,
			Total:       usage.Total,
			Used:        usage.Used,
			UsedPercent: usage.UsedPercent,
		})
	}
	return result
}

func collectSensors() SensorInfo {
	info := SensorInfo{}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	temps, err := sensors.TemperaturesWithContext(ctx)
	if err == nil {
		for _, t := range temps {
			if t.Temperature > 0 {
				info.Temperatures = append(info.Temperatures, TemperatureReading{
					Label:       t.SensorKey,
					Temperature: t.Temperature,
				})
			}
		}
	}

	battPath := "/sys/class/power_supply/BAT0/capacity"
	if data, err := os.ReadFile(battPath); err == nil {
		var pct float64
		fmt.Sscanf(strings.TrimSpace(string(data)), "%f", &pct)

		statusData, _ := os.ReadFile("/sys/class/power_supply/BAT0/status")
		status := strings.TrimSpace(string(statusData))

		info.Battery = &BatteryInfo{
			Percent:    pct,
			IsCharging: status == "Charging",
		}
	}

	return info
}

func collectGPUs() []GPUInfo {
	var gpus []GPUInfo

	dirs, err := os.ReadDir("/sys/class/drm")
	if err != nil {
		return nil
	}

	for _, dir := range dirs {
		name := dir.Name()
		if !strings.HasPrefix(name, "card") || strings.Contains(name, "-") {
			continue // skip display connectors like card0-DP-1
		}

		path := fmt.Sprintf("/sys/class/drm/%s/device", name)

		vendorIdBytes, err := os.ReadFile(fmt.Sprintf("%s/vendor", path))
		if err != nil {
			continue
		}

		vendorHex := strings.TrimSpace(string(vendorIdBytes))
		var cardName string
		switch vendorHex {
		case "0x1002":
			cardName = "AMD Radeon"
		case "0x10de":
			cardName = "NVIDIA GPU"
		case "0x8086":
			cardName = "Intel Graphics"
		default:
			cardName = "Generic GPU"
		}

		var util float64
		busyBytes, err := os.ReadFile(fmt.Sprintf("%s/gpu_busy_percent", path))
		if err == nil {
			fmt.Sscanf(strings.TrimSpace(string(busyBytes)), "%f", &util)
		} else {
			actFreqBytes, err := os.ReadFile(fmt.Sprintf("%s/gt_act_freq_mhz", path))
			if err == nil {
				var freq float64
				fmt.Sscanf(strings.TrimSpace(string(actFreqBytes)), "%f", &freq)
				// Basic Intel heuristic based on frequency
				util = (freq / 1200.0) * 100.0
				if util > 100 {
					util = 100
				}
			}
		}

		var memU uint64
		var memT uint64

		memUsedBytes, err := os.ReadFile(fmt.Sprintf("%s/mem_info_vram_used", path))
		if err == nil {
			fmt.Sscanf(strings.TrimSpace(string(memUsedBytes)), "%d", &memU)
			memU = memU / 1024 / 1024
		}
		memTotalBytes, err := os.ReadFile(fmt.Sprintf("%s/mem_info_vram_total", path))
		if err == nil {
			fmt.Sscanf(strings.TrimSpace(string(memTotalBytes)), "%d", &memT)
			memT = memT / 1024 / 1024
		}

		gpus = append(gpus, GPUInfo{
			Name:        cardName,
			Utilization: util,
			MemoryUsed:  memU,
			MemoryTotal: memT,
			Temperature: 0, // Not uniformly mapped in sysfs for drm directly
		})
	}

	return gpus
}

type dockerContainerJSON struct {
	ID     string `json:"ID"`
	Image  string `json:"Image"`
	Names  string `json:"Names"`
	Status string `json:"Status"`
	State  string `json:"State"`
	Ports  string `json:"Ports"`
}

func collectDocker() DockerInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(ctx, "docker", "ps", "-a", "--format", "{{json .}}")
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return DockerInfo{Error: "docker query timed out"}
	}
	if err != nil {
		return DockerInfo{Error: shortDockerError(err, out)}
	}

	info := DockerInfo{Available: true}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return info
	}

	for _, line := range lines {
		var raw dockerContainerJSON
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		state := strings.ToLower(raw.State)
		info.Containers = append(info.Containers, ContainerInfo{
			ID:      raw.ID,
			Image:   raw.Image,
			Name:    raw.Names,
			Status:  raw.Status,
			State:   raw.State,
			Ports:   raw.Ports,
			Running: state == "running",
		})
	}

	sort.SliceStable(info.Containers, func(i, j int) bool {
		if info.Containers[i].Running != info.Containers[j].Running {
			return info.Containers[i].Running
		}
		return info.Containers[i].Name < info.Containers[j].Name
	})

	return info
}

func shortDockerError(err error, out []byte) string {
	if _, ok := err.(*exec.Error); ok {
		return "docker CLI not found"
	}
	msg := strings.TrimSpace(string(out))
	if msg != "" {
		lines := strings.Split(msg, "\n")
		return strings.TrimSpace(lines[0])
	}
	return "docker unavailable"
}
