package wayscribe

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"strings"
	"time"
)

func newHTTPClient(c resolvedConfig) (*http.Client, *http.Transport) {
	tr := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: c.RequestTimeout, KeepAlive: 30 * time.Second}).DialContext, TLSHandshakeTimeout: c.RequestTimeout, ResponseHeaderTimeout: c.RequestTimeout, ExpectContinueTimeout: c.RequestTimeout, IdleConnTimeout: 30 * time.Second, MaxConnsPerHost: c.MaxConcurrentSends, MaxIdleConnsPerHost: c.MaxConcurrentSends, MaxIdleConns: c.MaxConcurrentSends, MaxResponseHeaderBytes: 1 << 20}
	// Redirects are followed as fetch follows them in the Node SDK: 307/308
	// replay the POST, at most 20 hops, and the API key goes only to the
	// endpoint's own origin. A 3xx that is not followed is a failed request.
	return &http.Client{Transport: tr, Timeout: c.RequestTimeout, CheckRedirect: func(next *http.Request, via []*http.Request) error {
		if len(via) >= 20 {
			return errors.New("stopped after 20 redirects")
		}
		if first := via[0].URL; next.URL.Scheme != first.Scheme || next.URL.Host != first.Host {
			next.Header.Del("Authorization") // fetch keeps credentials to one origin
		}
		return nil
	}}, tr
}
func (r *Recorder) request(batch []*pendingEvent) (int, []byte) {
	var body bytes.Buffer
	body.WriteString(`{"events":[`)
	for i, e := range batch {
		if i > 0 {
			body.WriteByte(',')
		}
		body.Write(e.body)
	}
	body.WriteString(`]}`)
	req, err := http.NewRequestWithContext(r.ctx, http.MethodPost, strings.TrimRight(r.c.Endpoint, "/")+"/v1/events/batch", bytes.NewReader(body.Bytes()))
	if err != nil {
		return 0, nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.c.APIKey)
	response, err := r.client.Do(req)
	if err != nil {
		return 0, nil
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return response.StatusCode, nil
	}
	return response.StatusCode, data
}
func responseResults(body []byte) []json.RawMessage {
	var result struct {
		Data struct {
			Results []json.RawMessage `json:"results"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &result) != nil {
		return nil
	}
	return result.Data.Results
}
func verdict(raw json.RawMessage) (string, bool) {
	var v map[string]json.RawMessage
	if json.Unmarshal(raw, &v) != nil {
		return "", false
	}
	var status string
	if json.Unmarshal(v["status"], &status) != nil {
		return "", false
	}
	if status == "accepted" {
		return "sent", false
	}
	if status != "rejected" {
		return "", false
	}
	var errFields map[string]json.RawMessage
	var code float64
	if json.Unmarshal(v["error"], &errFields) == nil {
		_ = json.Unmarshal(errFields["httpStatus"], &code)
	}
	return "rejected", code >= 500
}

func backoff(c resolvedConfig, attempt int) time.Duration {
	cap := min(c.BackoffBase, c.BackoffMax)
	for i := 1; i < attempt && cap < c.BackoffMax; i++ {
		if cap > c.BackoffMax/2 {
			cap = c.BackoffMax
		} else {
			cap *= 2
		}
	}
	if cap <= 1 {
		return cap
	}
	return time.Duration(rand.Int64N(int64(cap)))
}

// sendCycle owns one logical send, with up to MaxAttempts HTTP attempts. Refusal
// sends count once per cycle; the first refusal clock is monotonic, and checked
// again after every backoff/breaker wait. Network runs without recorder locks.
func (r *Recorder) sendCycle(batch []*pendingEvent) {
	stored, answered, permanent, attempted, abandoned := false, false, false, false, false
	attemptedEvents := map[uint64]bool{}
	initial := len(batch)
	for attempt := 0; attempt < r.c.MaxAttempts; attempt++ {
		if attempt > 0 && !waitContext(r.ctx, backoff(r.c, attempt)) {
			return
		}
		r.mu.Lock()
		if r.finished {
			r.mu.Unlock()
			return
		}
		now := r.clock()
		pending := make([]*pendingEvent, 0, len(batch))
		for _, e := range batch {
			if r.owned[e.sequence] == nil {
				continue
			}
			if !e.refusedAt.IsZero() && now.Sub(e.refusedAt) >= r.c.EventRetryBudget {
				r.settleLocked(e, "", RetryBudget)
				abandoned = true
				r.report(Diagnostic{Kind: "dropped", Code: string(RetryBudget)})
			} else {
				pending = append(pending, e)
			}
		}
		r.signalLocked()
		r.mu.Unlock()
		if len(pending) == 0 {
			break
		}
		if r.ctx.Err() != nil {
			return
		}
		attempted = true
		for _, e := range pending {
			attemptedEvents[e.sequence] = true
		}
		status, body := r.request(pending)
		r.mu.Lock()
		if r.finished {
			r.mu.Unlock()
			return
		}
		if status >= 400 && status < 500 {
			permanent = true
			for _, e := range pending {
				r.settleLocked(e, "rejected", "")
			}
		} else if status >= 200 && status < 300 {
			results := responseResults(body)
			for i, e := range pending {
				var raw json.RawMessage
				if i < len(results) {
					raw = results[i]
				}
				outcome, transient := verdict(raw)
				switch outcome {
				case "sent":
					stored = true
					answered = true
					r.settleLocked(e, "sent", "")
				case "rejected":
					answered = true
					if transient {
						if e.refusedAt.IsZero() {
							e.refusedAt = r.clock()
						}
					} else {
						r.settleLocked(e, "rejected", "")
					}
				default:
					r.settleLocked(e, "", NoVerdict)
					r.report(Diagnostic{Kind: "dropped", Code: string(NoVerdict)})
				}
			}
		}
		remaining := false
		for _, e := range batch {
			if r.owned[e.sequence] != nil {
				remaining = true
				break
			}
		}
		r.signalLocked()
		r.mu.Unlock()
		if permanent || !remaining {
			break
		}
	}
	r.mu.Lock()
	if r.finished {
		r.mu.Unlock()
		return
	}
	remaining := 0
	for _, e := range batch {
		if r.owned[e.sequence] == nil {
			continue
		}
		if !e.refusedAt.IsZero() && attemptedEvents[e.sequence] {
			e.refusedSends++
			if e.refusedSends >= r.c.EventRetryMaxSends || r.clock().Sub(e.refusedAt) >= r.c.EventRetryBudget {
				abandoned = true
				r.settleLocked(e, "", RetryBudget)
				r.report(Diagnostic{Kind: "dropped", Code: string(RetryBudget)})
				continue
			}
		}
		remaining++
	}
	if stored {
		r.failures = 0
		if !r.delivered {
			// Once per recorder: the only sign of health that silence is not.
			r.delivered = true
			r.report(Diagnostic{Kind: "delivered_first", Code: "first_delivery"})
		}
	} else if attempted && !permanent {
		if answered && remaining == 0 && !abandoned {
			r.failures = 0
		} else {
			r.failures++
			if r.failures >= r.c.BreakerThreshold {
				r.openedUntil = r.clock().Add(r.c.BreakerReset)
				r.report(Diagnostic{Kind: "breaker_opened", Code: "consecutive_failures"})
			}
		}
	}
	r.requeueLocked(batch)
	r.nextSend = r.clock().Add(r.c.FlushInterval)
	if r.closing && remaining > 0 && initial == remaining {
		// No progress: start no more batches, but let sends already in flight
		// on other workers finish; the last one to return finalizes.
		r.stalled = true
	}
	r.signalLocked()
	r.mu.Unlock()
	if remaining > 0 {
		r.report(Diagnostic{Kind: "transport_error", Code: "request_failed"})
	}
}
