//go:build !darwin

package metrics

func collectProcessesDarwin(int) []ProcessInfo {
	return nil
}
