package components

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/styles"
)

// Inspector provides a detailed view of a single process.
type Inspector struct {
	Width  int
	Height int
	Proc   metrics.ProcessInfo
}

func NewInspector() Inspector {
	return Inspector{}
}

func (i *Inspector) Update(p metrics.ProcessInfo) {
	i.Proc = p
}

func (i Inspector) View() string {
	if i.Width <= 0 || i.Height <= 0 {
		return ""
	}

	iw := i.Width - 4
	if iw < 20 {
		iw = 20
	}

	var lines []string

	// Title banner
	lines = append(lines, "  "+styles.Bright(fmt.Sprintf("PID %d // %s", i.Proc.PID, i.Proc.Name)))
	lines = append(lines, "")

	// Key-value pairs
	lines = append(lines, "  "+styles.KeyVal("USER", i.Proc.User, 8))
	lines = append(lines, "  "+styles.KeyVal("STATUS", i.Proc.Status, 8))
	lines = append(lines, "")

	// CPU & MEM
	lines = append(lines, "  "+styles.KeyVal("CPU", fmt.Sprintf("%.1f%%", i.Proc.CPU), 8))
	lines = append(lines, "  "+styles.KeyVal("MEM", fmt.Sprintf("%.1f%% (RSS: %s)", i.Proc.Memory, styles.FormatBytes(i.Proc.MemRSS)), 8))
	lines = append(lines, "")

	// Fast native detail fetching
	pid := i.Proc.PID

	// Threads: list count of /proc/[pid]/task
	if dirs, err := os.ReadDir(fmt.Sprintf("/proc/%d/task", pid)); err == nil {
		lines = append(lines, "  "+styles.KeyVal("THREADS", fmt.Sprintf("%d", len(dirs)), 15))
	}

	// CWD: readlink on /proc/[pid]/cwd
	if cwd, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid)); err == nil && cwd != "" {
		lines = append(lines, "  "+styles.KeyVal("CWD", cwd, 15))
	}

	// Read stat once for PPID and start time
	if statData, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); err == nil {
		endName := strings.LastIndexByte(string(statData), ')')
		if endName != -1 && len(statData) > endName+2 {
			fields := strings.Fields(string(statData[endName+2:]))
			if len(fields) >= 20 {

				// Parent Process
				ppidStr := fields[1]
				ppid := ppidStr
				if pNameData, err := os.ReadFile(fmt.Sprintf("/proc/%s/comm", ppid)); err == nil {
					pName := strings.TrimRight(string(pNameData), "\x00\n")
					if pName != "" {
						ppidStr = fmt.Sprintf("%s (%s)", ppid, pName)
					}
				}
				lines = append(lines, "  "+styles.KeyVal("PARENT", ppidStr, 15))

				// Threads natively from stat as fallback if dir failed
				// fields[17] is num_threads, but we prefer the dir count.

				// Start Time (requires btime from /proc/stat)
				if btimeData, err := os.ReadFile("/proc/stat"); err == nil {
					for _, line := range strings.Split(string(btimeData), "\n") {
						if strings.HasPrefix(line, "btime ") {
							var btime int64
							fmt.Sscanf(line, "btime %d", &btime)
							var starttimeTicks int64
							fmt.Sscanf(fields[19], "%d", &starttimeTicks)

							// CONFIG_HZ usually 100
							createdAt := btime + (starttimeTicks / 100)
							t := time.Unix(createdAt, 0)
							lines = append(lines, "  "+styles.KeyVal("STARTED", t.Format("2006-01-02 15:04:05"), 15))
							break
						}
					}
				}
			}
		}
	}

	// Open Files
	if fddirs, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid)); err == nil {
		lines = append(lines, "  "+styles.KeyVal("OPEN FILES", fmt.Sprintf("%d", len(fddirs)), 15))
	}

	// Wait disk IO implementation relies on root access to /proc/pid/io, skip easily blocking IO
	lines = append(lines, "")

	// Command
	lines = append(lines, "  "+styles.Dim("COMMAND LINE:"))
	cmd := i.Proc.Command
	if cmd == "" {
		cmd = i.Proc.Name
	}

	cmdLines := wrapString(cmd, iw-4)
	for _, cl := range cmdLines {
		lines = append(lines, "    "+styles.Bright(cl))
	}

	// Close hint
	lines = append(lines, "")
	lines = append(lines, "  "+styles.Dim("Press ")+styles.Pink("[ESC]")+styles.Dim(" or ")+styles.Pink("[ENTER]")+styles.Dim(" to close"))

	return styles.MagPanel("INSPECT", strings.Join(lines, "\n"), i.Width, i.Height, styles.Secondary())
}

func wrapString(s string, w int) []string {
	if w <= 0 {
		return []string{s}
	}
	var res []string
	for len(s) > w {
		res = append(res, s[:w])
		s = s[w:]
	}
	if len(s) > 0 {
		res = append(res, s)
	}
	return res
}
