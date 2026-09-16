package agent

import (
	"strings"
	"testing"
	"time"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/ops"
)

func TestBuildReportCreatesCompactAgentPayload(t *testing.T) {
	snap := metrics.Snapshot{
		Host: metrics.HostInfo{Hostname: "durandal-box", OS: "linux", Uptime: "3h 4m"},
		CPU:  metrics.CPUInfo{TotalPercent: 12.4, ModelName: "Ryzen", Cores: 8, Threads: 16},
		Memory: metrics.MemInfo{
			TotalRAM: 1000, UsedRAM: 410, PercentRAM: 41,
			TotalSwap: 200, UsedSwap: 10, PercentSwap: 5,
		},
		Network: metrics.NetworkInfo{BytesRecvRate: 2048, BytesSentRate: 1024},
		Disks: []metrics.DiskInfo{
			{Mountpoint: "/", Total: 1000, Used: 520, UsedPercent: 52},
			{Mountpoint: "/data", Total: 2000, Used: 1800, UsedPercent: 90},
		},
		Processes: []metrics.ProcessInfo{
			{PID: 7, Name: "worker", CPU: 3, Memory: 1.2, Command: "worker --serve"},
			{PID: 8, Name: "agent", CPU: 2, Memory: 0.9, Command: "agent"},
		},
		Docker: metrics.DockerInfo{Available: true, Containers: []metrics.ContainerInfo{
			{Name: "web", Image: "nginx", State: "running", Running: true},
			{Name: "db", Image: "postgres", State: "exited", Running: false},
		}},
	}
	report := ops.EvaluateSnapshot(snap)

	payload := BuildReport(snap, report, Options{TopProcesses: 1, GeneratedAt: time.Unix(42, 0).UTC()})

	if payload.Schema != "durandal.agent.v1" {
		t.Fatalf("unexpected schema %q", payload.Schema)
	}
	if payload.GeneratedAt != "1970-01-01T00:00:42Z" {
		t.Fatalf("unexpected generated_at %q", payload.GeneratedAt)
	}
	if payload.Host.Hostname != "durandal-box" || payload.Host.Uptime != "3h 4m" {
		t.Fatalf("host identity not preserved: %#v", payload.Host)
	}
	if payload.Health.Score != report.Score || payload.Health.Status != string(report.Status) {
		t.Fatalf("health did not mirror sentinel report: %#v vs %#v", payload.Health, report)
	}
	if payload.Resources.CPU.Percent != 12.4 || payload.Resources.Memory.Percent != 41 || payload.Resources.Disks[1].Mountpoint != "/data" {
		t.Fatalf("resource summary lost metrics: %#v", payload.Resources)
	}
	if payload.Docker.Total != 2 || payload.Docker.Running != 1 || payload.Docker.Stopped != 1 {
		t.Fatalf("docker counts wrong: %#v", payload.Docker)
	}
	if len(payload.TopProcesses) != 1 || payload.TopProcesses[0].Name != "worker" {
		t.Fatalf("top process limit not applied: %#v", payload.TopProcesses)
	}
	if len(payload.Health.Recommendations) == 0 || !strings.Contains(strings.Join(payload.Health.Recommendations, "\n"), "/data") {
		t.Fatalf("expected actionable disk recommendation, got %#v", payload.Health.Recommendations)
	}
}

func TestMarshalReportHonorsPrettyFlag(t *testing.T) {
	payload := Payload{Schema: "durandal.agent.v1", GeneratedAt: "now"}

	compact, err := MarshalReport(payload, false)
	if err != nil {
		t.Fatalf("compact marshal failed: %v", err)
	}
	if strings.Contains(string(compact), "\n") {
		t.Fatalf("compact JSON should be one line: %q", compact)
	}

	pretty, err := MarshalReport(payload, true)
	if err != nil {
		t.Fatalf("pretty marshal failed: %v", err)
	}
	if !strings.Contains(string(pretty), "\n  ") {
		t.Fatalf("pretty JSON should be indented: %q", pretty)
	}
}
