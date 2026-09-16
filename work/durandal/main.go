package main

import (
	"os"

	"github.com/blumenwagen/durandal/internal/app"
	"github.com/blumenwagen/durandal/internal/cli"
	"github.com/blumenwagen/durandal/internal/metrics"
	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	code := cli.Run(os.Args[1:], os.Stdout, os.Stderr, metrics.CollectSnapshot, runTUI)
	os.Exit(code)
}

func runTUI() error {
	m := app.NewModel()

	p := tea.NewProgram(
		m,
		tea.WithAltScreen(),
		tea.WithMouseCellMotion(),
	)

	_, err := p.Run()
	return err
}
