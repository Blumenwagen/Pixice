package styles

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var IsRoot = false

func init() {
	if os.Geteuid() == 0 {
		IsRoot = true
	}
}

// ── Marathon Brutalist Color Palette ────────────────────────────────────────

var (
	NeonLime  = lipgloss.Color("#BFFF00")
	HotPink   = lipgloss.Color("#FF007F")
	Cyan      = lipgloss.Color("#00F0FF")
	DeepBlack = lipgloss.Color("#0A0A0A")
	DarkNavy  = lipgloss.Color("#12121F")
	Charcoal  = lipgloss.Color("#1A1A2E")
	MutedGrey = lipgloss.Color("#8A8A9E")
	DimGrey   = lipgloss.Color("#4A4A5A")
	OffWhite  = lipgloss.Color("#D8D8E8")
	BrightWht = lipgloss.Color("#FFFFFF")
	Amber     = lipgloss.Color("#FFB800")
	Red       = lipgloss.Color("#FF2244")
	DimCyan   = lipgloss.Color("#053333")
	DimLime   = lipgloss.Color("#1A2A00")
	DimPink   = lipgloss.Color("#2A0015")
)

var (
	DimmedLime = lipgloss.Color("#6F8F00")
	DimmedPink = lipgloss.Color("#8F003F")
	DimmedCyan = lipgloss.Color("#007F8F")

	RootLime = lipgloss.Color("#FF3300")
	RootPink = lipgloss.Color("#FF0033")
	RootCyan = lipgloss.Color("#FF8800")

	RootDimmedLime = lipgloss.Color("#8F1100")
	RootDimmedPink = lipgloss.Color("#8F0011")
	RootDimmedCyan = lipgloss.Color("#8F4400")
)

var Dimmed = false

func Primary() lipgloss.Color {
	if IsRoot {
		if Dimmed {
			return RootDimmedLime
		}
		return RootLime
	}
	if Dimmed {
		return DimmedLime
	}
	return NeonLime
}

func Secondary() lipgloss.Color {
	if IsRoot {
		if Dimmed {
			return RootDimmedPink
		}
		return RootPink
	}
	if Dimmed {
		return DimmedPink
	}
	return HotPink
}

func Tertiary() lipgloss.Color {
	if IsRoot {
		if Dimmed {
			return RootDimmedCyan
		}
		return RootCyan
	}
	if Dimmed {
		return DimmedCyan
	}
	return Cyan
}

// ── Brutalist Panel System ──────────────────────────────────────────────────
//
// Replaces TechPanel with a bolder, magazine-inspired brutalist layout:
//   ████████████████████████████████
//   █  S E C T I O N   N A M E   █   ← bold reversed header block
//   ████████████████████████████████
//   ▎ content line 1                  ← thin left accent stripe
//   ▎ content line 2
//   ▎ content line 3
//   ─────────────────────────────     ← thin bottom rule

func MagPanel(title string, content string, width, height int, accent lipgloss.Color) string {
	innerW := width
	if innerW < 1 {
		innerW = 1
	}
	innerH := height - 2 // header thick bar (1 line) + bottom rule (1 line)
	if innerH < 1 {
		innerH = 1
	}

	// ── Thick header bar ──
	headerBar := SectionHeader(title, innerW, accent)

	// ── Content with left accent stripe ──
	contentLines := strings.Split(content, "\n")
	stripe := lipgloss.NewStyle().Foreground(accent).Render("▎")

	var body strings.Builder
	for i := 0; i < innerH; i++ {
		line := ""
		if i < len(contentLines) {
			line = contentLines[i]
		}

		paddedLine := " " + line
		lineW := lipgloss.Width(paddedLine)

		if lineW > innerW-2 {
			paddedLine = truncateToWidth(paddedLine, innerW-2)
		} else if lineW < innerW-1 {
			paddedLine = paddedLine + strings.Repeat(" ", innerW-1-lineW)
		}

		body.WriteString(stripe + paddedLine + "\n")
	}

	// ── Bottom rule ──
	bottomRule := lipgloss.NewStyle().Foreground(DimGrey).Render(strings.Repeat("─", innerW))

	return headerBar + "\n" + body.String() + bottomRule
}

// SectionHeader renders a full-width bold header with reversed label and accent fill.
//
//	▌ S E C T I O N ▐▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
func SectionHeader(label string, width int, accent lipgloss.Color) string {
	tracked := TextTracking(strings.ToUpper(label))

	// Reversed label portion
	labelPart := lipgloss.NewStyle().
		Foreground(DeepBlack).
		Background(accent).
		Bold(true).
		Render(" " + tracked + " ")

	labelW := lipgloss.Width(labelPart)

	// Accent-colored fill rule
	fillCount := width - labelW
	if fillCount < 0 {
		fillCount = 0
	}
	fillPart := lipgloss.NewStyle().
		Foreground(accent).
		Render(strings.Repeat("▀", fillCount))

	return labelPart + fillPart
}

// ThickBar renders a solid block accent bar (purely decorative).
func ThickBar(width int, color lipgloss.Color) string {
	return lipgloss.NewStyle().Foreground(color).Render(strings.Repeat("█", width))
}

// ThinRule renders a subtle horizontal divider.
func ThinRule(width int, color lipgloss.Color) string {
	return lipgloss.NewStyle().Foreground(color).Render(strings.Repeat("─", width))
}

// KeyVal renders an aligned key-value pair: dimmed label, bright value.
func KeyVal(key, val string, keyW int) string {
	k := Dim(Pad(strings.ToUpper(key), keyW))
	return k + " " + Bright(val)
}

func TextTracking(s string) string {
	res := ""
	for i, c := range s {
		res += string(c)
		if i < len(s)-1 {
			res += " "
		}
	}
	return res
}

// ── Bar Rendering ───────────────────────────────────────────────────────────

func Bar(percent float64, width int, fg lipgloss.Color) string {
	if width < 6 {
		return fmt.Sprintf("%3.0f%%", percent)
	}

	barW := width - 5
	if barW < 1 {
		barW = 1
	}

	filled := int(percent / 100.0 * float64(barW))
	if filled > barW {
		filled = barW
	}
	if filled < 0 {
		filled = 0
	}
	empty := barW - filled

	filledStr := strings.Repeat("█", filled)
	emptyStr := strings.Repeat("░", empty)

	bar := lipgloss.NewStyle().Foreground(fg).Render(filledStr) +
		lipgloss.NewStyle().Foreground(DimGrey).Render(emptyStr)

	pct := lipgloss.NewStyle().Foreground(OffWhite).Bold(true).Render(fmt.Sprintf(" %3.0f%%", percent))

	return bar + pct
}

func GradientBar(percent float64, width int) string {
	return Bar(percent, width, UsageColor(percent))
}

func UsageColor(pct float64) lipgloss.Color {
	switch {
	case pct >= 90:
		return Red
	case pct >= 70:
		return Amber
	case pct >= 40:
		return Primary()
	default:
		return Tertiary()
	}
}

// ── Sparkline ───────────────────────────────────────────────────────────────

var sparkChars = []rune{' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'}

func Sparkline(values []float64, width int, color lipgloss.Color) string {
	return MultiSparkline(values, width, 1, color)
}

func MultiSparkline(values []float64, width, height int, color lipgloss.Color) string {
	if width <= 0 || height <= 0 {
		return ""
	}

	start := 0
	if len(values) > width {
		start = len(values) - width
	}
	visible := values[start:]

	// Pad with zeros to fill width
	data := make([]float64, width)
	offset := width - len(visible)
	for i, v := range visible {
		data[offset+i] = v
	}

	var lines []string
	for r := height - 1; r >= 0; r-- {
		var sb strings.Builder
		rowBottom := float64(r) / float64(height) * 100.0
		rowTop := float64(r+1) / float64(height) * 100.0
		rowRange := rowTop - rowBottom

		for _, v := range data {
			if v > 100 {
				v = 100
			}
			if v >= rowTop {
				sb.WriteRune('█')
			} else if v <= rowBottom {
				sb.WriteRune(' ')
			} else {
				// Partial fill
				frac := (v - rowBottom) / rowRange
				idx := 1 + int(frac*float64(len(sparkChars)-2))
				if idx >= len(sparkChars) {
					idx = len(sparkChars) - 1
				}
				if idx < 0 {
					idx = 0
				}
				sb.WriteRune(sparkChars[idx])
			}
		}
		lines = append(lines, lipgloss.NewStyle().Foreground(color).Render(sb.String()))
	}

	return strings.Join(lines, "\n")
}

// ── Utility ─────────────────────────────────────────────────────────────────

func Dim(s string) string {
	return lipgloss.NewStyle().Foreground(MutedGrey).Render(s)
}

func Bright(s string) string {
	return lipgloss.NewStyle().Foreground(OffWhite).Bold(true).Render(s)
}

func Accent(s string) string {
	return lipgloss.NewStyle().Foreground(Primary()).Render(s)
}

func Warn(s string) string {
	return lipgloss.NewStyle().Foreground(Amber).Render(s)
}

func Crit(s string) string {
	return lipgloss.NewStyle().Foreground(Red).Bold(true).Render(s)
}

func Pink(s string) string {
	return lipgloss.NewStyle().Foreground(Secondary()).Render(s)
}

func Teal(s string) string {
	return lipgloss.NewStyle().Foreground(Tertiary()).Render(s)
}

func FormatBytes(bytes uint64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
		TB = GB * 1024
	)
	switch {
	case bytes >= TB:
		return fmt.Sprintf("%.1fT", float64(bytes)/float64(TB))
	case bytes >= GB:
		return fmt.Sprintf("%.1fG", float64(bytes)/float64(GB))
	case bytes >= MB:
		return fmt.Sprintf("%.1fM", float64(bytes)/float64(MB))
	case bytes >= KB:
		return fmt.Sprintf("%.1fK", float64(bytes)/float64(KB))
	default:
		return fmt.Sprintf("%dB", bytes)
	}
}

func FormatBytesRate(bytes uint64) string {
	return FormatBytes(bytes) + "/s"
}

func Pad(s string, width int) string {
	w := lipgloss.Width(s)
	if w >= width {
		return s
	}
	return s + strings.Repeat(" ", width-w)
}

func truncateToWidth(s string, maxW int) string {
	if maxW <= 0 {
		return ""
	}
	runes := []rune(s)
	for len(runes) > 0 && lipgloss.Width(string(runes)) > maxW {
		runes = runes[:len(runes)-1]
	}
	return string(runes)
}

// ── Legacy compatibility ────────────────────────────────────────────────────

// TechPanel is kept as an alias for MagPanel during migration.
func TechPanel(title string, content string, width, height int, accent lipgloss.Color) string {
	return MagPanel(title, content, width, height, accent)
}
