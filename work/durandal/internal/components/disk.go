package components

import (
	"fmt"
	"strings"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/styles"
)

// Disk shows per-mountpoint usage.
type Disk struct {
	Width  int
	Height int
	Disks  []metrics.DiskInfo
}

func NewDisk() Disk { return Disk{} }

func (d *Disk) Update(disks []metrics.DiskInfo) {
	d.Disks = disks
}

func (d Disk) View() string {
	iw := d.Width - 2
	if iw < 10 {
		iw = 10
	}

	var lines []string

	maxDisks := (d.Height - 2) / 2
	if maxDisks < 1 {
		maxDisks = 1
	}

	barW := iw
	for i, disk := range d.Disks {
		if i >= maxDisks {
			break
		}

		mount := disk.Mountpoint
		if len(mount) > 15 {
			mount = "…" + mount[len(mount)-14:]
		}

		usedStr := styles.FormatBytes(disk.Used)
		totalStr := styles.FormatBytes(disk.Total)

		label := styles.Teal(mount) + " " +
			styles.Dim(fmt.Sprintf("%s/%s %s", usedStr, totalStr, disk.Filesystem))
		lines = append(lines, label)

		lines = append(lines, styles.GradientBar(disk.UsedPercent, barW))
	}

	return styles.MagPanel("STORAGE", strings.Join(lines, "\n"), d.Width, d.Height, styles.Amber)
}
