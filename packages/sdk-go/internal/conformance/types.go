// Package conformance drives the language-neutral SDK fixtures through the
// public Wayscribe Go API. It is internal so applications cannot depend on test
// support as part of the recorder's public surface.
package conformance

type Diagnostic struct {
	Kind   string         `json:"kind"`
	Detail map[string]any `json:"detail,omitempty"`
}

type CapturedCase struct {
	ID          string           `json:"id"`
	Batches     []string         `json:"batches"`
	Events      []map[string]any `json:"events"`
	Diagnostics []Diagnostic     `json:"diagnostics"`
}

type SkippedCase struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type Report struct {
	Cases   []CapturedCase `json:"cases"`
	Skipped []SkippedCase  `json:"skipped"`
}
