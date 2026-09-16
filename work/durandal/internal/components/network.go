package components

import (
	"strings"

	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/styles"
)

// Network shows upload/download rates with sparklines.
type Network struct {
	Width       int
	Height      int
	Info        metrics.NetworkInfo
	RecvHistory []float64
	SendHistory []float64
	MaxRate     float64
}

const maxNetHistory = 60

func NewNetwork() Network {
	return Network{
		RecvHistory: make([]float64, 0, maxNetHistory),
		SendHistory: make([]float64, 0, maxNetHistory),
	}
}

func (n *Network) Update(info metrics.NetworkInfo) {
	n.Info = info
	recv := float64(info.BytesRecvRate)
	send := float64(info.BytesSentRate)
	if recv > n.MaxRate {
		n.MaxRate = recv
	}
	if send > n.MaxRate {
		n.MaxRate = send
	}

	recvPct, sendPct := 0.0, 0.0
	if n.MaxRate > 0 {
		recvPct = recv / n.MaxRate * 100
		sendPct = send / n.MaxRate * 100
	}

	n.RecvHistory = append(n.RecvHistory, recvPct)
	n.SendHistory = append(n.SendHistory, sendPct)
	if len(n.RecvHistory) > maxNetHistory {
		n.RecvHistory = n.RecvHistory[1:]
	}
	if len(n.SendHistory) > maxNetHistory {
		n.SendHistory = n.SendHistory[1:]
	}
}

func (n Network) View() string {
	iw := n.Width - 2
	if iw < 10 {
		iw = 10
	}

	var lines []string

	// Download
	lines = append(lines, styles.Accent("▼ DOWN ")+styles.Bright(styles.FormatBytesRate(n.Info.BytesRecvRate)))

	usable := n.Height - 2
	if usable < 4 {
		usable = 4
	}
	sparkH := (usable - 2) / 2
	if sparkH < 1 {
		sparkH = 1
	}

	lines = append(lines, strings.Split(styles.MultiSparkline(n.RecvHistory, iw, sparkH, styles.Primary()), "\n")...)

	// Upload
	lines = append(lines, styles.Pink("▲ UP   ")+styles.Bright(styles.FormatBytesRate(n.Info.BytesSentRate)))
	lines = append(lines, strings.Split(styles.MultiSparkline(n.SendHistory, iw, sparkH, styles.Secondary()), "\n")...)

	return styles.MagPanel("NETWORK", strings.Join(lines, "\n"), n.Width, n.Height, styles.HotPink)
}
