//go:build darwin

package metrics

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// collectProcessesDarwin reads the process table with one ps invocation.
// Calling gopsutil's Status method for every process launches one ps command
// per PID on macOS, which made a single snapshot take longer than two seconds.
func collectProcessesDarwin(limit int) []ProcessInfo {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ps", "-axo", "pid=,pcpu=,pmem=,rss=,user=,state=,comm=")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	out, err := cmd.Output()
	if err != nil || ctx.Err() != nil {
		return nil
	}

	return parseDarwinProcesses(out, limit)
}

func parseDarwinProcesses(out []byte, limit int) []ProcessInfo {
	lines := strings.Split(string(out), "\n")
	result := make([]ProcessInfo, 0, len(lines))

	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}

		pid, err := strconv.ParseInt(fields[0], 10, 32)
		if err != nil {
			continue
		}
		cpuPct, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			continue
		}
		memPct, err := strconv.ParseFloat(fields[2], 32)
		if err != nil {
			continue
		}
		rssKB, err := strconv.ParseUint(fields[3], 10, 64)
		if err != nil {
			continue
		}

		command := strings.Join(fields[6:], " ")
		name := filepath.Base(command)
		if name == "." || name == string(filepath.Separator) || name == "" {
			name = command
		}

		displayCommand := command
		if len(displayCommand) > 40 {
			displayCommand = displayCommand[:37] + "..."
		}

		result = append(result, ProcessInfo{
			PID:     int32(pid),
			Name:    name,
			CPU:     cpuPct,
			Memory:  float32(memPct),
			MemRSS:  rssKB * 1024,
			Status:  darwinProcessStatus(fields[5]),
			User:    fields[4],
			Command: displayCommand,
		})
	}

	sort.SliceStable(result, func(i, j int) bool {
		if result[i].CPU == result[j].CPU {
			return result[i].PID < result[j].PID
		}
		return result[i].CPU > result[j].CPU
	})
	if limit >= 0 && len(result) > limit {
		result = result[:limit]
	}

	return result
}

func darwinProcessStatus(state string) string {
	if state == "" {
		return ""
	}

	switch state[0] {
	case 'R':
		return "running"
	case 'S':
		return "sleep"
	case 'I':
		return "idle"
	case 'T':
		return "stop"
	case 'U', 'D':
		return "blocked"
	case 'W':
		return "wait"
	case 'Z':
		return "zombie"
	default:
		return strings.ToLower(state)
	}
}
