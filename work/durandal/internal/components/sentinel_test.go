package components

import (
	"strings"
	"testing"

	"github.com/blumenwagen/durandal/internal/ops"
)

func TestSentinelViewShowsScoreStatusAndAlerts(t *testing.T) {
	s := NewSentinel()
	s.Width = 64
	s.Height = 7
	s.Update(ops.Report{
		Score:  42,
		Status: ops.StatusCritical,
		Alerts: []ops.Alert{
			{Severity: ops.SeverityCritical, Label: "DISK", Message: "Disk / almost full at 96%"},
			{Severity: ops.SeverityWarning, Label: "RAM", Message: "RAM pressure at 82%"},
		},
	})

	view := s.View()
	for _, want := range []string{"L A P I S", "42", "CRIT", "Disk / almost full", "RAM pressure"} {
		if !strings.Contains(view, want) {
			t.Fatalf("expected sentinel view to contain %q; got %q", want, view)
		}
	}
}
