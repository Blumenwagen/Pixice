package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/blumenwagen/durandal/internal/agent"
	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/ops"
)

type Collector func() (metrics.Snapshot, error)
type TUIRunner func() error

func Run(args []string, stdout, stderr io.Writer, collect Collector, runTUI TUIRunner) int {
	if stdout == nil {
		stdout = io.Discard
	}
	if stderr == nil {
		stderr = io.Discard
	}
	if len(args) == 0 {
		if runTUI == nil {
			fmt.Fprintln(stderr, "durandal: TUI runner unavailable")
			return 1
		}
		if err := runTUI(); err != nil {
			fmt.Fprintf(stderr, "Error running Durandal: %v\n", err)
			return 1
		}
		return 0
	}

	switch args[0] {
	case "agent", "snapshot", "json":
		return runAgent(args[1:], stdout, stderr, collect)
	case "check":
		return runCheck(args[1:], stdout, stderr, collect)
	case "help", "--help", "-h":
		printHelp(stdout)
		return 0
	default:
		fmt.Fprintf(stderr, "durandal: unknown command %q\n\n", args[0])
		printHelp(stderr)
		return 1
	}
}

func runAgent(args []string, stdout, stderr io.Writer, collect Collector) int {
	fs := flag.NewFlagSet("agent", flag.ContinueOnError)
	fs.SetOutput(stderr)
	pretty := fs.Bool("pretty", false, "pretty-print JSON")
	jsonOut := fs.Bool("json", true, "emit JSON (default true)")
	top := fs.Int("top", 8, "number of top processes to include")
	if err := fs.Parse(args); err != nil {
		return 1
	}
	if !*jsonOut {
		fmt.Fprintln(stderr, "durandal agent currently emits JSON only")
		return 1
	}
	if collect == nil {
		fmt.Fprintln(stderr, "durandal: collector unavailable")
		return 1
	}
	snap, err := collect()
	if err != nil {
		fmt.Fprintf(stderr, "durandal: collect snapshot: %v\n", err)
		return 1
	}
	report := agent.BuildReport(snap, ops.EvaluateSnapshot(snap), agent.Options{TopProcesses: *top})
	data, err := agent.MarshalReport(report, *pretty)
	if err != nil {
		fmt.Fprintf(stderr, "durandal: marshal report: %v\n", err)
		return 1
	}
	stdout.Write(data)
	stdout.Write([]byte("\n"))
	return 0
}

func runCheck(args []string, stdout, stderr io.Writer, collect Collector) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	failOn := fs.String("fail-on", "crit", "exit non-zero at status: watch, warn, crit")
	jsonOut := fs.Bool("json", false, "emit full agent JSON instead of human summary")
	top := fs.Int("top", 5, "number of top processes in JSON output")
	if err := fs.Parse(args); err != nil {
		return 1
	}
	if collect == nil {
		fmt.Fprintln(stderr, "durandal: collector unavailable")
		return 1
	}
	snap, err := collect()
	if err != nil {
		fmt.Fprintf(stderr, "durandal: collect snapshot: %v\n", err)
		return 1
	}
	report := ops.EvaluateSnapshot(snap)
	payload := agent.BuildReport(snap, report, agent.Options{TopProcesses: *top})
	if *jsonOut {
		data, err := json.Marshal(payload)
		if err != nil {
			fmt.Fprintf(stderr, "durandal: marshal report: %v\n", err)
			return 1
		}
		stdout.Write(data)
		stdout.Write([]byte("\n"))
	} else {
		fmt.Fprintf(stdout, "%s\n", payload.AgentShortText)
		for _, rec := range payload.Health.Recommendations {
			fmt.Fprintf(stdout, "- %s\n", rec)
		}
	}
	if statusAtOrAbove(report.Status, *failOn) {
		return exitCodeFor(report.Status)
	}
	return 0
}

func statusAtOrAbove(status ops.Status, threshold string) bool {
	return statusRank(status) >= thresholdRank(threshold)
}

func statusRank(status ops.Status) int {
	switch status {
	case ops.StatusCritical:
		return 3
	case ops.StatusWarning:
		return 2
	case ops.StatusWatch:
		return 1
	default:
		return 0
	}
}

func thresholdRank(threshold string) int {
	switch strings.ToLower(threshold) {
	case "watch", "1":
		return 1
	case "warn", "warning", "2":
		return 2
	case "crit", "critical", "3":
		return 3
	default:
		return 3
	}
}

func exitCodeFor(status ops.Status) int {
	switch status {
	case ops.StatusCritical:
		return 3
	case ops.StatusWarning:
		return 2
	case ops.StatusWatch:
		return 1
	default:
		return 0
	}
}

func printHelp(w io.Writer) {
	fmt.Fprintln(w, `Durandal - visual system monitor plus agent-readable ops snapshots

Usage:
  durandal                         Start the interactive TUI
  durandal agent [--json] [--pretty] [--top N]
                                   Emit a compact JSON payload for scripts/agents
  durandal snapshot [--pretty]     Alias for agent
  durandal check [--fail-on warn] [--json]
                                   Print health summary; exit non-zero at threshold

Exit codes for check: 0 clear/below threshold, 1 WATCH, 2 WARN, 3 CRIT.`)
}
