//go:build darwin

package metrics

import "testing"

func TestParseDarwinProcessesSortsLimitsAndPreservesCommandSpaces(t *testing.T) {
	out := []byte(`
  42   1.5  0.2  1024 alice S    /Applications/Example App.app/Contents/MacOS/Example App
   7  88.4  1.0  4096 root  R+   /usr/local/bin/worker
  99   0.0  0.1   512 bob   Z    helper
malformed row
`)

	got := parseDarwinProcesses(out, 2)
	if len(got) != 2 {
		t.Fatalf("expected 2 processes, got %d", len(got))
	}
	if got[0].PID != 7 || got[0].CPU != 88.4 || got[0].Status != "running" {
		t.Fatalf("unexpected first process: %#v", got[0])
	}
	if got[0].MemRSS != 4096*1024 {
		t.Fatalf("RSS was not converted from KiB: %d", got[0].MemRSS)
	}
	if got[1].PID != 42 || got[1].Name != "Example App" {
		t.Fatalf("command with spaces was not preserved: %#v", got[1])
	}
}

func TestDarwinProcessStatus(t *testing.T) {
	tests := map[string]string{
		"R+": "running",
		"S":  "sleep",
		"I":  "idle",
		"U":  "blocked",
		"T":  "stop",
		"Z":  "zombie",
		"":   "",
	}

	for input, want := range tests {
		if got := darwinProcessStatus(input); got != want {
			t.Errorf("darwinProcessStatus(%q) = %q, want %q", input, got, want)
		}
	}
}
