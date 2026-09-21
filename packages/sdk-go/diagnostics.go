package wayscribe

import (
	"fmt"
	"os"
	"sort"
	"sync"
)

// Diagnostic contains only safe bounded descriptions, never payload values.
type Diagnostic struct{ Kind, Code, Field, Name, Path, Shape string }
type DroppedCause string

const (
	QueueFull     DroppedCause = "queue_full"
	AfterShutdown DroppedCause = "after_shutdown"
	Shutdown      DroppedCause = "shutdown"
	RetryBudget   DroppedCause = "retry_budget"
	NoVerdict     DroppedCause = "no_verdict"
)

type Counters struct {
	Recorded, Sent, Rejected, Dropped, PayloadsOmitted, PayloadsTruncated, CaptureErrors, ConfigurationErrors, UnredactedSecretNames int64
	DroppedByCause                                                                                                                   map[DroppedCause]int64
}
type diagnostics struct {
	mu                       sync.Mutex
	counters                 Counters
	callback                 func(Diagnostic)
	logging                  bool
	names, settings, options map[string]bool
}

var processWarnings = struct {
	sync.Mutex
	seen map[string]bool
}{seen: map[string]bool{}}

func newDiagnostics(cb func(Diagnostic), logging bool) *diagnostics {
	d := &diagnostics{callback: cb, logging: logging, names: map[string]bool{}, settings: map[string]bool{}, options: map[string]bool{}}
	d.counters.DroppedByCause = map[DroppedCause]int64{}
	for _, c := range []DroppedCause{QueueFull, AfterShutdown, Shutdown, RetryBudget, NoVerdict} {
		d.counters.DroppedByCause[c] = 0
	}
	return d
}
func (d *diagnostics) snapshot() Counters {
	d.mu.Lock()
	defer d.mu.Unlock()
	c := d.counters
	c.DroppedByCause = map[DroppedCause]int64{}
	for k, v := range d.counters.DroppedByCause {
		c.DroppedByCause[k] = v
	}
	return c
}
func (d *diagnostics) increment(field string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch field {
	case "recorded":
		d.counters.Recorded++
	case "sent":
		d.counters.Sent++
	case "rejected":
		d.counters.Rejected++
	case "payloads_omitted":
		d.counters.PayloadsOmitted++
	case "payloads_truncated":
		d.counters.PayloadsTruncated++
	case "capture_errors":
		d.counters.CaptureErrors++
	}
}
func (d *diagnostics) drop(c DroppedCause) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.counters.Dropped++
	d.counters.DroppedByCause[c]++
}
func (d *diagnostics) rejectedSettings() []string { return d.rejected(false) }
func (d *diagnostics) rejectedOptions() []string  { return d.rejected(true) }
func (d *diagnostics) rejected(options bool) []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.settings
	if options {
		m = d.options
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
func (d *diagnostics) rejectSetting(field, code string) {
	d.mu.Lock()
	if !d.settings[field] {
		d.settings[field] = true
		d.counters.ConfigurationErrors++
	}
	d.mu.Unlock()
	d.emit(Diagnostic{Kind: "invalid_config", Field: field, Code: code})
}
func processOnce(key string) bool {
	processWarnings.Lock()
	defer processWarnings.Unlock()
	if processWarnings.seen[key] || len(processWarnings.seen) >= 1000 {
		return false
	}
	processWarnings.seen[key] = true
	return true
}
func (d *diagnostics) emit(v Diagnostic) {
	v.Name = prefixRunes(repairText(v.Name), 256)
	v.Path = prefixRunes(repairText(v.Path), 1024)
	if v.Kind == "invalid_option" {
		d.mu.Lock()
		if len(d.options) < 1000 {
			d.options[v.Field] = true
		}
		d.mu.Unlock()
	}
	force := false
	if v.Kind == "unredacted_secret_name" {
		folded := fold(v.Name)
		d.mu.Lock()
		seen := d.names[folded] || len(d.names) >= 1000
		if !seen {
			d.names[folded] = true
			d.counters.UnredactedSecretNames++
		}
		d.mu.Unlock()
		if seen {
			return
		}
		force = processOnce("name:" + folded)
	}
	if v.Kind == "personal_data" {
		if !processOnce("personal:" + v.Field + ":" + v.Shape) {
			return
		}
		force = true
	}
	if v.Kind == "invalid_config" && (v.Field == "Endpoint" || v.Field == "APIKey" || v.Field == "Service" || v.Field == "Environment" || v.Field == "JourneyIDSecret") {
		force = processOnce("config:" + v.Field)
	}
	if v.Kind == "derivation_unavailable" {
		force = processOnce("derive:secret")
	}
	if d.callback != nil {
		func() { defer func() { _ = recover() }(); d.callback(v) }()
	}
	// Caller-written names and paths never enter printed diagnostics.
	if d.logging || force {
		fmt.Fprintf(os.Stderr, "wayscribe: %s field=%s shape=%s (check configuration, redaction rules or known-safe names)\n", v.Kind, v.Field, v.Shape)
	}
}
