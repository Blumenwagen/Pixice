package app

import (
	"testing"
	"time"

	"github.com/blumenwagen/durandal/internal/metrics"
)

func TestModelCollectionGuard(t *testing.T) {
	m := NewModel()
	if !m.collecting {
		t.Fatal("initial collection should be marked in flight")
	}

	next, _ := m.Update(snapshotMsg(metrics.Snapshot{}))
	m = next.(Model)
	if m.collecting {
		t.Fatal("snapshot completion should clear the collection guard")
	}

	next, _ = m.Update(tickMsg(time.Now()))
	m = next.(Model)
	if !m.collecting {
		t.Fatal("a tick should mark the next collection in flight")
	}
}
