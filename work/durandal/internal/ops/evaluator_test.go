package ops

import (
	"strings"
	"testing"

	"github.com/blumenwagen/durandal/internal/metrics"
)

func TestEvaluateSnapshotReportsHealthyState(t *testing.T) {
	snap := metrics.Snapshot{
		CPU:    metrics.CPUInfo{TotalPercent: 12},
		Memory: metrics.MemInfo{PercentRAM: 35, PercentSwap: 0},
		Disks:  []metrics.DiskInfo{{Mountpoint: "/", UsedPercent: 40}},
		Processes: []metrics.ProcessInfo{
			{PID: 100, Name: "durandal", CPU: 1.5, Memory: 0.8},
		},
	}

	report := EvaluateSnapshot(snap)

	if report.Score != 100 {
		t.Fatalf("expected perfect score, got %d", report.Score)
	}
	if report.Status != StatusClear {
		t.Fatalf("expected CLEAR status, got %q", report.Status)
	}
	if len(report.Alerts) != 1 || !strings.Contains(report.Alerts[0].Message, "Nominal") {
		t.Fatalf("expected nominal placeholder alert, got %#v", report.Alerts)
	}
}

func TestEvaluateSnapshotRanksResourceAlerts(t *testing.T) {
	snap := metrics.Snapshot{
		CPU:     metrics.CPUInfo{TotalPercent: 94},
		Memory:  metrics.MemInfo{PercentRAM: 91, PercentSwap: 62},
		Network: metrics.NetworkInfo{BytesRecvRate: 160 * 1024 * 1024, BytesSentRate: 90 * 1024 * 1024},
		Disks: []metrics.DiskInfo{
			{Mountpoint: "/", UsedPercent: 96},
			{Mountpoint: "/data", UsedPercent: 81},
		},
		Processes: []metrics.ProcessInfo{
			{PID: 42, Name: "render-worker", CPU: 141, Memory: 36},
			{PID: 7, Name: "indexer", CPU: 72, Memory: 7},
		},
	}

	report := EvaluateSnapshot(snap)

	if report.Status != StatusCritical {
		t.Fatalf("expected CRITICAL status, got %q", report.Status)
	}
	if report.Score >= 50 {
		t.Fatalf("expected low score for critical host, got %d", report.Score)
	}
	if len(report.Alerts) < 5 {
		t.Fatalf("expected multiple alerts, got %#v", report.Alerts)
	}
	if report.Alerts[0].Severity != SeverityCritical {
		t.Fatalf("expected most severe alert first, got %#v", report.Alerts[0])
	}
	joined := joinAlertMessages(report.Alerts)
	for _, want := range []string{"Disk /", "RAM", "Swap", "CPU", "render-worker", "Network"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("expected alert summary to contain %q; got %q", want, joined)
		}
	}
}

func TestEvaluateSnapshotLimitsAlertCount(t *testing.T) {
	snap := metrics.Snapshot{
		CPU:    metrics.CPUInfo{TotalPercent: 99},
		Memory: metrics.MemInfo{PercentRAM: 99, PercentSwap: 99},
		Disks: []metrics.DiskInfo{
			{Mountpoint: "/", UsedPercent: 99},
			{Mountpoint: "/var", UsedPercent: 99},
			{Mountpoint: "/home", UsedPercent: 99},
			{Mountpoint: "/tmp", UsedPercent: 99},
		},
		Processes: []metrics.ProcessInfo{
			{PID: 1, Name: "a", CPU: 200, Memory: 80},
			{PID: 2, Name: "b", CPU: 190, Memory: 70},
			{PID: 3, Name: "c", CPU: 180, Memory: 60},
		},
	}

	report := EvaluateSnapshot(snap)
	if len(report.Alerts) != MaxAlerts {
		t.Fatalf("expected exactly %d alerts, got %d: %#v", MaxAlerts, len(report.Alerts), report.Alerts)
	}
}

func joinAlertMessages(alerts []Alert) string {
	parts := make([]string, 0, len(alerts))
	for _, a := range alerts {
		parts = append(parts, a.Message)
	}
	return strings.Join(parts, "\n")
}
