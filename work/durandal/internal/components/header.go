package components

import (
	"strings"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/styles"
	"github.com/charmbracelet/lipgloss"
)

// Header renders the top masthead — bold brutalist banner.
type Header struct {
	Width int
	Host  metrics.HostInfo
}

func NewHeader() Header { return Header{} }

func (h *Header) Update(host metrics.HostInfo) {
	h.Host = host
}

func (h Header) View() string {
	if h.Width <= 0 {
		return ""
	}

	// ══════════════════════════════════════════════════════════════════
	//  █ DURANDAL ██████████████████████████  user@host // uptime: 5m
	// ══════════════════════════════════════════════════════════════════

	// Left: Bold app name in reversed block
	appName := " █ DURANDAL "
	nameBlock := lipgloss.NewStyle().
		Background(styles.Primary()).
		Foreground(styles.DeepBlack).
		Bold(true).
		Render(appName)

	tagline := lipgloss.NewStyle().
		Foreground(styles.MutedGrey).
		Render(" SYSTEMS MONITOR")

	// Right: System info
	username := h.Host.User
	if username == "" {
		username = "system"
	}

	var infoParts []string
	infoParts = append(infoParts, lipgloss.NewStyle().Foreground(styles.Primary()).Bold(true).Render(username))
	if h.Host.Hostname != "" {
		infoParts = append(infoParts, lipgloss.NewStyle().Foreground(styles.MutedGrey).Render("@")+
			styles.Bright(h.Host.Hostname))
	}

	right := strings.Join(infoParts, "")
	if h.Host.Uptime != "" {
		right += lipgloss.NewStyle().Foreground(styles.MutedGrey).Render("  //  ") +
			lipgloss.NewStyle().Foreground(styles.Tertiary()).Render(h.Host.Uptime)
	}

	left := nameBlock + tagline
	leftW := lipgloss.Width(left)
	rightW := lipgloss.Width(right)

	fillAmt := h.Width - leftW - rightW - 1
	if fillAmt < 0 {
		fillAmt = 0
	}

	barText := left + strings.Repeat(" ", fillAmt) + right + " "
	return lipgloss.NewStyle().Background(styles.DarkNavy).Render(barText)
}

// HelpBar renders the bottom keybinding reference bar — brutalist pill badges.
func HelpBar(w int, dimmed bool) string {
	keys := []struct{ key, desc string }{
		{"↑/k", "UP"},
		{"↓/j", "DN"},
		{"s", "SORT"},
		{"/", "FIND"},
		{"⏎", "INSPECT"},
		{"K", "KILL"},
		{"c", "DOCKER"},
		{"x", "START/STOP"},
		{"r", "RESTART"},
		{"d", "DIM"},
		{"q", "QUIT"},
	}

	keyStyle := lipgloss.NewStyle().
		Background(styles.MutedGrey).
		Foreground(styles.BrightWht).
		Bold(true)

	descStyle := lipgloss.NewStyle().
		Foreground(styles.MutedGrey)

	var parts []string
	for _, k := range keys {
		badge := keyStyle.Render(" " + k.key + " ")
		label := descStyle.Render(" " + k.desc)
		parts = append(parts, badge+label)
	}
	bar := strings.Join(parts, "  ")

	barW := lipgloss.Width(bar)
	if barW >= w {
		return bar
	}

	pad := (w - barW) / 2
	return strings.Repeat(" ", pad) + bar
}
