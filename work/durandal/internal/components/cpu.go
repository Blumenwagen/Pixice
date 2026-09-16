package components

import (
	"fmt"
	"strings"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/styles"
	"github.com/charmbracelet/lipgloss"
)

// CPU renders a CPU panel with sparkline and per-core mini bars.
type CPU struct {
	Width   int
	Height  int
	Info    metrics.CPUInfo
	History []float64
}

const maxCPUHistory = 120

func NewCPU() CPU {
	return CPU{History: make([]float64, 0, maxCPUHistory)}
}

func (c *CPU) Update(info metrics.CPUInfo) {
	c.Info = info
	c.History = append(c.History, info.TotalPercent)
	if len(c.History) > maxCPUHistory {
		c.History = c.History[1:]
	}
}

func (c CPU) View() string {
	iw := c.Width - 2
	if iw < 10 {
		iw = 10
	}

	var lines []string

	// Big bold percentage
	pctStr := lipgloss.NewStyle().
		Foreground(styles.UsageColor(c.Info.TotalPercent)).
		Bold(true).
		Render(fmt.Sprintf("%.1f%%", c.Info.TotalPercent))

	totalLine := pctStr
	if c.Info.Threads > 0 {
		totalLine += styles.Dim(fmt.Sprintf("  %d THREADS", c.Info.Threads))
	}
	lines = append(lines, totalLine)

	coreCount := len(c.Info.PerCore)
	if coreCount == 0 {
		lines = append(lines, styles.Sparkline(c.History, iw, styles.Primary()))
		return styles.MagPanel("CPU", strings.Join(lines, "\n"), c.Width, c.Height, styles.NeonLime)
	}

	maxCoreRows := (coreCount + 1) / 2
	if maxCoreRows > c.Height/3 {
		maxCoreRows = c.Height / 3
	}
	if maxCoreRows < 1 {
		maxCoreRows = 1
	}

	sparkH := (c.Height - 2) - 1 - maxCoreRows
	if sparkH < 1 {
		sparkH = 1
	}

	// Sparkline
	lines = append(lines, strings.Split(styles.MultiSparkline(c.History, iw, sparkH, styles.Primary()), "\n")...)

	// Per-core compact bars — 2 columns if we have space
	maxRows := maxCoreRows

	colW := (iw - 1) / 2
	if colW < 15 || coreCount <= maxRows {
		barW := iw - 9
		for i := 0; i < coreCount && i < maxRows; i++ {
			pct := c.Info.PerCore[i]
			label := styles.Dim(fmt.Sprintf("C%-2d", i))
			bar := styles.Bar(pct, barW, styles.UsageColor(pct))
			lines = append(lines, label+" "+bar)
		}
		if coreCount > maxRows {
			lines = append(lines, styles.Dim(fmt.Sprintf("  +%d MORE", coreCount-maxRows)))
		}
	} else {
		barW := colW - 5
		perCol := (coreCount + 1) / 2
		if perCol > maxRows {
			perCol = maxRows
		}
		for row := 0; row < perCol; row++ {
			leftIdx := row
			rightIdx := row + perCol

			left := ""
			if leftIdx < coreCount {
				pct := c.Info.PerCore[leftIdx]
				left = styles.Dim(fmt.Sprintf("C%-2d", leftIdx)) + " " + styles.Bar(pct, barW, styles.UsageColor(pct))
			}
			left = styles.Pad(left, colW)

			right := ""
			if rightIdx < coreCount {
				pct := c.Info.PerCore[rightIdx]
				right = styles.Dim(fmt.Sprintf("C%-2d", rightIdx)) + " " + styles.Bar(pct, barW, styles.UsageColor(pct))
			}

			lines = append(lines, left+" "+right)
		}
	}

	return styles.MagPanel("CPU", strings.Join(lines, "\n"), c.Width, c.Height, styles.NeonLime)
}
