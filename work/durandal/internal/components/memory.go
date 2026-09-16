package components

import (
	"fmt"
	"strings"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/styles"
)

// Memory renders RAM, Swap, sensors, and battery.
type Memory struct {
	Width   int
	Height  int
	Info    metrics.MemInfo
	Sensors metrics.SensorInfo
}

func NewMemory() Memory { return Memory{} }

func (m *Memory) Update(info metrics.MemInfo, sensors metrics.SensorInfo) {
	m.Info = info
	m.Sensors = sensors
}

func (m Memory) View() string {
	iw := m.Width - 2
	if iw < 10 {
		iw = 10
	}

	var lines []string

	// RAM
	ramUsed := styles.FormatBytes(m.Info.UsedRAM)
	ramTotal := styles.FormatBytes(m.Info.TotalRAM)
	lines = append(lines, styles.Dim("RAM  ")+styles.Bright(ramUsed)+styles.Dim("/"+ramTotal))
	lines = append(lines, styles.Bar(m.Info.PercentRAM, iw, styles.Tertiary()))

	// Swap
	swapUsed := styles.FormatBytes(m.Info.UsedSwap)
	swapTotal := styles.FormatBytes(m.Info.TotalSwap)
	lines = append(lines, styles.Dim("SWAP ")+styles.Bright(swapUsed)+styles.Dim("/"+swapTotal))

	swapColor := styles.Tertiary()
	if m.Info.PercentSwap > 50 {
		swapColor = styles.Amber
	}
	lines = append(lines, styles.Bar(m.Info.PercentSwap, iw, swapColor))

	// Cache
	cache := fmt.Sprintf("CACHE %s  BUF %s", styles.FormatBytes(m.Info.Cached), styles.FormatBytes(m.Info.Buffers))
	lines = append(lines, styles.Dim(cache))

	// Temperatures
	if len(m.Sensors.Temperatures) > 0 {
		lines = append(lines, styles.ThinRule(iw, styles.MutedGrey))
		maxT := 4
		remaining := m.Height - len(lines) - 3
		if remaining < maxT {
			maxT = remaining
		}
		if maxT < 1 {
			maxT = 1
		}
		for i, t := range m.Sensors.Temperatures {
			if i >= maxT {
				break
			}
			label := t.Label
			if len(label) > 12 {
				label = label[:9] + "..."
			}
			tempStr := fmt.Sprintf("%.0f°C", t.Temperature)
			if t.Temperature > 80 {
				tempStr = styles.Crit(tempStr)
			} else if t.Temperature > 60 {
				tempStr = styles.Warn(tempStr)
			} else {
				tempStr = styles.Accent(tempStr)
			}
			lines = append(lines, styles.Dim(styles.Pad(label, 13))+tempStr)
		}
	}

	// Battery
	if m.Sensors.Battery != nil {
		bat := m.Sensors.Battery
		icon := "⚡"
		if !bat.IsCharging {
			icon = "🔋"
		}
		pctStr := fmt.Sprintf("%.0f%%", bat.Percent)
		if bat.Percent < 20 {
			pctStr = styles.Crit(pctStr)
		} else {
			pctStr = styles.Accent(pctStr)
		}
		lines = append(lines, styles.Dim("BAT ")+icon+" "+pctStr)
	}

	return styles.MagPanel("MEMORY", strings.Join(lines, "\n"), m.Width, m.Height, styles.Cyan)
}
