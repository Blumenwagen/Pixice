package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/ops"
)

const Schema = "durandal.agent.v1"

type Options struct {
	TopProcesses int
	GeneratedAt  time.Time
}

type Payload struct {
	Schema         string           `json:"schema"`
	GeneratedAt    string           `json:"generated_at"`
	Host           HostSummary      `json:"host"`
	Health         HealthSummary    `json:"health"`
	Resources      ResourceSummary  `json:"resources"`
	TopProcesses   []ProcessSummary `json:"top_processes"`
	Docker         DockerSummary    `json:"docker"`
	AgentShortText string           `json:"agent_short_text"`
}

type HostSummary struct {
	Hostname string `json:"hostname"`
	User     string `json:"user,omitempty"`
	OS       string `json:"os,omitempty"`
	Kernel   string `json:"kernel,omitempty"`
	Arch     string `json:"arch,omitempty"`
	Uptime   string `json:"uptime,omitempty"`
}

type HealthSummary struct {
	Score           int            `json:"score"`
	Status          string         `json:"status"`
	Alerts          []AlertSummary `json:"alerts"`
	Recommendations []string       `json:"recommendations"`
}

type AlertSummary struct {
	Severity string `json:"severity"`
	Label    string `json:"label"`
	Message  string `json:"message"`
}

type ResourceSummary struct {
	CPU     CPUSummary     `json:"cpu"`
	Memory  MemorySummary  `json:"memory"`
	Swap    SwapSummary    `json:"swap"`
	Network NetworkSummary `json:"network"`
	Disks   []DiskSummary  `json:"disks"`
	GPUs    []GPUSummary   `json:"gpus,omitempty"`
}

type CPUSummary struct {
	Percent float64 `json:"percent"`
	Model   string  `json:"model,omitempty"`
	Cores   int     `json:"cores,omitempty"`
	Threads int     `json:"threads,omitempty"`
}

type MemorySummary struct {
	TotalBytes uint64  `json:"total_bytes"`
	UsedBytes  uint64  `json:"used_bytes"`
	Percent    float64 `json:"percent"`
	Cached     uint64  `json:"cached_bytes,omitempty"`
	Buffers    uint64  `json:"buffers_bytes,omitempty"`
}

type SwapSummary struct {
	TotalBytes uint64  `json:"total_bytes"`
	UsedBytes  uint64  `json:"used_bytes"`
	Percent    float64 `json:"percent"`
}

type NetworkSummary struct {
	RecvBytesPerSec uint64 `json:"recv_bytes_per_sec"`
	SentBytesPerSec uint64 `json:"sent_bytes_per_sec"`
}

type DiskSummary struct {
	Mountpoint string  `json:"mountpoint"`
	Device     string  `json:"device,omitempty"`
	Filesystem string  `json:"filesystem,omitempty"`
	TotalBytes uint64  `json:"total_bytes"`
	UsedBytes  uint64  `json:"used_bytes"`
	Percent    float64 `json:"percent"`
}

type GPUSummary struct {
	Name          string  `json:"name"`
	Utilization   float64 `json:"utilization_percent"`
	MemoryUsedMB  uint64  `json:"memory_used_mb,omitempty"`
	MemoryTotalMB uint64  `json:"memory_total_mb,omitempty"`
	TemperatureC  float64 `json:"temperature_c,omitempty"`
}

type ProcessSummary struct {
	PID     int32   `json:"pid"`
	Name    string  `json:"name"`
	CPU     float64 `json:"cpu_percent"`
	Memory  float32 `json:"memory_percent"`
	MemRSS  uint64  `json:"rss_bytes"`
	Status  string  `json:"status,omitempty"`
	User    string  `json:"user,omitempty"`
	Command string  `json:"command,omitempty"`
}

type DockerSummary struct {
	Available  bool               `json:"available"`
	Error      string             `json:"error,omitempty"`
	Total      int                `json:"total"`
	Running    int                `json:"running"`
	Stopped    int                `json:"stopped"`
	Containers []ContainerSummary `json:"containers,omitempty"`
}

type ContainerSummary struct {
	Name    string `json:"name"`
	Image   string `json:"image"`
	State   string `json:"state"`
	Status  string `json:"status,omitempty"`
	Ports   string `json:"ports,omitempty"`
	Running bool   `json:"running"`
}

func BuildReport(snap metrics.Snapshot, report ops.Report, opts Options) Payload {
	generatedAt := opts.GeneratedAt
	if generatedAt.IsZero() {
		generatedAt = time.Now().UTC()
	}
	topN := opts.TopProcesses
	if topN <= 0 {
		topN = 8
	}

	payload := Payload{
		Schema:      Schema,
		GeneratedAt: generatedAt.UTC().Format(time.RFC3339),
		Host: HostSummary{
			Hostname: snap.Host.Hostname,
			User:     snap.Host.User,
			OS:       snap.Host.OS,
			Kernel:   snap.Host.Kernel,
			Arch:     snap.Host.Architecture,
			Uptime:   snap.Host.Uptime,
		},
		Health: HealthSummary{
			Score:  report.Score,
			Status: string(report.Status),
		},
		Resources: ResourceSummary{
			CPU: CPUSummary{
				Percent: snap.CPU.TotalPercent,
				Model:   snap.CPU.ModelName,
				Cores:   snap.CPU.Cores,
				Threads: snap.CPU.Threads,
			},
			Memory: MemorySummary{
				TotalBytes: snap.Memory.TotalRAM,
				UsedBytes:  snap.Memory.UsedRAM,
				Percent:    snap.Memory.PercentRAM,
				Cached:     snap.Memory.Cached,
				Buffers:    snap.Memory.Buffers,
			},
			Swap: SwapSummary{
				TotalBytes: snap.Memory.TotalSwap,
				UsedBytes:  snap.Memory.UsedSwap,
				Percent:    snap.Memory.PercentSwap,
			},
			Network: NetworkSummary{
				RecvBytesPerSec: snap.Network.BytesRecvRate,
				SentBytesPerSec: snap.Network.BytesSentRate,
			},
		},
	}

	for _, alert := range report.Alerts {
		payload.Health.Alerts = append(payload.Health.Alerts, AlertSummary{
			Severity: severityName(alert.Severity),
			Label:    alert.Label,
			Message:  alert.Message,
		})
	}
	payload.Health.Recommendations = recommendations(snap, report)

	for _, disk := range snap.Disks {
		payload.Resources.Disks = append(payload.Resources.Disks, DiskSummary{
			Mountpoint: disk.Mountpoint,
			Device:     disk.Device,
			Filesystem: disk.Filesystem,
			TotalBytes: disk.Total,
			UsedBytes:  disk.Used,
			Percent:    disk.UsedPercent,
		})
	}
	for _, gpu := range snap.GPUs {
		payload.Resources.GPUs = append(payload.Resources.GPUs, GPUSummary{
			Name:          gpu.Name,
			Utilization:   gpu.Utilization,
			MemoryUsedMB:  gpu.MemoryUsed,
			MemoryTotalMB: gpu.MemoryTotal,
			TemperatureC:  gpu.Temperature,
		})
	}

	limit := topN
	if len(snap.Processes) < limit {
		limit = len(snap.Processes)
	}
	for i := 0; i < limit; i++ {
		proc := snap.Processes[i]
		payload.TopProcesses = append(payload.TopProcesses, ProcessSummary{
			PID:     proc.PID,
			Name:    proc.Name,
			CPU:     proc.CPU,
			Memory:  proc.Memory,
			MemRSS:  proc.MemRSS,
			Status:  proc.Status,
			User:    proc.User,
			Command: proc.Command,
		})
	}

	payload.Docker = summarizeDocker(snap.Docker)
	payload.AgentShortText = shortText(payload)
	return payload
}

func MarshalReport(payload Payload, pretty bool) ([]byte, error) {
	if pretty {
		return json.MarshalIndent(payload, "", "  ")
	}
	return json.Marshal(payload)
}

func severityName(sev ops.Severity) string {
	switch sev {
	case ops.SeverityCritical:
		return "critical"
	case ops.SeverityWarning:
		return "warning"
	case ops.SeverityWatch:
		return "watch"
	default:
		return "info"
	}
}

func summarizeDocker(info metrics.DockerInfo) DockerSummary {
	summary := DockerSummary{Available: info.Available, Error: info.Error, Total: len(info.Containers)}
	for _, container := range info.Containers {
		if container.Running {
			summary.Running++
		} else {
			summary.Stopped++
		}
		summary.Containers = append(summary.Containers, ContainerSummary{
			Name:    container.Name,
			Image:   container.Image,
			State:   container.State,
			Status:  container.Status,
			Ports:   container.Ports,
			Running: container.Running,
		})
	}
	return summary
}

func recommendations(snap metrics.Snapshot, report ops.Report) []string {
	seen := make(map[string]bool)
	var recs []string
	add := func(text string) {
		if text == "" || seen[text] {
			return
		}
		seen[text] = true
		recs = append(recs, text)
	}

	if report.Status == ops.StatusClear {
		add("Host is nominal; no immediate action required.")
	}
	if snap.CPU.TotalPercent >= 75 {
		add("CPU pressure is high; inspect top CPU processes before starting more heavy work.")
	}
	if snap.Memory.PercentRAM >= 78 {
		add("RAM pressure is high; check memory-heavy processes and consider stopping nonessential services.")
	}
	if snap.Memory.PercentSwap >= 20 {
		add("Swap is active; reduce memory pressure before latency-sensitive tasks.")
	}
	for _, disk := range snap.Disks {
		if disk.UsedPercent >= 85 {
			add(fmt.Sprintf("Disk %s is %.0f%% full; clean logs, caches, or old artifacts before large writes.", disk.Mountpoint, disk.UsedPercent))
		}
	}
	if snap.Docker.Available && len(snap.Docker.Containers) > 0 {
		stopped := 0
		for _, container := range snap.Docker.Containers {
			if !container.Running {
				stopped++
			}
		}
		if stopped > 0 {
			add(fmt.Sprintf("Docker has %d stopped container(s); prune or restart intentionally if they matter.", stopped))
		}
	}
	if len(recs) == 0 {
		add("Review sentinel alerts first; they are sorted by urgency.")
	}
	return recs
}

func shortText(payload Payload) string {
	parts := []string{
		fmt.Sprintf("%s score %d", payload.Health.Status, payload.Health.Score),
		fmt.Sprintf("CPU %.0f%%", payload.Resources.CPU.Percent),
		fmt.Sprintf("RAM %.0f%%", payload.Resources.Memory.Percent),
	}
	if len(payload.Resources.Disks) > 0 {
		worst := payload.Resources.Disks[0]
		for _, disk := range payload.Resources.Disks[1:] {
			if disk.Percent > worst.Percent {
				worst = disk
			}
		}
		parts = append(parts, fmt.Sprintf("disk %s %.0f%%", worst.Mountpoint, worst.Percent))
	}
	if payload.Docker.Available {
		parts = append(parts, fmt.Sprintf("docker %d/%d running", payload.Docker.Running, payload.Docker.Total))
	}
	if len(payload.Health.Alerts) > 0 {
		parts = append(parts, "top alert: "+payload.Health.Alerts[0].Message)
	}
	return strings.Join(parts, " · ")
}
