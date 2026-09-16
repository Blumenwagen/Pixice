package components

import (
	"fmt"
	"strings"

	"github.com/blumenwagen/durandal/internal/ops"
	"github.com/blumenwagen/durandal/internal/styles"
	"github.com/charmbracelet/lipgloss"
)

// Sentinel renders a compact, opinionated health triage panel for Lapis' own ops work.
type Sentinel struct {
	Width  int
	Height int
	Report ops.Report
}

func NewSentinel() Sentinel { return Sentinel{} }

func (s *Sentinel) Update(report ops.Report) {
	s.Report = report
}

func (s Sentinel) View() string {
	iw := s.Width - 2
	if iw < 10 {
		iw = 10
	}

	report := s.Report
	if report.Score == 0 && report.Status == "" && len(report.Alerts) == 0 {
		report = ops.Report{Score: 100, Status: ops.StatusClear, Alerts: []ops.Alert{{Severity: ops.SeverityInfo, Label: "OK", Message: "Awaiting telemetry"}}}
	}

	statusColor := sentinelStatusColor(report.Status)
	score := lipgloss.NewStyle().Foreground(statusColor).Bold(true).Render(fmt.Sprintf("%03d", report.Score))
	status := lipgloss.NewStyle().Foreground(styles.DeepBlack).Background(statusColor).Bold(true).Render(" " + string(report.Status) + " ")

	lines := []string{score + styles.Dim(" /100 ") + status + styles.Dim(" OPS READINESS")}
	lines = append(lines, styles.ThinRule(iw, styles.DimGrey))

	maxAlerts := s.Height - 4
	if maxAlerts < 1 {
		maxAlerts = 1
	}
	for i, alert := range report.Alerts {
		if i >= maxAlerts {
			remaining := len(report.Alerts) - i
			lines = append(lines, styles.Dim(fmt.Sprintf("+%d MORE SIGNALS", remaining)))
			break
		}
		badge := lipgloss.NewStyle().Foreground(sentinelSeverityColor(alert.Severity)).Bold(true).Render(alert.Label)
		message := alert.Message
		prefixW := lipgloss.Width(badge) + 3
		if iw-prefixW > 8 {
			message = truncatePlain(message, iw-prefixW)
		}
		lines = append(lines, badge+styles.Dim(" → ")+styles.Bright(message))
	}

	return styles.MagPanel("LAPIS SENTINEL", strings.Join(lines, "\n"), s.Width, s.Height, statusColor)
}

func sentinelStatusColor(status ops.Status) lipgloss.Color {
	switch status {
	case ops.StatusCritical:
		return styles.Red
	case ops.StatusWarning:
		return styles.Amber
	case ops.StatusWatch:
		return styles.Cyan
	default:
		return styles.NeonLime
	}
}

func sentinelSeverityColor(sev ops.Severity) lipgloss.Color {
	switch sev {
	case ops.SeverityCritical:
		return styles.Red
	case ops.SeverityWarning:
		return styles.Amber
	case ops.SeverityWatch:
		return styles.Cyan
	default:
		return styles.NeonLime
	}
}

func truncatePlain(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	if max <= 1 {
		return "…"
	}
	return s[:max-1] + "…"
}
