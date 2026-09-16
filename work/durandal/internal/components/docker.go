package components

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/styles"
	"github.com/charmbracelet/lipgloss"
)

// Docker renders a local container control station.
type Docker struct {
	Width  int
	Height int

	Info         metrics.DockerInfo
	Cursor       int
	Offset       int
	Focused      bool
	Confirm      string
	ActionResult string
	ActionTime   time.Time
}

func NewDocker() Docker { return Docker{} }

func (d *Docker) Update(info metrics.DockerInfo) {
	d.Info = info
	if d.Cursor >= len(d.Info.Containers) {
		d.Cursor = len(d.Info.Containers) - 1
	}
	if d.Cursor < 0 {
		d.Cursor = 0
	}
	if d.ActionResult != "" && time.Since(d.ActionTime) > 4*time.Second {
		d.ActionResult = ""
	}
}

func (d *Docker) ScrollUp() {
	if d.Confirm != "" {
		return
	}
	if d.Cursor > 0 {
		d.Cursor--
	}
}

func (d *Docker) ScrollDown() {
	if d.Confirm != "" {
		return
	}
	if d.Cursor < len(d.Info.Containers)-1 {
		d.Cursor++
	}
}

func (d *Docker) RequestToggle() {
	if !d.hasSelection() {
		return
	}
	if d.Info.Containers[d.Cursor].Running {
		d.Confirm = "stop"
	} else {
		d.Confirm = "start"
	}
	d.ActionResult = ""
}

func (d *Docker) RequestRestart() {
	if !d.hasSelection() || !d.Info.Containers[d.Cursor].Running {
		return
	}
	d.Confirm = "restart"
	d.ActionResult = ""
}

func (d *Docker) CancelAction() {
	d.Confirm = ""
}

func (d *Docker) ConfirmAction() {
	if d.Confirm == "" || !d.hasSelection() {
		d.Confirm = ""
		return
	}

	action := d.Confirm
	container := d.Info.Containers[d.Cursor]
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "docker", action, container.ID).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		d.ActionResult = fmt.Sprintf("x %s %s timed out", strings.ToUpper(action), container.Name)
	} else if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		d.ActionResult = fmt.Sprintf("x %s %s: %s", strings.ToUpper(action), container.Name, msg)
	} else {
		d.ActionResult = fmt.Sprintf("OK %s %s", strings.ToUpper(action), container.Name)
	}

	d.ActionTime = time.Now()
	d.Confirm = ""
}

func (d Docker) View() string {
	iw := d.Width - 4
	if iw < 20 {
		iw = 20
	}

	var lines []string
	if !d.Info.Available {
		msg := d.Info.Error
		if msg == "" {
			msg = "docker unavailable"
		}
		lines = append(lines, styles.Crit("OFFLINE")+" "+styles.Dim(msg))
		lines = append(lines, "")
		lines = append(lines, styles.Dim("Install Docker or start the daemon to enable controls."))
		return styles.MagPanel("DOCKER", strings.Join(lines, "\n"), d.Width, d.Height, styles.Secondary())
	}

	status := styles.Dim(fmt.Sprintf(" %d CONTAINERS", len(d.Info.Containers)))
	if d.Focused {
		status = styles.Accent(" ACTIVE") + status
	} else {
		status = styles.Dim(" IDLE") + status
	}

	if d.Confirm != "" && d.hasSelection() {
		c := d.Info.Containers[d.Cursor]
		status = styles.Crit(fmt.Sprintf(" %s %s? ", strings.ToUpper(d.Confirm), c.Name)) +
			styles.Accent("[Y]") + styles.Dim("ES ") +
			styles.Accent("[N]") + styles.Dim("O")
	} else if d.ActionResult != "" {
		if strings.HasPrefix(d.ActionResult, "OK") {
			status = styles.Accent(" " + d.ActionResult)
		} else {
			status = styles.Crit(" " + d.ActionResult)
		}
	}

	lines = append(lines, status)
	lines = append(lines, "")

	if len(d.Info.Containers) == 0 {
		lines = append(lines, styles.Dim("No local containers."))
		return styles.MagPanel("DOCKER", strings.Join(lines, "\n"), d.Width, d.Height, styles.Secondary())
	}

	hdr := fmtDockerRow("STATE", "NAME", "IMAGE", iw)
	lines = append(lines, " "+lipgloss.NewStyle().
		Foreground(styles.DeepBlack).
		Background(styles.MutedGrey).
		Bold(true).
		Render(hdr))

	visibleRows := d.Height - 7
	if visibleRows < 1 {
		visibleRows = 1
	}
	if d.Cursor < d.Offset {
		d.Offset = d.Cursor
	}
	if d.Cursor >= d.Offset+visibleRows {
		d.Offset = d.Cursor - visibleRows + 1
	}

	for i := d.Offset; i < len(d.Info.Containers) && i < d.Offset+visibleRows; i++ {
		c := d.Info.Containers[i]
		state := strings.ToUpper(c.State)
		if c.Running {
			state = "RUN"
		}
		row := fmtDockerRow(state, c.Name, c.Image, iw)

		if i == d.Cursor && d.Focused {
			bg := styles.Primary()
			if d.Confirm != "" {
				bg = styles.Red
			}
			row = lipgloss.NewStyle().Foreground(styles.DeepBlack).Background(bg).Bold(true).Render(row)
		} else if c.Running {
			row = lipgloss.NewStyle().Foreground(styles.OffWhite).Render(row)
		} else {
			row = lipgloss.NewStyle().Foreground(styles.MutedGrey).Render(row)
		}

		lines = append(lines, " "+row)
	}

	return styles.MagPanel("DOCKER", strings.Join(lines, "\n"), d.Width, d.Height, styles.Secondary())
}

func (d Docker) hasSelection() bool {
	return d.Cursor >= 0 && d.Cursor < len(d.Info.Containers)
}

func fmtDockerRow(state, name, image string, maxW int) string {
	fixedW := 16
	nameW := (maxW - fixedW) / 2
	imageW := maxW - fixedW - nameW
	if nameW < 6 {
		nameW = 6
	}
	if imageW < 6 {
		imageW = 6
	}

	s := fmt.Sprintf(" %-8s %s %s",
		state,
		dockerCell(name, nameW),
		dockerCell(image, imageW),
	)
	if len(s) > maxW {
		s = s[:maxW]
	}
	return s
}

func dockerCell(s string, width int) string {
	if len(s) > width {
		if width <= 3 {
			return s[:width]
		}
		return s[:width-3] + "..."
	}
	return s + strings.Repeat(" ", width-len(s))
}
