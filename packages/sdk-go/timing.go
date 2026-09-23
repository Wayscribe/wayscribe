package wayscribe

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type QueueJob struct {
	QueueName, ID                            string
	TimestampMS, ProcessedOnMS, AttemptsMade *int64
}
type QueueTimingOptions struct{ ReadyAgainAtMS, DeliveryCount *int64 }
type HTTPResponse struct {
	StatusCode int
	Headers    http.Header
}
type HTTPTimingOptions struct {
	TargetURL  string
	ObservedAt *time.Time
}

const maxMS = int64(2147483647)

func bounded(n *int64, min, max int64) bool { return n != nil && *n >= min && *n <= max }

var truncationMarker = regexp.MustCompile(`\[TRUNCATED: [0-9]+ characters removed\]$`)

func timingIdentity(s string) bool {
	if !validText(s, 256, true) {
		return false
	}
	switch s {
	case redacted, uncapturable, tooLarge, "[CIRCULAR]":
		return false
	}
	return !truncationMarker.MatchString(s)
}
func QueueMetadata(job QueueJob, o QueueTimingOptions) map[string]any {
	out := map[string]any{}
	queue := timingIdentity(job.QueueName)
	if queue {
		out["queue"] = job.QueueName
	}
	if bounded(o.DeliveryCount, 1, safeInteger) {
		out["deliveryCount"] = *o.DeliveryCount
	}
	var attempt int64
	if bounded(job.AttemptsMade, 0, safeInteger-1) {
		attempt = *job.AttemptsMade + 1
		out["attempt"] = attempt
	}
	if queue && timingIdentity(job.ID) {
		b := jsonBytes([]string{job.QueueName, job.ID})
		group := "queue:" + string(b)
		if utf8.RuneCountInString(group) <= 256 {
			out["retryGroup"] = group
		}
	}
	var earlier *int64
	basis := ""
	if attempt == 1 && (!bounded(o.DeliveryCount, 1, safeInteger) || *o.DeliveryCount == 1) {
		earlier = job.TimestampMS
		basis = "initial-enqueue"
	} else if attempt > 1 {
		earlier = o.ReadyAgainAtMS
		basis = "retry-ready"
	}
	if bounded(earlier, 0, safeInteger) && bounded(job.ProcessedOnMS, 0, safeInteger) {
		diff := *job.ProcessedOnMS - *earlier
		if diff >= 0 && diff <= maxMS {
			out["queueWaitMs"] = diff
			out["queueWaitBasis"] = basis
		}
	}
	return out
}

var digitsOnly = regexp.MustCompile(`^[0-9]+$`)

func HTTPMetadata(response HTTPResponse, o HTTPTimingOptions) map[string]any {
	out := map[string]any{}
	if response.StatusCode >= 100 && response.StatusCode <= 599 {
		out["httpStatusCode"] = response.StatusCode
	}
	if u, e := parseHTTPURL(o.TargetURL); e == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && strings.IndexFunc(o.TargetURL, func(r rune) bool { return r <= 32 || r == 127 }) < 0 {
		host := strings.ToLower(u.Hostname())
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		port := u.Port()
		validPort := true
		if port != "" {
			n, e := strconv.Atoi(port)
			validPort = e == nil && n >= 0 && n <= 65535
			if validPort && !(u.Scheme == "https" && n == 443) && !(u.Scheme == "http" && n == 80) {
				host += ":" + strconv.Itoa(n)
			}
		}
		if validPort && timingIdentity(host) {
			out["targetHost"] = host
		}
	}
	headers := map[string]any{}
	for k, v := range response.Headers {
		headers[k] = v
	}
	retry := strings.TrimSpace(headerValue(headers, "retry-after"))
	if digitsOnly.MatchString(retry) {
		seconds, e := strconv.ParseInt(retry, 10, 64)
		if e == nil && seconds <= maxMS/1000 {
			out["retryAfterMs"] = seconds * 1000
		}
	} else if o.ObservedAt != nil && o.ObservedAt.UnixMilli() >= 0 && o.ObservedAt.UnixMilli() <= safeInteger {
		if date, e := http.ParseTime(retry); e == nil && strings.HasPrefix(retry, date.Weekday().String()[:3]) {
			diff := date.Sub(*o.ObservedAt).Milliseconds()
			if diff >= 0 && diff <= maxMS {
				out["retryAfterMs"] = diff
			}
		}
	}
	return out
}
