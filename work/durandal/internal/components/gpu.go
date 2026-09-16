package components

import (
	"fmt"
	"strings"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/styles"
)

// GPU displays information about graphic cards.
type GPU struct {
	Width  int
	Height int
	GPUs   []metrics.GPUInfo
}

func NewGPU() GPU {
	return GPU{}
}

func (g *GPU) Update(gpus []metrics.GPUInfo) {
	g.GPUs = gpus
}

func (g GPU) View() string {
	if len(g.GPUs) == 0 {
		return ""
	}

	iw := g.Width - 2
	if iw < 10 {
		iw = 10
	}

	var lines []string

	for i, gpu := range g.GPUs {
		name := gpu.Name
		if len(name) > iw {
			name = name[:iw]
		}
		lines = append(lines, styles.Dim("GPU ")+fmt.Sprintf("%d: ", i)+styles.Bright(name))

		lines = append(lines, styles.Dim("UTIL: ")+styles.Accent(fmt.Sprintf("%3.0f%%", gpu.Utilization))+styles.Dim(fmt.Sprintf("  TEMP: %.0f°C", gpu.Temperature)))

		pct := 0.0
		if gpu.MemoryTotal > 0 {
			pct = float64(gpu.MemoryUsed) / float64(gpu.MemoryTotal) * 100.0
		}

		memStr := fmt.Sprintf("%dM/%dM", gpu.MemoryUsed, gpu.MemoryTotal)
		barW := iw - len(memStr) - 1
		if barW < 5 {
			barW = 5
		}

		lines = append(lines, styles.Bar(pct, barW, styles.Tertiary())+" "+styles.Dim(memStr))

		if i < len(g.GPUs)-1 {
			lines = append(lines, "")
		}
	}

	return styles.MagPanel("GPU", strings.Join(lines, "\n"), g.Width, g.Height, styles.NeonLime)
}
