package wayscribe

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func transportRecorder(t *testing.T, h http.HandlerFunc, change func(*Config)) *Recorder {
	t.Helper()
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	c := Config{Endpoint: s.URL, APIKey: "key", Service: "test", Environment: "test", FlushInterval: time.Hour, MaxConcurrentSends: 1, BackoffBase: time.Millisecond, BackoffMax: time.Millisecond}
	if change != nil {
		change(&c)
	}
	r := New(c)
	t.Cleanup(func() { r.Shutdown(context.Background()) })
	return r
}
func emitN(r *Recorder, n int) {
	j := r.Journey(Entity{"order", "one"})
	for i := 0; i < n; i++ {
		j.Record(Event{Operation: Received, Name: "receive", Input: Payload(i)})
	}
}
func TestPositionalVerdictsAndStableRetries(t *testing.T) {
	var bodies [][]json.RawMessage
	var mu sync.Mutex
	calls := 0
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		var b struct {
			Events []json.RawMessage `json:"events"`
		}
		_ = json.NewDecoder(q.Body).Decode(&b)
		mu.Lock()
		defer mu.Unlock()
		bodies = append(bodies, b.Events)
		calls++
		if calls == 1 {
			io.WriteString(w, `{"data":{"results":[{"eventId":"foreign","status":"accepted"},{"status":"rejected","error":{"httpStatus":400}},{"status":"rejected","error":{"httpStatus":503}}]}}`)
		} else {
			io.WriteString(w, `{"data":{"results":[{"status":"accepted"}]}}`)
		}
	}, nil)
	emitN(r, 4)
	if !r.Flush(context.Background()) {
		t.Fatal("flush")
	}
	c := r.Counters()
	if c.Recorded != 4 || c.Sent != 2 || c.Rejected != 1 || c.DroppedByCause[NoVerdict] != 1 {
		t.Fatal(c)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 || len(bodies[1]) != 1 || !bytes.Equal(bodies[0][2], bodies[1][0]) {
		t.Fatal("retry bytes or ownership changed")
	}
}
func TestResponseClassification(t *testing.T) {
	for _, tc := range []struct {
		name, body              string
		status                  int
		sent, rejected, dropped int64
	}{{"malformed", "!", 202, 0, 0, 1}, {"trailing", `{"data":{"results":[{"status":"accepted"}]}} {}`, 202, 0, 0, 1}, {"oversized", strings.Repeat(" ", 1<<20) + `{}`, 202, 0, 0, 1}, {"missing", `{"data":{}}`, 202, 0, 0, 1}, {"unknown", `{"data":{"results":[{"status":"other"}]}}`, 202, 0, 0, 1}, {"permanent", `bad`, 401, 0, 1, 0}, {"no-status", `{"data":{"results":[{"status":"rejected"}]}}`, 202, 0, 1, 0}} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
				calls.Add(1)
				w.Header().Set("Location", "http://127.0.0.1:1/stolen")
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			}, nil)
			emitN(r, 1)
			if !r.Flush(context.Background()) {
				t.Fatal("flush")
			}
			c := r.Counters()
			if calls.Load() != 1 || c.Sent != tc.sent || c.Rejected != tc.rejected || c.Dropped != tc.dropped {
				t.Fatal(c, calls.Load())
			}
		})
	}
}
func TestKnownStatusBodyTimeout(t *testing.T) {
	for _, status := range []int{202, 401} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
				calls.Add(1)
				w.WriteHeader(status)
				w.(http.Flusher).Flush()
				<-q.Context().Done()
			}, func(c *Config) { c.RequestTimeout = 20 * time.Millisecond })
			emitN(r, 1)
			if !r.Flush(context.Background()) {
				t.Fatal("flush")
			}
			c := r.Counters()
			if calls.Load() != 1 || (status == 202 && c.DroppedByCause[NoVerdict] != 1) || (status == 401 && c.Rejected != 1) {
				t.Fatal(c, calls.Load())
			}
		})
	}
}
func TestShutdownCancellationOwnsWorkersAndCounters(t *testing.T) {
	started := make(chan struct{}, 16)
	var active, peak, calls atomic.Int32
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		io.Copy(io.Discard, q.Body)
		calls.Add(1)
		n := active.Add(1)
		defer active.Add(-1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		started <- struct{}{}
		<-q.Context().Done()
	}, func(c *Config) { c.BatchSize = 1; c.MaxConcurrentSends = 2; c.RequestTimeout = time.Second })
	emitN(r, 8)
	<-started
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	begin := time.Now()
	if r.Shutdown(ctx) {
		t.Fatal("canceled shutdown unexpectedly drained")
	}
	if time.Since(begin) > 250*time.Millisecond {
		t.Fatal("shutdown unbounded")
	}
	select {
	case <-r.workersDone:
	case <-time.After(time.Second):
		t.Fatal("owned workers did not settle")
	}
	before := r.Counters()
	if before.Recorded != before.Sent+before.Rejected+before.Dropped || peak.Load() > 2 {
		t.Fatal(before, peak.Load())
	}
	if r.Shutdown(context.Background()) {
		t.Fatal("shutdown result changed")
	}
	if after := r.Counters(); after.Recorded != before.Recorded || after.Dropped != before.Dropped {
		t.Fatal("late counters")
	}
	if calls.Load() != 2 {
		t.Fatal("new sends after shutdown")
	}
}
func TestQueueOldestAndBatchBound(t *testing.T) {
	r, s := testRecorder(t, func(c *Config) { c.MaxBufferedEvents = 3; c.BatchSize = 100 })
	emitN(r, 5)
	es := flushedEvents(t, r, s)
	if len(es) != 3 || es[0]["input"] != float64(2) || r.Counters().DroppedByCause[QueueFull] != 2 {
		t.Fatal(es, r.Counters())
	}
	r2, s2 := testRecorder(t, func(c *Config) { c.BatchSize = 100 })
	emitN(r2, 201)
	es = flushedEvents(t, r2, s2)
	if len(es) != 201 {
		t.Fatal(len(es))
	}
	s2.mu.Lock()
	defer s2.mu.Unlock()
	for _, b := range s2.bodies {
		var v struct{ Events []any }
		_ = json.Unmarshal(b, &v)
		if len(v.Events) > 100 {
			t.Fatal("batch exceeds100")
		}
	}
}
func TestRefusalLogicalBudget(t *testing.T) {
	var calls atomic.Int32
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"data":{"results":[{"status":"rejected","error":{"httpStatus":503}}]}}`)
	}, func(c *Config) { c.MaxAttempts = 3; c.EventRetryMaxSends = 2; c.BreakerThreshold = 100 })
	emitN(r, 1)
	if !r.Flush(context.Background()) {
		t.Fatal("flush")
	}
	if calls.Load() != 6 || r.Counters().DroppedByCause[RetryBudget] != 1 {
		t.Fatal(calls.Load(), r.Counters())
	}
}
func TestStoppedPortAndBackoffCancellation(t *testing.T) {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	url := "http://" + l.Addr().String()
	l.Close()
	r := New(Config{Endpoint: url, APIKey: "x", Service: "s", Environment: "e", BackoffBase: time.Hour, BackoffMax: time.Hour, BatchSize: 1})
	emitN(r, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if r.Flush(ctx) {
		t.Fatal("flush drained unavailable server")
	}
	r.Shutdown(ctx)
	select {
	case <-r.workersDone:
	case <-time.After(time.Second):
		t.Fatal("backoff worker leak")
	}
}

func TestMalformedRefusalStatusIsPermanent(t *testing.T) {
	var calls atomic.Int32
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"data":{"results":[{"status":"rejected","error":{"httpStatus":"503"}}]}}`)
	}, nil)
	emitN(r, 1)
	r.Flush(context.Background())
	if c := r.Counters(); c.Rejected != 1 || c.Dropped != 0 || calls.Load() != 1 {
		t.Fatal(c)
	}
}

func TestRefusalBudgetCountsTransportFailureCycles(t *testing.T) {
	var calls atomic.Int32
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		n := calls.Add(1)
		if n == 1 {
			io.WriteString(w, `{"data":{"results":[{"status":"rejected","error":{"httpStatus":503}}]}}`)
		} else {
			w.WriteHeader(503)
		}
	}, func(c *Config) { c.MaxAttempts = 2; c.EventRetryMaxSends = 2; c.BreakerThreshold = 100 })
	emitN(r, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if !r.Flush(ctx) {
		t.Fatal("refused event exceeded logical-send bound")
	}
	if calls.Load() != 4 || r.Counters().DroppedByCause[RetryBudget] != 1 {
		t.Fatal(calls.Load(), r.Counters())
	}
}
func TestTransportDiagnosticCanShutdown(t *testing.T) {
	var recorder *Recorder
	ready := make(chan struct{})
	callbackDone := make(chan struct{})
	var once sync.Once
	recorder = transportRecorder(t, func(w http.ResponseWriter, q *http.Request) { io.Copy(io.Discard, q.Body); w.WriteHeader(503) }, func(c *Config) {
		c.MaxAttempts = 1
		c.OnDiagnostic = func(d Diagnostic) {
			if d.Kind == "transport_error" {
				<-ready
				once.Do(func() { recorder.Shutdown(context.Background()); close(callbackDone) })
			}
		}
	})
	close(ready)
	emitN(recorder, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	recorder.Flush(ctx)
	select {
	case <-callbackDone:
	case <-ctx.Done():
		t.Fatal("diagnostic shutdown waited on itself")
	}
	for _, done := range []chan struct{}{recorder.workersDone, recorder.reportsDone} {
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("SDK goroutine did not settle")
		}
	}
	c := recorder.Counters()
	if c.Recorded != c.Sent+c.Rejected+c.Dropped {
		t.Fatal(c)
	}
}
func TestConcurrentRecordFlushShutdown(t *testing.T) {
	r, _ := testRecorder(t, func(c *Config) { c.BatchSize = 7; c.MaxBufferedEvents = 30; c.MaxConcurrentSends = 3 })
	j := r.Journey(Entity{"order", "shared"})
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				j.Label("label")
				j.Record(Event{Operation: Received, Name: "racing", Input: Payload(map[string]any{"n": i})})
				if i%5 == 0 {
					ctx, cancel := context.WithCancel(context.Background())
					cancel()
					r.Flush(ctx)
				}
			}
		}()
	}
	wg.Add(1)
	go func() { defer wg.Done(); r.Shutdown(context.Background()) }()
	wg.Wait()
	r.Shutdown(context.Background())
	select {
	case <-r.workersDone:
	case <-time.After(time.Second):
		t.Fatal("workers")
	}
	c := r.Counters()
	if c.Recorded != 240 || c.Recorded != c.Sent+c.Rejected+c.Dropped {
		t.Fatal(c)
	}
	var drops int64
	for _, n := range c.DroppedByCause {
		drops += n
	}
	if drops != c.Dropped {
		t.Fatal(c)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.flushers != 0 || len(r.owned) != 0 || len(r.queue) != 0 {
		t.Fatal("ownership stranded")
	}
}
func TestLateServerAcceptanceCannotChangeFinalizedCounters(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		io.Copy(io.Discard, q.Body)
		close(started)
		<-release
		io.WriteString(w, `{"data":{"results":[{"status":"accepted"}]}}`)
	}, func(c *Config) { c.BatchSize = 1 })
	emitN(r, 1)
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r.Shutdown(ctx)
	before := r.Counters()
	close(release)
	select {
	case <-r.workersDone:
	case <-time.After(time.Second):
		t.Fatal("worker stuck")
	}
	after := r.Counters()
	if before.Sent != 0 || after.Sent != 0 || before.Dropped != 1 || after.Dropped != 1 {
		t.Fatal(before, after)
	}
}
func TestIntervalFlushAndClientOwnership(t *testing.T) {
	r, s := testRecorder(t, func(c *Config) { c.FlushInterval = 5 * time.Millisecond; c.MaxConcurrentSends = 2 })
	emitN(r, 1)
	deadline := time.After(time.Second)
	for {
		if r.Counters().Sent == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("interval ignored")
		case <-time.After(time.Millisecond):
		}
	}
	if len(flushedEvents(t, r, s)) != 1 {
		t.Fatal("event")
	}
	tr := r.transport
	if tr.Proxy != nil || tr.MaxConnsPerHost != 2 || tr.MaxIdleConns != 2 || tr.TLSHandshakeTimeout <= 0 || tr.ResponseHeaderTimeout <= 0 || r.client.Timeout <= 0 || tr.TLSClientConfig != nil && tr.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("unsafe client ownership")
	}
}

// Manual cycle ownership removes background scheduling from clock/breaker tests;
// events still use the public Journey.Record builder and real loopback HTTP.
func cycleRecorder(t *testing.T, h http.HandlerFunc) *Recorder {
	t.Helper()
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	c, _ := resolveConfig(Config{Endpoint: s.URL, APIKey: "key", Service: "s", Environment: "e", MaxAttempts: 2, BackoffBase: time.Nanosecond, BackoffMax: time.Nanosecond, BreakerThreshold: 4})
	ctx, cancel := context.WithCancel(context.Background())
	r := &Recorder{c: c, d: newDiagnostics(nil, false), owned: map[uint64]*pendingEvent{}, changed: make(chan struct{}), ctx: ctx, cancel: cancel, workersDone: make(chan struct{}), reports: make(chan Diagnostic, 64), clock: time.Now, started: true}
	r.reportsDone = make(chan struct{}) // no reporter runs here
	close(r.workersDone)
	close(r.reportsDone)
	r.client, r.transport = newHTTPClient(c)
	t.Cleanup(func() { r.Shutdown(context.Background()) })
	return r
}
func takeCycle(r *Recorder) []*pendingEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	batch := r.queue
	r.queue = nil
	return batch
}
func TestExpiryOnlyCycleLeavesBreakerUntouched(t *testing.T) {
	var calls atomic.Int32
	r := cycleRecorder(t, func(w http.ResponseWriter, q *http.Request) { calls.Add(1); w.WriteHeader(503) })
	now := time.Now()
	r.clock = func() time.Time { return now }
	r.failures = 3
	r.openedUntil = now.Add(time.Hour)
	emitN(r, 1)
	batch := takeCycle(r)
	batch[0].refusedAt = now.Add(-31 * time.Second)
	r.sendCycle(batch)
	if calls.Load() != 0 || r.failures != 3 || !r.openedUntil.Equal(now.Add(time.Hour)) || r.Counters().DroppedByCause[RetryBudget] != 1 || batch[0].refusedSends != 0 {
		t.Fatal(calls.Load(), r.failures, r.openedUntil, r.Counters())
	}
}
func TestExpiryAfterActualAttemptCountsBreakerFailure(t *testing.T) {
	var r *Recorder
	var calls atomic.Int32
	now := time.Now()
	r = cycleRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		calls.Add(1)
		r.mu.Lock()
		now = now.Add(31 * time.Second)
		r.mu.Unlock()
		w.WriteHeader(503)
	})
	r.clock = func() time.Time { return now }
	r.failures = 3
	emitN(r, 1)
	batch := takeCycle(r)
	batch[0].refusedAt = now
	r.sendCycle(batch)
	if calls.Load() != 1 || r.failures != 4 || !r.openedUntil.Equal(now.Add(r.c.BreakerReset)) || r.Counters().DroppedByCause[RetryBudget] != 1 {
		t.Fatal(calls.Load(), r.failures, r.openedUntil, r.Counters())
	}
}
func TestBreakerOutcomeRules(t *testing.T) {
	var status atomic.Int32
	status.Store(202)
	body := `{}`
	r := cycleRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		w.WriteHeader(int(status.Load()))
		io.WriteString(w, body)
	})
	emitN(r, 1)
	r.sendCycle(takeCycle(r))
	if r.failures != 1 {
		t.Fatal("no verdict failed to count", r.failures)
	}
	status.Store(401)
	emitN(r, 1)
	r.sendCycle(takeCycle(r))
	if r.failures != 1 {
		t.Fatal("4xx changed breaker", r.failures)
	}
	status.Store(202)
	body = `{"data":{"results":[{"status":"rejected","error":{"httpStatus":400}}]}}`
	emitN(r, 1)
	r.sendCycle(takeCycle(r))
	if r.failures != 0 {
		t.Fatal("permanent verdict did not reset")
	}
	r.failures = 3
	r.c.MaxAttempts = 1
	body = `{"data":{"results":[{"status":"accepted"},{"status":"rejected","error":{"httpStatus":503}}]}}`
	emitN(r, 2)
	r.sendCycle(takeCycle(r))
	if r.failures != 0 || r.Counters().Sent != 1 {
		t.Fatal("partial storage counted failure")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r.Shutdown(ctx)
}
func TestBreakerCooldownAndShutdownNoProgress(t *testing.T) {
	var calls atomic.Int32
	var first, second time.Time
	var mu sync.Mutex
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if calls.Add(1) == 1 {
			first = time.Now()
			w.WriteHeader(503)
		} else {
			second = time.Now()
			io.WriteString(w, `{"data":{"results":[{"status":"accepted"}]}}`)
		}
	}, func(c *Config) { c.MaxAttempts = 1; c.BreakerThreshold = 1; c.BreakerReset = 20 * time.Millisecond })
	emitN(r, 1)
	if !r.Flush(context.Background()) {
		t.Fatal("flush")
	}
	mu.Lock()
	elapsed := second.Sub(first)
	mu.Unlock()
	if calls.Load() != 2 || elapsed < 15*time.Millisecond {
		t.Fatal(calls.Load(), elapsed)
	}
	r2 := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) { w.WriteHeader(503) }, func(c *Config) { c.MaxAttempts = 1 })
	emitN(r2, 3)
	start := time.Now()
	if r2.Shutdown(context.Background()) {
		t.Fatal("no-progress should drop unresolved events")
	}
	if time.Since(start) > time.Second || r2.Counters().DroppedByCause[Shutdown] != 3 {
		t.Fatal(r2.Counters())
	}
}

func TestLifecycleDefaultBound(t *testing.T) {
	for _, parent := range []context.Context{nil, context.Background()} {
		ctx, cancel := lifecycleContext(parent)
		deadline, ok := ctx.Deadline()
		left := time.Until(deadline)
		cancel()
		if !ok || left <= 4*time.Second || left > 5*time.Second {
			t.Fatal("default bound", left)
		}
	}
	parent, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	ctx, stop := lifecycleContext(parent)
	defer stop()
	a, _ := parent.Deadline()
	b, _ := ctx.Deadline()
	if a != b {
		t.Fatal("deadline changed")
	}
}
func TestRefusedBatchRetainsOldestEvictionOrder(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) { close(started); <-release; w.WriteHeader(503) }, func(c *Config) { c.BatchSize = 1; c.MaxBufferedEvents = 2; c.MaxAttempts = 1 })
	emitN(r, 1)
	<-started
	emitN(r, 2)
	r.mu.Lock()
	r.openedUntil = time.Now().Add(time.Hour)
	r.mu.Unlock()
	close(release)
	deadline := time.After(time.Second)
	for r.Counters().DroppedByCause[QueueFull] != 1 {
		select {
		case <-deadline:
			t.Fatal("old refusal not evicted")
		case <-time.After(time.Millisecond):
		}
	}
	r.mu.Lock()
	if len(r.queue) != 2 || r.queue[0].sequence != 2 || r.queue[1].sequence != 3 {
		t.Error("original age not preserved")
	}
	r.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r.Shutdown(ctx)
}
func TestShutdownNoProgressBatchLeavesOtherSendsInFlight(t *testing.T) {
	var arrivals atomic.Int32
	failFirst, answerSecond := make(chan struct{}), make(chan struct{})
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		if arrivals.Add(1) == 1 {
			<-failFirst
			w.WriteHeader(503)
			return
		}
		<-answerSecond
		io.WriteString(w, `{"data":{"results":[{"status":"accepted"}]}}`)
	}, func(c *Config) { c.MaxConcurrentSends = 2; c.BatchSize = 1; c.MaxAttempts = 1 })
	emitN(r, 2)
	for deadline := time.Now().Add(2 * time.Second); arrivals.Load() < 2; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("both sends never started")
		}
	}
	result := make(chan bool, 1)
	go func() { result <- r.Shutdown(context.Background()) }()
	time.Sleep(50 * time.Millisecond) // Shutdown has closed admission
	close(failFirst)
	time.Sleep(100 * time.Millisecond) // the failed batch reports no progress
	close(answerSecond)
	if <-result {
		t.Fatal("the failed batch should leave shutdown incomplete")
	}
	c := r.Counters()
	if c.Sent != 1 || c.DroppedByCause[Shutdown] != 1 {
		t.Fatalf("one batch's no progress cancelled another's send: %+v", c)
	}
}
func TestRedirectsFollowLikeFetchAndAnUnfollowedOneIsRetried(t *testing.T) {
	var moved, stored atomic.Int32
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/v1/events/batch" {
			moved.Add(1)
			http.Redirect(w, q, "/moved/v1/events/batch", http.StatusPermanentRedirect)
			return
		}
		b, _ := io.ReadAll(q.Body)
		if q.Method != http.MethodPost || !strings.Contains(string(b), `"events"`) || q.Header.Get("Authorization") != "Bearer key" {
			t.Errorf("308 did not replay the request: %s %q", q.Method, b)
		}
		stored.Add(1)
		io.WriteString(w, `{"data":{"results":[{"status":"accepted"}]}}`)
	}, nil)
	emitN(r, 1)
	if !r.Flush(context.Background()) || r.Counters().Sent != 1 || moved.Load() != 1 || stored.Load() != 1 {
		t.Fatalf("308 not followed: %+v", r.Counters())
	}

	// Another origin (here another port) never receives the API key, as with fetch.
	var leaked atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		leaked.Store(q.Header.Get("Authorization") != "")
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(other.Close)
	r3 := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		http.Redirect(w, q, other.URL+"/v1/events/batch", http.StatusTemporaryRedirect)
	}, nil)
	emitN(r3, 1)
	if !r3.Flush(context.Background()) || r3.Counters().Rejected != 1 || leaked.Load() {
		t.Fatalf("cross-origin redirect: leaked=%v %+v", leaked.Load(), r3.Counters())
	}

	var calls atomic.Int32
	var mu sync.Mutex
	var seen []Diagnostic
	r2 := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusMultipleChoices) // a 3xx with nowhere to go
	}, func(c *Config) {
		c.MaxAttempts = 2
		c.BreakerThreshold = 1000 // keep the cleanup Shutdown off the breaker's cooldown
		c.OnDiagnostic = func(d Diagnostic) { mu.Lock(); seen = append(seen, d); mu.Unlock() }
	})
	emitN(r2, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	r2.Flush(ctx)
	c := r2.Counters()
	if calls.Load() < 2 || c.DroppedByCause[NoVerdict] != 0 || c.Dropped != 0 {
		t.Fatalf("unfollowed 3xx was not retried as a transport error: calls=%d %+v", calls.Load(), c)
	}
	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, d := range seen {
		found = found || (d.Kind == "transport_error" && d.Code == "request_failed")
	}
	if !found {
		t.Fatalf("no transport_error for an unfollowed 3xx: %+v", seen)
	}
}
func TestShutdownStopsAtOnceWhenTheBreakerIsOpen(t *testing.T) {
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) { w.WriteHeader(503) }, func(c *Config) {
		c.MaxAttempts = 1
		c.BreakerThreshold = 1
		c.BreakerReset = time.Hour
	})
	emitN(r, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	r.Flush(ctx) // the one send fails and opens the breaker
	start := time.Now()
	if r.Shutdown(context.Background()) {
		t.Fatal("an undelivered event must leave shutdown incomplete")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("shutdown waited out the breaker: %v", elapsed)
	}
	if r.Counters().DroppedByCause[Shutdown] != 1 {
		t.Fatal(r.Counters())
	}
}
func TestShutdownDeliversQueuedTransportDiagnostics(t *testing.T) {
	var calls atomic.Int32
	var mu sync.Mutex
	var seen []Diagnostic
	gate := make(chan struct{})
	var held atomic.Bool
	r := transportRecorder(t, func(w http.ResponseWriter, q *http.Request) { calls.Add(1); w.WriteHeader(503) }, func(c *Config) {
		c.MaxAttempts = 1
		c.BreakerThreshold = 3
		c.BreakerReset = time.Hour
		c.OnDiagnostic = func(d Diagnostic) {
			mu.Lock()
			seen = append(seen, d)
			mu.Unlock()
			if d.Kind == "transport_error" && held.CompareAndSwap(false, true) {
				<-gate // hold the reporter so later reports queue
			}
		}
	})
	emitN(r, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	r.Flush(ctx) // three failed sends, then the breaker opens
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelShutdown()
	r.Shutdown(shutdownCtx)
	close(gate) // the reporter's callback returns; nothing queued may be lost
	select {
	case <-r.reportsDone:
	case <-shutdownCtx.Done():
		t.Fatal("reporter did not finish")
	}
	mu.Lock()
	defer mu.Unlock()
	transport, breaker := 0, 0
	for _, d := range seen {
		switch d.Kind {
		case "transport_error":
			transport++
		case "breaker_opened":
			breaker++
		}
	}
	if int(calls.Load()) != 3 || transport != 3 || breaker != 1 {
		t.Fatalf("shutdown lost queued diagnostics: calls=%d transport_error=%d breaker_opened=%d", calls.Load(), transport, breaker)
	}
}
