package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"

	"github.com/blumenwagen/durandal/internal/agent"
	"github.com/blumenwagen/durandal/internal/metrics"
)

func TestRunAgentJSONDoesNotStartTUI(t *testing.T) {
	var out bytes.Buffer
	runTUI := func() error {
		t.Fatal("agent command must not start Bubble Tea TUI")
		return nil
	}
	collect := func() (metrics.Snapshot, error) {
		return metrics.Snapshot{
			Host:   metrics.HostInfo{Hostname: "box"},
			CPU:    metrics.CPUInfo{TotalPercent: 11},
			Memory: metrics.MemInfo{PercentRAM: 22},
			Disks:  []metrics.DiskInfo{{Mountpoint: "/", UsedPercent: 33}},
			Processes: []metrics.ProcessInfo{
				{PID: 1, Name: "one"},
				{PID: 2, Name: "two"},
			},
		}, nil
	}

	code := Run([]string{"agent", "--json", "--pretty", "--top", "1"}, &out, nil, collect, runTUI)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if !bytes.Contains(out.Bytes(), []byte("\n  \"schema\"")) {
		t.Fatalf("expected pretty JSON, got %s", out.String())
	}
	var payload agent.Payload
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatalf("output is not agent payload JSON: %v\n%s", err, out.String())
	}
	if payload.Schema != agent.Schema || len(payload.TopProcesses) != 1 {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}

func TestRunCheckReturnsThresholdExitCode(t *testing.T) {
	var out bytes.Buffer
	collect := func() (metrics.Snapshot, error) {
		return metrics.Snapshot{
			CPU:    metrics.CPUInfo{TotalPercent: 94},
			Memory: metrics.MemInfo{PercentRAM: 91},
		}, nil
	}

	code := Run([]string{"check", "--fail-on", "warn"}, &out, nil, collect, func() error { return nil })
	if code != 2 {
		t.Fatalf("expected warn threshold exit code 2, got %d; output=%s", code, out.String())
	}
	if !bytes.Contains(out.Bytes(), []byte("WARN")) {
		t.Fatalf("expected human check output to include status, got %s", out.String())
	}
}

func TestRunDefaultStartsTUI(t *testing.T) {
	started := false
	code := Run(nil, nil, nil, nil, func() error {
		started = true
		return nil
	})
	if code != 0 || !started {
		t.Fatalf("default command should start TUI, code=%d started=%v", code, started)
	}
}

func TestRunReportsCollectionErrors(t *testing.T) {
	var errOut bytes.Buffer
	code := Run([]string{"agent", "--json"}, nil, &errOut, func() (metrics.Snapshot, error) {
		return metrics.Snapshot{}, errors.New("boom")
	}, func() error { return nil })
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !bytes.Contains(errOut.Bytes(), []byte("boom")) {
		t.Fatalf("expected error in stderr, got %q", errOut.String())
	}
}
