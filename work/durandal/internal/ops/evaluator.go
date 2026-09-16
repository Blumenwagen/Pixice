package ops

import (
	"fmt"
	"sort"

	"github.com/blumenwagen/durandal/internal/metrics"
)

const MaxAlerts = 7

type Status string

const (
	StatusClear    Status = "CLEAR"
	StatusWatch    Status = "WATCH"
	StatusWarning  Status = "WARN"
	StatusCritical Status = "CRIT"
)

type Severity int

const (
	SeverityInfo Severity = iota
	SeverityWatch
	SeverityWarning
	SeverityCritical
)

type Alert struct {
	Severity Severity
	Label    string
	Message  string
}

type Report struct {
	Score  int
	Status Status
	Alerts []Alert
}

func EvaluateSnapshot(snap metrics.Snapshot) Report {
	alerts := make([]Alert, 0, MaxAlerts+4)
	score := 100

	add := func(sev Severity, penalty int, label, message string) {
		alerts = append(alerts, Alert{Severity: sev, Label: label, Message: message})
		score -= penalty
	}

	if snap.CPU.TotalPercent >= 90 {
		add(SeverityCritical, 22, "CPU", fmt.Sprintf("CPU saturated at %.0f%%", snap.CPU.TotalPercent))
	} else if snap.CPU.TotalPercent >= 75 {
		add(SeverityWarning, 12, "CPU", fmt.Sprintf("CPU pressure at %.0f%%", snap.CPU.TotalPercent))
	} else if snap.CPU.TotalPercent >= 60 {
		add(SeverityWatch, 6, "CPU", fmt.Sprintf("CPU warming at %.0f%%", snap.CPU.TotalPercent))
	}

	if snap.Memory.PercentRAM >= 90 {
		add(SeverityCritical, 20, "RAM", fmt.Sprintf("RAM tight at %.0f%%", snap.Memory.PercentRAM))
	} else if snap.Memory.PercentRAM >= 78 {
		add(SeverityWarning, 11, "RAM", fmt.Sprintf("RAM pressure at %.0f%%", snap.Memory.PercentRAM))
	} else if snap.Memory.PercentRAM >= 65 {
		add(SeverityWatch, 5, "RAM", fmt.Sprintf("RAM watch at %.0f%%", snap.Memory.PercentRAM))
	}

	if snap.Memory.PercentSwap >= 50 {
		add(SeverityCritical, 18, "SWAP", fmt.Sprintf("Swap heavy at %.0f%%", snap.Memory.PercentSwap))
	} else if snap.Memory.PercentSwap >= 20 {
		add(SeverityWarning, 9, "SWAP", fmt.Sprintf("Swap in use at %.0f%%", snap.Memory.PercentSwap))
	} else if snap.Memory.PercentSwap >= 5 {
		add(SeverityWatch, 3, "SWAP", fmt.Sprintf("Swap trace at %.0f%%", snap.Memory.PercentSwap))
	}

	for _, disk := range snap.Disks {
		if disk.UsedPercent >= 95 {
			add(SeverityCritical, 20, "DISK", fmt.Sprintf("Disk %s almost full at %.0f%%", disk.Mountpoint, disk.UsedPercent))
		} else if disk.UsedPercent >= 85 {
			add(SeverityWarning, 12, "DISK", fmt.Sprintf("Disk %s high at %.0f%%", disk.Mountpoint, disk.UsedPercent))
		} else if disk.UsedPercent >= 75 {
			add(SeverityWatch, 6, "DISK", fmt.Sprintf("Disk %s watch at %.0f%%", disk.Mountpoint, disk.UsedPercent))
		}
	}

	combinedNetwork := snap.Network.BytesRecvRate + snap.Network.BytesSentRate
	if combinedNetwork >= 200*1024*1024 {
		add(SeverityCritical, 14, "NET", fmt.Sprintf("Network flood %.0f MiB/s", float64(combinedNetwork)/1024/1024))
	} else if combinedNetwork >= 80*1024*1024 {
		add(SeverityWarning, 8, "NET", fmt.Sprintf("Network busy %.0f MiB/s", float64(combinedNetwork)/1024/1024))
	}

	for _, proc := range snap.Processes {
		if proc.CPU >= 120 || proc.Memory >= 30 {
			add(SeverityCritical, 14, "PROC", fmt.Sprintf("Process %s hot: %.0f%% CPU / %.0f%% MEM", proc.Name, proc.CPU, proc.Memory))
		} else if proc.CPU >= 70 || proc.Memory >= 18 {
			add(SeverityWarning, 8, "PROC", fmt.Sprintf("Process %s elevated: %.0f%% CPU / %.0f%% MEM", proc.Name, proc.CPU, proc.Memory))
		}
	}

	sort.SliceStable(alerts, func(i, j int) bool {
		if alerts[i].Severity == alerts[j].Severity {
			return alerts[i].Label < alerts[j].Label
		}
		return alerts[i].Severity > alerts[j].Severity
	})

	if len(alerts) > MaxAlerts {
		alerts = alerts[:MaxAlerts]
	}
	if len(alerts) == 0 {
		alerts = append(alerts, Alert{Severity: SeverityInfo, Label: "OK", Message: "Nominal — no pressure signatures"})
	}
	if score < 0 {
		score = 0
	}

	return Report{Score: score, Status: statusFor(score), Alerts: alerts}
}

func statusFor(score int) Status {
	switch {
	case score >= 90:
		return StatusClear
	case score >= 75:
		return StatusWatch
	case score >= 50:
		return StatusWarning
	default:
		return StatusCritical
	}
}
