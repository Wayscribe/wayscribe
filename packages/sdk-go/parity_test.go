package wayscribe

import (
	"context"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

// Kinds and codes are the Node SDK's (packages/sdk-node/src/diagnostics.ts),
// so one handler can match on either SDK's diagnostics. See docs/SDK_SPEC.md.
type diagnosticLog struct {
	mu   sync.Mutex
	seen []Diagnostic
}

func (l *diagnosticLog) add(d Diagnostic) { l.mu.Lock(); l.seen = append(l.seen, d); l.mu.Unlock() }
func (l *diagnosticLog) count(kind, code, field string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, d := range l.seen {
		if d.Kind == kind && d.Code == code && (field == "" || d.Field == field) {
			n++
		}
	}
	return n
}

func TestConfigurationDiagnosticsUseNodeNames(t *testing.T) {
	log := &diagnosticLog{}
	New(Config{Endpoint: "http://collector.example", APIKey: "k", Service: "", Environment: "e", CaptureMode: "bogus", OnDiagnostic: log.add})
	if log.count("configuration_error", "required_setting_unusable", "Service") != 1 {
		t.Fatalf("required setting: %+v", log.seen)
	}
	if log.count("configuration_error", "setting_unusable", "CaptureMode") != 1 {
		t.Fatalf("optional setting: %+v", log.seen)
	}
	if log.count("insecure_endpoint", "unencrypted_endpoint", "") != 1 {
		t.Fatalf("insecure endpoint: %+v", log.seen)
	}
}

func TestDerivationDiagnosticsUseNodeNames(t *testing.T) {
	log := &diagnosticLog{}
	c, _ := resolveConfig(Config{Endpoint: "https://localhost:9999", APIKey: "k", Service: "s", Environment: "e"})
	d := newDiagnostics(log.add, false)
	deriveJourneyID(c, d, Entity{"order", "1"})
	deriveJourneyID(c, d, Entity{"", "1"})
	c.JourneyIDSecret = "short"
	deriveJourneyID(c, d, Entity{"order", "1"})
	if log.count("configuration_error", "journey_id_secret_missing", "JourneyIDSecret") != 1 ||
		log.count("configuration_error", "entity_invalid", "entity") != 1 ||
		log.count("configuration_error", "journey_id_secret_unusable", "JourneyIDSecret") != 1 {
		t.Fatalf("derivation: %+v", log.seen)
	}
	if d.snapshot().ConfigurationErrors != 3 {
		t.Fatalf("derivation failures are configuration errors: %+v", d.snapshot())
	}
}

func TestTransportDiagnosticsUseNodeNames(t *testing.T) {
	log := &diagnosticLog{}
	var calls int
	var mu sync.Mutex
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		mu.Lock()
		calls++
		first := calls == 1
		mu.Unlock()
		if first {
			w.WriteHeader(503)
			return
		}
		io.WriteString(w, `{"data":{"results":[{"status":"accepted"}]}}`)
	}, func(c *Config) {
		c.MaxAttempts = 1
		c.BreakerThreshold = 1
		c.BreakerReset = time.Millisecond
		c.OnDiagnostic = log.add
	})
	emitN(r, 1)
	if !r.Flush(context.Background()) {
		t.Fatal("flush")
	}
	emitN(r, 1)
	if !r.Flush(context.Background()) || r.Counters().Sent != 2 {
		t.Fatalf("second flush: %+v", r.Counters())
	}
	// Transport diagnostics reach the callback from the reporter goroutine.
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline) && (log.count("breaker_opened", "consecutive_failures", "") == 0 || log.count("delivered_first", "first_delivery", "") == 0); {
		time.Sleep(time.Millisecond)
	}
	if log.count("breaker_opened", "consecutive_failures", "") != 1 {
		t.Fatalf("breaker: %+v", log.seen)
	}
	if log.count("delivered_first", "first_delivery", "") != 1 {
		t.Fatalf("delivered_first must be reported once: %+v", log.seen)
	}
}
