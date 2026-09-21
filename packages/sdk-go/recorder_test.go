package wayscribe

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type Order struct{ ID string }
type wireSink struct {
	mu     sync.Mutex
	bodies [][]byte
	events []map[string]any
}

func testRecorder(t *testing.T, configure func(*Config)) (*Recorder, *wireSink) {
	t.Helper()
	sink := &wireSink{}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/events/batch" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("wrong request %s", r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		var batch struct {
			Events []struct {
				Event map[string]any `json:"event"`
			} `json:"events"`
		}
		_ = json.Unmarshal(b, &batch)
		sink.mu.Lock()
		sink.bodies = append(sink.bodies, b)
		for _, e := range batch.Events {
			sink.events = append(sink.events, e.Event)
		}
		sink.mu.Unlock()
		results := make([]map[string]any, len(batch.Events))
		for i := range results {
			results[i] = map[string]any{"status": "accepted", "eventId": "foreign"}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"results": results}})
	}))
	t.Cleanup(s.Close)
	c := Config{Endpoint: s.URL, APIKey: "test-key", Service: "orders", Environment: "test", FlushInterval: time.Hour, BackoffBase: time.Millisecond, BackoffMax: time.Millisecond}
	if configure != nil {
		configure(&c)
	}
	r := New(c)
	t.Cleanup(func() { r.Shutdown(context.Background()) })
	return r, sink
}
func flushedEvents(t *testing.T, r *Recorder, s *wireSink) []map[string]any {
	t.Helper()
	if !r.Flush(context.Background()) {
		t.Fatal("flush failed")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.events...)
}
func TestWrapperIdentityAndSnapshots(t *testing.T) {
	r, s := testRecorder(t, nil)
	j := r.Journey(Entity{"order", "1"})
	input := map[string]any{"phase": "before"}
	metadata := map[string]any{"nested": map[string]any{"phase": "before"}}
	aliases := map[string]string{"external": "before"}
	display := []string{"external"}
	original := &Order{"1"}
	sentinel := errors.New("host sentinel")
	result, err := Transform(context.Background(), j, "normalize", input, func(context.Context) (*Order, error) {
		input["phase"] = "after"
		metadata["nested"].(map[string]any)["phase"] = "after"
		aliases["external"] = "after"
		display[0] = "other"
		return original, sentinel
	}, Options[map[string]any, *Order]{Metadata: metadata, Aliases: aliases, DisplayableAliases: display, Attempt: 2})
	if result != original || err != sentinel {
		t.Fatal("host result/error changed")
	}
	es := flushedEvents(t, r, s)
	if len(es) != 1 {
		t.Fatal(es)
	}
	e := es[0]
	if e["input"].(map[string]any)["phase"] != "before" || e["metadata"].(map[string]any)["nested"].(map[string]any)["phase"] != "before" || e["aliases"].(map[string]any)["external"] != "before" {
		t.Fatal(e)
	}
	if e["operation"] != "retried" || e["error"].(map[string]any)["message"] != "host sentinel" {
		t.Fatal(e)
	}
}
func TestAcrossAndGuardedProjections(t *testing.T) {
	r, s := testRecorder(t, nil)
	a := r.Journey(Entity{"order", "a"})
	b := r.Journey(Entity{"order", "b"})
	calls := 0
	v, err := Validate(context.Background(), r.Across(a, a, b), "check", 3, func(context.Context) (int, error) { calls++; return 7, nil }, Options[int, int]{CaptureInput: func(int, Context) any { panic("input") }, CaptureOutput: func(int, Context) any { panic("output") }, MetadataFrom: func(int, Context) map[string]any { panic("metadata") }, IsFailure: func(int) *FailureReason { panic("verdict") }})
	if calls != 1 || v != 7 || err != nil {
		t.Fatal(calls, v, err)
	}
	es := flushedEvents(t, r, s)
	if len(es) != 2 || es[0]["id"] == es[1]["id"] || es[0]["timestamp"] != es[1]["timestamp"] || es[0]["durationMs"] != es[1]["durationMs"] {
		t.Fatal(es)
	}
	for _, e := range es {
		if e["input"] != "[UNCAPTURABLE]" || e["output"] != "[UNCAPTURABLE]" || e["operation"] != "validated" {
			t.Fatal(e)
		}
	}
}
func TestHostPanicCancellationAndGoexit(t *testing.T) {
	r, s := testRecorder(t, nil)
	j := r.Journey(Entity{"order", "a"})
	sentinel := &Order{"panic"}
	func() {
		defer func() {
			if recover() != sentinel {
				t.Fatal("panic changed")
			}
		}()
		Transform(context.Background(), j, "panic", 0, func(context.Context) (int, error) { panic(sentinel) })
	}()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Deliver(ctx, j, "cancel", 0, func(c context.Context) (int, error) { return 9, c.Err() })
	if err != context.Canceled {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		Transform(context.Background(), j, "exit", 0, func(context.Context) (int, error) { runtime.Goexit(); return 0, nil })
	}()
	<-done
	es := flushedEvents(t, r, s)
	if len(es) != 2 {
		t.Fatalf("Goexit recorded success: %v", es)
	}
}
func TestNilDisabledAndContext(t *testing.T) {
	finishWarnings := captureWarnings(t)
	disabled := New(Config{})
	assertWarningLines(t, finishWarnings(), 4)
	t.Cleanup(func() { disabled.Shutdown(nil) })
	var r *Recorder
	var j *Journey
	var g *Group
	for _, target := range []Target{nil, j, g, (&Recorder{}).Journey(Entity{}), disabled.Journey(Entity{}), r.Across()} {
		n := 0
		v, e := Persist(context.Background(), target, "x", 0, func(context.Context) (int, error) { n++; return 42, nil })
		if n != 1 || v != 42 || e != nil {
			t.Fatal(n, v, e)
		}
	}
	r.Journey(Entity{}).Record(Event{})
	j.Label("x")
	j.Record(Event{})
	j.Identify(nil)
	j.Fail("x", nil)
	j.Complete("")
	_ = j.Context()
	_ = r.Counters()
	_ = r.RejectedSettings()
	if !r.Flush(nil) || !r.Shutdown(nil) {
		t.Fatal("nil lifecycle")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	real := (&Recorder{}).Journey(Entity{"x", "1"})
	carried := WithJourney(ctx, real)
	got, ok := JourneyFromContext(carried)
	if !ok || got != real {
		t.Fatal("context")
	}
	cancel()
	if carried.Err() != context.Canceled {
		t.Fatal("lost cancellation")
	}
}
func TestDiagnosticCaptureBarrier(t *testing.T) {
	input := map[string]any{"phase": "before"}
	metadata := map[string]any{strings.Repeat("k", 129): 1, "nested": map[string]any{"phase": "before"}}
	aliases := map[string]string{"external": "before"}
	display := []string{"external"}
	r, s := testRecorder(t, func(c *Config) {
		c.OnDiagnostic = func(d Diagnostic) {
			if d.Kind == "invalid_option" {
				input["phase"] = "after"
				metadata["nested"].(map[string]any)["phase"] = "after"
				aliases["external"] = "after"
				display[0] = "other"
			}
		}
	})
	j := r.Journey(Entity{"order", "a"})
	j.Record(Event{Operation: Received, Name: "raw", Input: Payload(input), Metadata: metadata, Aliases: aliases, DisplayableAliases: display, ParentEventID: strings.Repeat("p", 129)})
	e := flushedEvents(t, r, s)[0]
	if e["input"].(map[string]any)["phase"] != "before" || e["metadata"].(map[string]any)["nested"].(map[string]any)["phase"] != "before" || e["aliases"].(map[string]any)["external"] != "before" {
		t.Fatal(e)
	}
}

func TestProjectionBeforeDiagnosticReentry(t *testing.T) {
	input := map[string]any{"phase": "before"}
	r, s := testRecorder(t, func(c *Config) {
		c.OnDiagnostic = func(d Diagnostic) {
			if d.Kind == "invalid_option" {
				input["phase"] = "diagnostic"
			}
		}
	})
	o := Options[map[string]any, int]{CaptureInput: func(v map[string]any, _ Context) any { return v }}
	Transform(context.Background(), r.Journey(Entity{"order", "a"}), "project", input, func(context.Context) (int, error) { input["phase"] = "host"; return 1, nil }, o, o)
	e := flushedEvents(t, r, s)[0]
	if e["input"].(map[string]any)["phase"] != "before" {
		t.Fatal(e)
	}
}
func TestMergedMetadataRetainsOnlySurvivingEvidence(t *testing.T) {
	r, s := testRecorder(t, nil)
	static := map[string]any{"replaced": strings.Repeat("x", 70000), "sessionToken": "sensitive", strings.Repeat("a", 129): 1, strings.Repeat("b", 129): 2}
	Transform(context.Background(), r.Journey(Entity{"order", "a"}), "merge", 0, func(context.Context) (int, error) { return 1, nil }, Options[int, int]{Metadata: static, MetadataFrom: func(int, Context) map[string]any { return map[string]any{"replaced": "short", "sessionToken": ""} }})
	e := flushedEvents(t, r, s)[0]
	m := e["metadata"].(map[string]any)
	if m["[KEY_TOO_LONG]"] != float64(2) || m["replaced"] != "short" {
		t.Fatal(m)
	}
	if c := r.Counters(); c.PayloadsTruncated != 0 || c.UnredactedSecretNames != 0 {
		t.Fatal(c)
	}
}
func TestJourneyIdentityLabelsAndOptions(t *testing.T) {
	r, s := testRecorder(t, func(c *Config) { c.JourneyIDSecret = strings.Repeat("s", 32) })
	e := Entity{"order", "a"}
	a := r.ForEntity(e, LabelOptions{Label: "first"})
	b := r.ForEntity(e)
	if a.Context().JourneyID != b.Context().JourneyID {
		t.Fatal("derivation differs")
	}
	detached := a.Context()
	detached.Entity.ID = "changed"
	a.Label("")
	a.Record(Event{Operation: Received, Name: "first", Input: Payload(nil)})
	a.Label("later")
	a.Identify(map[string]string{"public": "A"}, IdentifyOptions{DisplayableAliases: []string{"public"}}, IdentifyOptions{})
	a.Complete("")
	r.Journey(e, JourneyOptions{JourneyID: strings.Repeat("x", 129)}).Complete("")
	carrier := Context{JourneyID: strings.Repeat("x", 129)}
	resumed := r.Resume(carrier, e)
	if resumed.Context().JourneyID == carrier.JourneyID {
		t.Fatal("invalid event id continued")
	}
	resumed.Complete("resumed")
	es := flushedEvents(t, r, s)
	if len(es) != 4 || es[0]["journeyLabel"] != "first" || es[1]["journeyLabel"] != "later" || es[2]["name"] != "complete" || es[0]["entity"].(map[string]any)["id"] != "a" {
		t.Fatal(es)
	}
	if _, ok := es[0]["input"]; !ok {
		t.Fatal("null became absent")
	}
	if _, ok := es[2]["input"]; ok {
		t.Fatal("absent became null")
	}
	if len(r.RejectedSettings()) != 0 {
		t.Fatal(r.RejectedSettings())
	}
}

func TestMetadataMergeKeepsWholeObjectRedaction(t *testing.T) {
	r, s := testRecorder(t, nil)
	Transform(context.Background(), r.Journey(Entity{"order", "a"}), "merge", 0, func(context.Context) (int, error) { return 1, nil }, Options[int, int]{Metadata: map[string]any{"headers": []any{map[string]any{"name": "Authorization", "value": "Bearer private"}}}, MetadataFrom: func(int, Context) map[string]any { return map[string]any{"extra": true} }})
	e := flushedEvents(t, r, s)[0]
	if e["metadata"].(map[string]any)["headers"].([]any)[0].(map[string]any)["value"] != "[REDACTED]" {
		t.Fatal(e)
	}
}
func TestWrapperProjectionAndFailureSemantics(t *testing.T) {
	r, s := testRecorder(t, nil)
	a := r.Journey(Entity{"order", "a"})
	b := r.Journey(Entity{"order", "b"})
	meta := map[string]any{"before": true}
	projectedInput := map[string]any{"before": true}
	classifications := 0
	result, err := Publish(context.Background(), r.Across(a, b), "publish", 0, func(context.Context) (int, error) { projectedInput["before"] = false; return 12, nil }, Options[int, int]{Metadata: meta, CaptureInput: func(int, Context) any { meta["before"] = false; return projectedInput }, CaptureOutput: func(v int, c Context) any {
		c.Entity.ID = "projection mutation"
		return map[string]any{"result": v, "journey": c.JourneyID}
	}, MetadataFrom: func(v int, c Context) map[string]any { return map[string]any{"result": v, "journey": c.JourneyID} }, IsFailure: func(int) *FailureReason {
		classifications++
		return &FailureReason{Message: "provider declined", Code: "DECLINED"}
	}})
	if result != 12 || err != nil || classifications != 1 {
		t.Fatal(result, err, classifications)
	}
	es := flushedEvents(t, r, s)
	if len(es) != 2 {
		t.Fatal(es)
	}
	for _, e := range es {
		if e["operation"] != "failed" || e["input"].(map[string]any)["before"] != true || e["metadata"].(map[string]any)["before"] != true || e["output"].(map[string]any)["journey"] != e["journeyId"] || e["error"].(map[string]any)["code"] != "DECLINED" {
			t.Fatal(e)
		}
	}
}
func TestAllNaturalOperationsAndGroupMembership(t *testing.T) {
	r, s := testRecorder(t, nil)
	other, _ := testRecorder(t, nil)
	a := r.Journey(Entity{"o", "a"}, JourneyOptions{JourneyID: "jrn_same"})
	duplicate := r.Journey(Entity{"o", "b"}, JourneyOptions{JourneyID: "jrn_same"})
	g := r.Across(a, duplicate, other.Journey(Entity{"o", "foreign"}))
	wrappers := []func(context.Context, Target, string, int, func(context.Context) (int, error), ...Options[int, int]) (int, error){Transform[int, int], Persist[int, int], Publish[int, int], Consume[int, int], Deliver[int, int], Validate[int, int]}
	for _, fn := range wrappers {
		fn(context.Background(), g, "natural", 0, func(context.Context) (int, error) { return 1, nil })
	}
	es := flushedEvents(t, r, s)
	if len(es) != 6 {
		t.Fatal(es)
	}
	for i, op := range []string{"transformed", "persisted", "published", "consumed", "delivered", "validated"} {
		if es[i]["operation"] != op {
			t.Fatal(es)
		}
	}
}
