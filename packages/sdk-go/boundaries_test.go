package wayscribe

import (
	"bytes"
	"encoding/json"
	"math/big"
	"net/http"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestHeaderNameListsAndWhitespace(t *testing.T) {
	c, _ := core(t, testConfig())
	for _, v := range []any{[]any{"Authorization", "Content-Type"}, []any{[]any{"Authorization", "Content-Type"}}} {
		r := captureValue(v, c, "input")
		if !reflect.DeepEqual(r.value, v) {
			t.Fatalf("header names changed: %#v", r.value)
		}
	}
	r := captureValue("Authorization:\tsecret\r\nAccept: json\r\n\r\npassword: evidence", c, "input")
	if r.value != "Authorization:\t[REDACTED]\r\nAccept: json\r\n\r\npassword: evidence" {
		t.Fatal(r.value)
	}
}
func TestOperatorRulesFoldedAndArrayPaths(t *testing.T) {
	c := testConfig()
	c.Redact = []string{"profile.User-ID", "input.items[*].private", "items[*].opaque"}
	r, _ := resolveConfig(c)
	out := captureValue(map[string]any{"profile": map[string]any{"user_id": "hidden"}, "items": []any{map[string]any{"private": "hidden", "opaque": "hidden"}}}, r, "input")
	b := jsonBytes(out.value)
	if bytes.Contains(b, []byte("hidden")) {
		t.Fatal(string(b))
	}
	r.CaptureMode = FullPayload
	out = captureValue(map[string]any{"private": "kept", "password": "secret"}, r, "input")
	if string(jsonBytes(out.value)) != `{"password":"[REDACTED]","private":"kept"}` {
		t.Fatal(out.value)
	}
}
func TestBigIntegerRepresentationCannotLoseDigits(t *testing.T) {
	c, _ := core(t, testConfig())
	n := new(big.Int).Exp(big.NewInt(10), big.NewInt(66000), nil)
	r := captureValue(n, c, "input")
	if !r.omitted || r.truncated {
		t.Fatal("huge integer must be omitted intact")
	}
}
func TestDiagnosticsCountersCausesAndScopes(t *testing.T) {
	var seen []Diagnostic
	c := testConfig()
	c.OnDiagnostic = func(v Diagnostic) { seen = append(seen, v) }
	r, d := core(t, c)
	for i := 0; i < 2; i++ {
		buildEnvelope(r, d, "jrn_a", Entity{"type", "id"}, "", Event{Operation: Received, Name: "x", Input: Payload(map[string]any{"items": []any{map[string]any{"serviceBearer": "private"}}})})
	}
	var warnings []Diagnostic
	for _, v := range seen {
		if v.Kind == "unredacted_secret_name" {
			warnings = append(warnings, v)
		}
	}
	if len(warnings) != 1 || warnings[0].Path != "input.items[*].serviceBearer" {
		t.Fatalf("%+v", warnings)
	}
	counts := d.snapshot()
	if counts.UnredactedSecretNames != 1 || len(counts.DroppedByCause) != 5 {
		t.Fatal(counts)
	}
	for _, cause := range []DroppedCause{QueueFull, AfterShutdown, Shutdown, RetryBudget, NoVerdict} {
		if _, ok := counts.DroppedByCause[cause]; !ok {
			t.Fatal(cause)
		}
	}
}
func TestMetadataAndCodePointCaps(t *testing.T) {
	long := strings.Repeat("😀", 129)
	event := Event{Operation: Received, Name: strings.Repeat("😀", 256), Metadata: map[string]any{long: 1, "keep": 2}, Aliases: map[string]string{long: "dropped", "keep": strings.Repeat("😀", 512)}}
	b := buildTestEnvelope(t, event)
	e := eventMap(t, b)
	if e["metadata"].(map[string]any)["[KEY_TOO_LONG]"] != float64(1) || len(e["aliases"].(map[string]any)) != 1 {
		t.Fatal(e)
	}
}
func TestCaptureErrorMasksBeforeBound(t *testing.T) {
	c, d := core(t, testConfig())
	_ = c
	for _, message := range []string{"Authorization: Bearer secretvalue1234", `password="super-private"`, "postgres://user:super-private@db.internal/path", "-----BEGIN PRIVATE KEY-----" + strings.Repeat("super-private", 10000)} {
		out := captureError(ErrorInfo{Message: message, Stack: message}, d)
		raw := jsonBytes(out)
		if bytes.Contains(raw, []byte("super-private")) || bytes.Contains(raw, []byte("secretvalue1234")) {
			t.Fatal(string(raw))
		}
	}
	out := captureError(ErrorInfo{Message: "connect " + strings.Repeat("😀", 5000)}, d)
	if utf8.RuneCountInString(out["message"].(string)) != 4096 {
		t.Fatal("code point error bound")
	}
}
func TestKnownTimingZeroAndUnknown(t *testing.T) {
	for _, job := range []QueueJob{{QueueName: "[REDACTED]", ID: "id"}, {QueueName: "q", ID: strings.Repeat("x", 256)}} {
		out := QueueMetadata(job, QueueTimingOptions{})
		if _, ok := out["retryGroup"]; ok {
			t.Fatal(out)
		}
		if _, ok := out["queueWaitMs"]; ok {
			t.Fatal(out)
		}
	}
	job := QueueJob{QueueName: "q", ID: "id", ProcessedOnMS: ptr(10), TimestampMS: ptr(11), AttemptsMade: ptr(0)}
	if _, ok := QueueMetadata(job, QueueTimingOptions{})["queueWaitMs"]; ok {
		t.Fatal("negative clamped")
	}
	out := HTTPMetadata(HTTPResponse{StatusCode: 200, Headers: http.Header{"Retry-After": []string{"0"}}}, HTTPTimingOptions{})
	if out["retryAfterMs"] != int64(0) {
		t.Fatal(out)
	}
	out = HTTPMetadata(HTTPResponse{Headers: http.Header{"Retry-After": []string{"Mon, 21 Sep 2026 12:00:00 GMT"}}}, HTTPTimingOptions{})
	if _, ok := out["retryAfterMs"]; ok {
		t.Fatal("invented observation")
	}
	at := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	for _, date := range []string{"Tue, 21 Sep 2026 12:00:02 GMT", "Mon, 31 Feb 2026 12:00:02 GMT"} {
		if _, ok := HTTPMetadata(HTTPResponse{Headers: http.Header{"Retry-After": []string{date}}}, HTTPTimingOptions{ObservedAt: &at})["retryAfterMs"]; ok {
			t.Fatal(date)
		}
	}
}
func TestNativeHTTPAndPayloadAbsence(t *testing.T) {
	c := ExtractHTTPContext(http.Header{"X-Wayscribe-Journey-Id": []string{"jrn_one", "jrn_two"}})
	if c == nil || c.JourneyID != "jrn_one" {
		t.Fatal(c)
	}
	headers := map[string]any{"x-wayscribe-journey-id": 42, "X-Wayscribe-Journey-Id": "jrn_valid"}
	if ExtractHTTPContext(headers) != nil {
		t.Fatal("canonical malformed key must win")
	}
	out := InjectHTTPHeaders(Context{JourneyID: "jrn_a", Entity: &Entity{"order", "42"}}, headers, "")
	if out["x-wayscribe-entity-id"] != nil || len(headers) != 2 {
		t.Fatal(out)
	}
	v, _ := ExtractPayload(map[string]any{"_wayscribe": nil})
	if _, ok := v.Get(); ok {
		t.Fatal("invented null")
	}
	v, _ = ExtractPayload(nil)
	if x, ok := v.Get(); !ok || x != nil {
		t.Fatal("lost body")
	}
	if !HasJourney(map[string]any{"_wayscribe": map[string]any{"journeyId": "not-valid"}}) {
		t.Fatal("structural guard")
	}
}
func TestDeepRepresentationAndEmptyContainers(t *testing.T) {
	c, _ := core(t, testConfig())
	var v any = []byte{1}
	for i := 0; i < 30; i++ {
		v = []any{v}
	}
	if !captureValue(v, c, "input").omitted {
		t.Fatal("bytes representation exceeded depth")
	}
	for _, v := range []any{map[string]any{}, []any{}} {
		r := captureValue(v, c, "input")
		b, _ := json.Marshal(r.value)
		if string(b) != "{}" && string(b) != "[]" {
			t.Fatal(string(b))
		}
	}
}

type ConnectionError struct{}

func (ConnectionError) Error() string { return "connection refused" }

type panickingError struct{}

func (panickingError) Error() string { panic("host panic") }
func TestExplicitErrorTypeAndPanic(t *testing.T) {
	_, d := core(t, testConfig())
	out := captureError(*hostError(ConnectionError{}), d)
	if out["type"] != "ConnectionError" || out["message"] != "connection refused" {
		t.Fatal(out)
	}
	if hostError(panickingError{}).Message != "[UNCAPTURABLE]" {
		t.Fatal("panic escaped")
	}
	out = captureError(ErrorInfo{Message: "m", Type: strings.Repeat("😀", 300)}, d)
	if utf8.RuneCountInString(out["type"].(string)) != 256 {
		t.Fatal(out)
	}
}
func TestCaptureSnapshotMetadataEvidence(t *testing.T) {
	c, d := core(t, testConfig())
	metadata := captureMetadata(map[string]any{"note": strings.Repeat("x", 70000)}, c, d)
	e := Event{Operation: Received, Name: "x", Attempt: 2, metadataCapture: &metadata}
	b := buildEnvelope(c, d, "jrn_a", Entity{"order", "42"}, "", e)
	if b == nil || d.snapshot().PayloadsTruncated != 1 {
		t.Fatal("lost metadata evidence")
	}
	if _, ok := metadata.value.(map[string]any)["attempt"]; ok {
		t.Fatal("snapshot mutated")
	}
}
func TestAnyDepthRulesAndHeaderPaths(t *testing.T) {
	c := testConfig()
	c.Redact = []string{"**.sessionCredential"}
	r, d := core(t, c)
	b := buildEnvelope(r, d, "jrn_a", Entity{"order", "42"}, "", Event{Operation: Received, Name: "x", Input: Payload(map[string]any{"nested": map[string]any{"Session_Credential": "sentinel"}, "headers": []any{[]any{"sessionCredential", "sentinel"}}})})
	if bytes.Contains(b, []byte("sentinel")) {
		t.Fatal(string(b))
	}
}
func TestConfigEndpointAndInsecureReport(t *testing.T) {
	for _, endpoint := range []string{"https://localhost:99999", "https://localhost:bad", "https://localhost/?dryRun=true", "https://user:pass@localhost"} {
		c := testConfig()
		c.Endpoint = endpoint
		r, _ := resolveConfig(c)
		if r.enabled {
			t.Fatal(endpoint)
		}
	}
	c := testConfig()
	c.Endpoint = "http://localhost:9876"
	r, issues := resolveConfig(c)
	found := false
	for _, issue := range issues {
		found = found || issue.Kind == "insecure_endpoint"
	}
	if !r.enabled || !found {
		t.Fatal("insecure endpoint must report and start")
	}
}
func TestPublicWarningsProcessScope(t *testing.T) {
	processWarnings.Lock()
	processWarnings.seen = map[string]bool{}
	processWarnings.Unlock()
	var reports []Diagnostic
	d := newDiagnostics(func(v Diagnostic) { reports = append(reports, v) }, false)
	for _, v := range []string{"node_modules/@scope/tool.js", "git@host:org/repo.git", "2026-09-21 +0000", "Received +12345678 bytes"} {
		publicWarning(v, "error", d)
	}
	if len(reports) != 0 {
		t.Fatal(reports)
	}
	for _, field := range []string{"journey_label", "displayable_alias", "error"} {
		publicWarning("ada@example.com", field, d)
		publicWarning("next@example.com", field, d)
		publicWarning("phone=+19195551234", field, d)
	}
	if len(reports) != 6 {
		t.Fatal(reports)
	}
	d2 := newDiagnostics(func(v Diagnostic) { t.Fatal("process warning duplicated") }, false)
	publicWarning("ada@example.com", "journey_label", d2)
}
func TestFittingDropsLargerThenMetadataAndNoOmittedWarnings(t *testing.T) {
	c := testConfig()
	c.MaxEventBytes = 700
	var reports []Diagnostic
	c.OnDiagnostic = func(v Diagnostic) { reports = append(reports, v) }
	r, d := core(t, c)
	b := buildEnvelope(r, d, "jrn_a", Entity{"order", "42"}, "", Event{Operation: Received, Name: "x", Input: Payload(strings.Repeat("a", 100)), Output: Payload(map[string]any{"authToken": strings.Repeat("b", 1000)}), Metadata: map[string]any{"note": strings.Repeat("c", 1000)}})
	e := eventMap(t, b)
	if e["output"] != tooLarge || e["input"] != tooLarge {
		t.Fatal(e)
	}
	if _, ok := e["metadata"]; ok {
		t.Fatal("metadata kept")
	}
	if d.snapshot().PayloadsOmitted != 3 {
		t.Fatal(d.snapshot())
	}
	for _, v := range reports {
		if v.Kind == "unredacted_secret_name" {
			t.Fatal("omitted field warned")
		}
	}
}
func TestMetadataSnapshotReuseDifferentAttempts(t *testing.T) {
	c, d := core(t, testConfig())
	nested := map[string]any{"value": "before"}
	meta := captureMetadata(map[string]any{"nested": nested, "note": strings.Repeat("x", 70000)}, c, d)
	nested["value"] = "after"
	first := buildEnvelope(c, d, "jrn_a", Entity{"order", "42"}, "", Event{Operation: Received, Name: "x", Attempt: 2, metadataCapture: &meta})
	second := buildEnvelope(c, d, "jrn_b", Entity{"order", "43"}, "", Event{Operation: Received, Name: "x", Attempt: 3, metadataCapture: &meta})
	for i, b := range [][]byte{first, second} {
		m := eventMap(t, b)["metadata"].(map[string]any)
		if m["attempt"] != float64(i+2) || m["nested"].(map[string]any)["value"] != "before" {
			t.Fatal(m)
		}
	}
	if d.snapshot().PayloadsTruncated != 2 {
		t.Fatal(d.snapshot())
	}
	if _, ok := meta.value.(map[string]any)["attempt"]; ok {
		t.Fatal("capture changed")
	}
}
func TestTimingRetryIdentityExactJSON(t *testing.T) {
	m := QueueMetadata(QueueJob{QueueName: "a&b", ID: "<42>"}, QueueTimingOptions{})
	if m["retryGroup"] != `queue:["a&b","<42>"]` {
		t.Fatal(m)
	}
}

func TestLargeTextRepairAllocationsBounded(t *testing.T) {
	c, _ := core(t, testConfig())
	s := strings.Repeat("x\x00", 4*1024*1024)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	r := captureValue(s, c, "input")
	runtime.ReadMemStats(&after)
	if !r.truncated {
		t.Fatal("not truncated")
	}
	if delta := after.TotalAlloc - before.TotalAlloc; delta > 2*1024*1024 {
		t.Fatalf("capture copied oversized source: %d bytes allocated", delta)
	}
}
func TestNestedLargeTextWarningDiscoveryBounded(t *testing.T) {
	c, _ := core(t, testConfig())
	s := strings.Repeat("X", 4*1024*1024)
	input := map[string]any{"normal": s}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	r := captureValue(input, c, "input")
	runtime.ReadMemStats(&after)
	if !r.truncated {
		t.Fatal("not truncated")
	}
	if delta := after.TotalAlloc - before.TotalAlloc; delta > 2*1024*1024 {
		t.Fatalf("warning discovery copied source: %d", delta)
	}
}
func TestPositionalWarningPaths(t *testing.T) {
	c, _ := core(t, testConfig())
	for _, tc := range []struct {
		v    any
		want string
	}{{map[string]any{"raw": "authToken: private\r\nHost: example.com"}, "input.raw"}, {map[string]any{"headers": []any{"authToken", "private"}}, "input.headers[*]"}, {map[string]any{"headers": []any{map[string]any{"name": "authToken", "value": "private"}}}, "input.headers[*]"}} {
		r := captureValue(tc.v, c, "input")
		if len(r.names) != 1 || r.names[0].Path != tc.want {
			t.Fatalf("got %+v want %s", r.names, tc.want)
		}
	}
}
func TestHTTPInvalidIdentityAndObservationIndependent(t *testing.T) {
	for _, target := range []string{"https://[REDACTED]", "https://[UNCAPTURABLE]", "https://[PAYLOAD_TOO_LARGE]", "https://[CIRCULAR]"} {
		m := HTTPMetadata(HTTPResponse{StatusCode: 429, Headers: http.Header{"Retry-After": []string{"0"}}}, HTTPTimingOptions{TargetURL: target})
		if _, ok := m["targetHost"]; ok {
			t.Fatal(m)
		}
		if m["retryAfterMs"] != int64(0) || m["httpStatusCode"] != 429 {
			t.Fatal(m)
		}
	}
	at := time.Unix(-2, 0)
	m := HTTPMetadata(HTTPResponse{Headers: http.Header{"Retry-After": []string{"Thu, 01 Jan 1970 00:00:00 GMT"}}}, HTTPTimingOptions{ObservedAt: &at})
	if _, ok := m["retryAfterMs"]; ok {
		t.Fatal("invalid observation clock")
	}
}
func TestOperatorRuleCanReplaceArrayElement(t *testing.T) {
	c := testConfig()
	c.Redact = []string{"input.items[*]"}
	r, _ := resolveConfig(c)
	out := captureValue(map[string]any{"items": []any{map[string]any{"public": "hidden"}, "hidden"}}, r, "input")
	if string(jsonBytes(out.value)) != `{"items":["[REDACTED]","[REDACTED]"]}` {
		t.Fatal(out.value)
	}
}
