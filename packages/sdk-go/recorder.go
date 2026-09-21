package wayscribe

import (
	"context"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Recorder must not be copied after first use. Its zero value is disabled.
// Queue/accounting locks never cover capture, callbacks or network operations.
type Recorder struct {
	c                         resolvedConfig
	d                         *diagnostics
	mu                        sync.Mutex
	queue                     []*pendingEvent
	owned                     map[uint64]*pendingEvent
	sequence                  uint64
	changed                   chan struct{}
	closing, finished, result bool
	flushers                  int
	nextSend                  time.Time
	failures                  int
	openedUntil               time.Time
	ctx                       context.Context
	cancel                    context.CancelFunc
	client                    *http.Client
	transport                 *http.Transport
	workersDone, reportsDone  chan struct{}
	reports                   chan Diagnostic
	clock                     func() time.Time // read under mu; production time carries monotonic time
}
type pendingEvent struct {
	body         []byte
	sequence     uint64
	refusedAt    time.Time
	refusedSends int
}

func New(c Config) *Recorder {
	resolved, issues := resolveConfig(c)
	r := &Recorder{c: resolved, d: newDiagnostics(c.OnDiagnostic, c.LogDiagnostics), owned: map[uint64]*pendingEvent{}, changed: make(chan struct{}), workersDone: make(chan struct{}), reportsDone: make(chan struct{}), reports: make(chan Diagnostic, 64), clock: time.Now}
	r.ctx, r.cancel = context.WithCancel(context.Background())
	r.nextSend = r.clock().Add(r.c.FlushInterval)
	if r.c.enabled {
		r.client, r.transport = newHTTPClient(r.c)
		var wg sync.WaitGroup
		for i := 0; i < r.c.MaxConcurrentSends; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); r.worker() }()
		}
		go func() { wg.Wait(); close(r.workersDone) }()
		go func() {
			defer close(r.reportsDone)
			for {
				select {
				case <-r.ctx.Done():
					return
				case d := <-r.reports:
					r.d.emit(d)
				}
			}
		}()
	} else {
		close(r.workersDone)
		close(r.reportsDone)
	}
	for _, issue := range issues {
		if issue.Kind == "invalid_config" {
			r.d.rejectSetting(issue.Field, issue.Code)
		} else {
			r.d.emit(issue)
		}
	}
	return r
}
func (r *Recorder) Counters() Counters {
	if r == nil || r.d == nil {
		return newDiagnostics(nil, false).snapshot()
	}
	return r.d.snapshot()
}
func (r *Recorder) RejectedSettings() []string {
	if r == nil || r.d == nil {
		return []string{}
	}
	return r.d.rejectedSettings()
}
func (r *Recorder) signalLocked() { close(r.changed); r.changed = make(chan struct{}) }
func (r *Recorder) enqueue(body []byte) {
	var cause DroppedCause
	r.mu.Lock()
	r.d.increment("recorded")
	if r.closing || r.finished {
		cause = AfterShutdown
		r.d.drop(cause)
	} else {
		r.sequence++
		e := &pendingEvent{body: body, sequence: r.sequence}
		r.owned[e.sequence] = e
		r.queue = append(r.queue, e)
		if len(r.queue) > r.c.MaxBufferedEvents {
			old := r.queue[0]
			r.queue = r.queue[1:]
			r.settleLocked(old, "", QueueFull)
			cause = QueueFull
		}
		r.signalLocked()
	}
	r.mu.Unlock()
	if cause != "" {
		r.d.emit(Diagnostic{Kind: "dropped", Code: string(cause)})
	}
}
func (r *Recorder) settleLocked(e *pendingEvent, outcome string, cause DroppedCause) {
	if _, ok := r.owned[e.sequence]; !ok {
		return
	}
	delete(r.owned, e.sequence)
	if cause != "" {
		r.d.drop(cause)
	} else {
		r.d.increment(outcome)
	}
}
func lifecycleContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Deadline(); ok {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, 5*time.Second)
}

// Flush waits for work admitted before this call to reach terminal accounting.
// Without a deadline (including nil), its upper bound is five seconds.
// True includes rejected/dropped work; inspect Counters for delivery outcomes.
func (r *Recorder) Flush(ctx context.Context) bool {
	if r == nil || r.d == nil {
		return true
	}
	ctx, cancel := lifecycleContext(ctx)
	defer cancel()
	r.mu.Lock()
	target := r.sequence
	r.flushers++
	r.signalLocked()
	defer func() { r.flushers--; r.signalLocked(); r.mu.Unlock() }()
	for {
		if r.finished {
			return r.result
		}
		pending := false
		for seq := range r.owned {
			if seq <= target {
				pending = true
				break
			}
		}
		if !pending {
			return true
		}
		if ctx.Err() != nil {
			return false
		}
		changed := r.changed
		r.mu.Unlock()
		select {
		case <-ctx.Done():
		case <-changed:
		}
		r.mu.Lock()
	}
}

// Shutdown closes admission and drains until empty, a send makes no progress,
// or ctx expires. It then cancels requests/backoff and finalizes remaining events
// once. Bytes already transmitted cannot be retracted. Repeated calls return the
// first result. Without a deadline (including nil), the bound is five seconds.
func (r *Recorder) Shutdown(ctx context.Context) bool {
	if r == nil || r.d == nil {
		return true
	}
	ctx, cancel := lifecycleContext(ctx)
	defer cancel()
	r.mu.Lock()
	r.closing = true
	r.signalLocked()
	for !r.finished && len(r.owned) > 0 && ctx.Err() == nil {
		changed := r.changed
		r.mu.Unlock()
		select {
		case <-ctx.Done():
		case <-changed:
		}
		r.mu.Lock()
	}
	if !r.finished {
		r.finalizeLocked()
	}
	result := r.result
	r.mu.Unlock()
	if r.transport != nil {
		r.transport.CloseIdleConnections()
	}
	// Sender workers own no application callbacks, so a diagnostic may reenter
	// Shutdown without a worker waiting on itself. Cancellation never adds waiters.
	select {
	case <-r.workersDone:
	case <-ctx.Done():
	}
	return result
}
func (r *Recorder) finalizeLocked() {
	if r.finished {
		return
	}
	r.result = len(r.owned) == 0
	r.finished = true
	r.closing = true
	r.cancel()
	for _, e := range r.owned {
		r.settleLocked(e, "", Shutdown)
	}
	r.queue = nil
	r.signalLocked()
}
func (r *Recorder) report(d Diagnostic) {
	select {
	case r.reports <- d:
	default:
	}
}
func (r *Recorder) requeueLocked(batch []*pendingEvent) {
	for _, e := range batch {
		if r.owned[e.sequence] != nil {
			r.queue = append(r.queue, e)
		}
	}
	sort.Slice(r.queue, func(i, j int) bool { return r.queue[i].sequence < r.queue[j].sequence })
	for len(r.queue) > r.c.MaxBufferedEvents {
		e := r.queue[0]
		r.queue = r.queue[1:]
		r.settleLocked(e, "", QueueFull)
		r.report(Diagnostic{Kind: "dropped", Code: string(QueueFull)})
	}
}
func waitContext(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
func (r *Recorder) worker() {
	defer func() {
		if recover() != nil {
			r.mu.Lock()
			r.finalizeLocked()
			r.mu.Unlock()
		}
	}()
	for {
		r.mu.Lock()
		if r.finished {
			r.mu.Unlock()
			return
		}
		now := r.clock()
		ready := len(r.queue) > 0 && (len(r.queue) >= r.c.BatchSize || r.flushers > 0 || r.closing || !now.Before(r.nextSend))
		delay := r.c.FlushInterval
		if now.Before(r.openedUntil) {
			ready = false
			delay = r.openedUntil.Sub(now)
		} else if !r.openedUntil.IsZero() {
			r.openedUntil = time.Time{}
			r.failures = 0
		}
		if ready {
			n := min(len(r.queue), r.c.BatchSize)
			batch := append([]*pendingEvent(nil), r.queue[:n]...)
			r.queue = r.queue[n:]
			r.mu.Unlock()
			r.sendCycle(batch)
			continue
		}
		if len(r.queue) > 0 && now.Before(r.nextSend) && r.openedUntil.IsZero() {
			delay = r.nextSend.Sub(now)
		}
		changed := r.changed
		r.mu.Unlock()
		timer := time.NewTimer(delay)
		select {
		case <-r.ctx.Done():
			timer.Stop()
			return
		case <-changed:
			timer.Stop()
		case <-timer.C:
		}
	}
}
