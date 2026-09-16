package app

import (
	"sort"
	"time"

	"github.com/blumenwagen/durandal/internal/components"
	"github.com/blumenwagen/durandal/internal/metrics"
	"github.com/blumenwagen/durandal/internal/ops"
	"github.com/blumenwagen/durandal/internal/styles"
	tea "github.com/charmbracelet/bubbletea"
)

type tickMsg time.Time
type snapshotMsg metrics.Snapshot

// Model is the root Bubble Tea model.
type Model struct {
	Width  int
	Height int

	Header        components.Header
	Sentinel      components.Sentinel
	CPU           components.CPU
	GPU           components.GPU
	Memory        components.Memory
	Processes     components.Processes
	Docker        components.Docker
	Network       components.Network
	Disk          components.Disk
	Inspector     components.Inspector
	InspectorOpen bool
	DockerFocused bool

	ProcY      int // Y-coordinate where process list starts
	DockerY    int // Y-coordinate where Docker station starts
	ready      bool
	quitting   bool
	collecting bool
}

func NewModel() Model {
	return Model{
		CPU:        components.NewCPU(),
		GPU:        components.NewGPU(),
		Memory:     components.NewMemory(),
		Processes:  components.NewProcesses(),
		Docker:     components.NewDocker(),
		Network:    components.NewNetwork(),
		Disk:       components.NewDisk(),
		Header:     components.NewHeader(),
		Sentinel:   components.NewSentinel(),
		Inspector:  components.NewInspector(),
		collecting: true,
	}
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(tickCmd(), collectCmd())
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:

		// If process list is filtering, route keys to textinput
		if m.Processes.IsFiltering {
			switch msg.String() {
			case "esc", "enter":
				m.Processes.IsFiltering = false
			default:
				var cmd tea.Cmd
				m.Processes.FilterInput, cmd = m.Processes.FilterInput.Update(msg)
				m.Processes.SetFilter(m.Processes.FilterInput.Value())
				return m, cmd
			}
			return m, nil
		}

		// If process list is showing a kill error, intercept keys to dismiss it
		if m.Processes.KillErrorPopup != "" {
			switch msg.String() {
			case "esc", "enter":
				m.Processes.CancelKill()
			case "q", "ctrl+c":
				m.quitting = true
				return m, tea.Quit
			}
			return m, nil
		}

		// If process list is in kill confirmation mode, intercept specific keys
		if m.Processes.KillConfirm {
			switch msg.String() {
			case "y", "Y":
				m.Processes.ConfirmKill()
			case "n", "N", "esc", "q", "ctrl+c":
				m.Processes.CancelKill()
			}
			return m, nil
		}

		if m.Docker.Confirm != "" {
			switch msg.String() {
			case "y", "Y":
				m.Docker.ConfirmAction()
				if m.collecting {
					return m, nil
				}
				m.collecting = true
				return m, collectCmd()
			case "n", "N", "esc":
				m.Docker.CancelAction()
			case "q", "ctrl+c":
				m.quitting = true
				return m, tea.Quit
			}
			return m, nil
		}

		switch msg.String() {
		case "esc":
			if m.InspectorOpen {
				m.InspectorOpen = false
			} else {
				m.DockerFocused = false
			}
		case "q", "ctrl+c":
			m.quitting = true
			return m, tea.Quit
		case "c":
			m.DockerFocused = !m.DockerFocused
		case "j", "down":
			if m.DockerFocused {
				m.Docker.ScrollDown()
			} else {
				m.Processes.ScrollDown()
				if m.InspectorOpen && len(m.Processes.List) > 0 && m.Processes.Cursor >= 0 && m.Processes.Cursor < len(m.Processes.List) {
					m.Inspector.Update(m.Processes.List[m.Processes.Cursor])
				}
			}
		case "k", "up":
			if m.DockerFocused {
				m.Docker.ScrollUp()
			} else {
				m.Processes.ScrollUp()
				if m.InspectorOpen && len(m.Processes.List) > 0 && m.Processes.Cursor >= 0 && m.Processes.Cursor < len(m.Processes.List) {
					m.Inspector.Update(m.Processes.List[m.Processes.Cursor])
				}
			}
		case "s", "tab":
			if !m.DockerFocused {
				m.Processes.ToggleSort()
			}
		case "/":
			if !m.DockerFocused {
				m.Processes.IsFiltering = true
				m.Processes.FilterInput.Focus()
			}
		case "enter":
			if !m.DockerFocused {
				if m.InspectorOpen {
					m.InspectorOpen = false
				} else {
					if len(m.Processes.List) > 0 && m.Processes.Cursor >= 0 {
						m.InspectorOpen = true
						m.Inspector.Update(m.Processes.List[m.Processes.Cursor])
					}
				}
			}
		case "K": // Shift+K to kill
			if !m.DockerFocused {
				m.Processes.RequestKill()
			}
		case "x":
			if m.DockerFocused {
				m.Docker.RequestToggle()
			}
		case "r":
			if m.DockerFocused {
				m.Docker.RequestRestart()
			}
		case "d":
			styles.Dimmed = !styles.Dimmed
		}

	case tea.MouseMsg:
		switch msg.Type {
		case tea.MouseWheelUp:
			if msg.Y >= m.DockerY {
				m.DockerFocused = true
				m.Docker.ScrollUp()
			} else {
				m.DockerFocused = false
				m.Processes.ScrollUp()
				if m.InspectorOpen && len(m.Processes.List) > 0 && m.Processes.Cursor >= 0 && m.Processes.Cursor < len(m.Processes.List) {
					m.Inspector.Update(m.Processes.List[m.Processes.Cursor])
				}
			}
		case tea.MouseWheelDown:
			if msg.Y >= m.DockerY {
				m.DockerFocused = true
				m.Docker.ScrollDown()
			} else {
				m.DockerFocused = false
				m.Processes.ScrollDown()
				if m.InspectorOpen && len(m.Processes.List) > 0 && m.Processes.Cursor >= 0 && m.Processes.Cursor < len(m.Processes.List) {
					m.Inspector.Update(m.Processes.List[m.Processes.Cursor])
				}
			}
		case tea.MouseLeft:
			contentStartY := m.ProcY + 4
			contentEndY := m.ProcY + m.Processes.Height - 1
			if msg.Y >= contentStartY && msg.Y < contentEndY {
				m.DockerFocused = false
				clickedIdx := msg.Y - contentStartY + m.Processes.Offset
				if clickedIdx >= 0 && clickedIdx < len(m.Processes.List) {
					m.Processes.Cursor = clickedIdx
					m.Processes.SelectedPID = m.Processes.List[clickedIdx].PID
					if m.Processes.KillConfirm {
						m.Processes.CancelKill()
					}
					if m.InspectorOpen {
						m.Inspector.Update(m.Processes.List[m.Processes.Cursor])
					}
				}
			} else if msg.Y >= m.DockerY {
				m.DockerFocused = true
				dockerContentStartY := m.DockerY + 4
				dockerContentEndY := m.DockerY + m.Docker.Height - 1
				if msg.Y >= dockerContentStartY && msg.Y < dockerContentEndY {
					clickedIdx := msg.Y - dockerContentStartY + m.Docker.Offset
					if clickedIdx >= 0 && clickedIdx < len(m.Docker.Info.Containers) {
						m.Docker.Cursor = clickedIdx
						m.Docker.CancelAction()
					}
				}
			}
		}

	case tea.WindowSizeMsg:
		m.Width = msg.Width
		m.Height = msg.Height
		m.ready = true
		m = calculateLayout(m)

	case tickMsg:
		if m.collecting {
			return m, tickCmd()
		}
		m.collecting = true
		return m, tea.Batch(tickCmd(), collectCmd())

	case snapshotMsg:
		m.collecting = false
		snap := metrics.Snapshot(msg)
		m.Header.Host = snap.Host
		m.Sentinel.Update(ops.EvaluateSnapshot(snap))
		m.CPU.Update(snap.CPU)
		m.Memory.Update(snap.Memory, snap.Sensors)

		procs := snap.Processes
		if !m.Processes.SortByCPU {
			sort.Slice(procs, func(i, j int) bool {
				return procs[i].Memory > procs[j].Memory
			})
		}
		m.Processes.Update(procs)

		// Update Inspector data if open
		if m.InspectorOpen && len(m.Processes.List) > 0 {
			m.Inspector.Update(m.Processes.List[m.Processes.Cursor])
		}

		m.GPU.Update(snap.GPUs)

		m.Network.Update(snap.Network)
		m.Disk.Update(snap.Disks)
		m.Docker.Update(snap.Docker)
		m.Docker.Focused = m.DockerFocused

		if m.ready {
			m = calculateLayout(m)
		}
	}

	return m, nil
}

func (m Model) View() string {
	if m.quitting {
		return ""
	}
	if !m.ready {
		return "\n  " + styles.Accent("《") + styles.Bright(" DURANDAL ") + styles.Accent("》") + " initializing…"
	}
	return renderLayout(m)
}

func tickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func collectCmd() tea.Cmd {
	return func() tea.Msg {
		snap, _ := metrics.CollectSnapshot()
		return snapshotMsg(snap)
	}
}
