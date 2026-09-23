package wayscribe

import (
	"bytes"
	"encoding/json"
	"math"
	"math/big"
	"net/http"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
)

func testConfig() Config {
	return Config{Endpoint: "https://localhost:9999", APIKey: "test", Service: "test", Environment: "local"}
}
func core(t *testing.T, c Config) (resolvedConfig, *diagnostics) {
	t.Helper()
	r, issues := resolveConfig(c)
	d := newDiagnostics(c.OnDiagnostic, c.LogDiagnostics)
	for _, i := range issues {
		if i.Kind == "configuration_error" {
			d.rejectSetting(i.Field, i.Code)
		} else {
			d.emit(i)
		}
	}
	return r, d
}
func buildTestEnvelope(t *testing.T, e Event) []byte {
	t.Helper()
	c, d := core(t, testConfig())
	b := buildEnvelope(c, d, "jrn_test", Entity{"order", "42"}, "", e)
	if b == nil {
		t.Fatal("refused")
	}
	return b
}
func eventMap(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var x map[string]any
	if err := json.Unmarshal(b, &x); err != nil {
		t.Fatal(err)
	}
	return x["event"].(map[string]any)
}
func TestConfigDefaultsIsolation(t *testing.T) {
	c := testConfig()
	c.Redact = []string{"private"}
	c.Deployment = map[string]string{"version": "v1", "image": strings.Repeat("x", 513)}
	r, issues := resolveConfig(c)
	c.Redact[0] = "mutated"
	c.Deployment["version"] = "v2"
	if !r.enabled || r.Redact[0] != "private" || r.Deployment["version"] != "v1" || r.BatchSize != 50 || r.MaxConcurrentSends != 4 || r.Propagation != JourneyAndType || r.FlushInterval != time.Second {
		t.Fatalf("bad defaults/isolation")
	}
	if len(issues) != 1 || issues[0].Field != "Deployment.image" {
		t.Fatalf("%v", issues)
	}
	c = testConfig()
	c.Endpoint = " "
	c.MaxAttempts = -1
	c.BatchSize = 999
	r, issues = resolveConfig(c)
	if r.enabled || r.MaxAttempts != 3 || r.BatchSize != 100 || len(issues) != 3 {
		t.Fatal("invalid settings not isolated")
	}
}
func TestCaptureDetachedRedacted(t *testing.T) {
	input := map[string]any{"nested": map[string]any{"API_KEY": "sentinel", "name": "Ada"}}
	wire := buildTestEnvelope(t, Event{Operation: Received, Name: "receive", Input: Payload(input)})
	input["nested"].(map[string]any)["name"] = "changed"
	if bytes.Contains(wire, []byte("sentinel")) {
		t.Fatal("secret entered envelope")
	}
	got := eventMap(t, wire)["input"].(map[string]any)["nested"]
	want := map[string]any{"API_KEY": "[REDACTED]", "name": "Ada"}
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
}
func TestPresenceAndRepresentations(t *testing.T) {
	b := buildTestEnvelope(t, Event{Operation: Received, Name: "x", Output: Payload(nil)})
	e := eventMap(t, b)
	if _, ok := e["input"]; ok {
		t.Fatal("invented input")
	}
	if v, ok := e["output"]; !ok || v != nil {
		t.Fatal("lost null")
	}
	c, _ := core(t, testConfig())
	r := captureValue(map[string]any{"bytes": []byte{0, 255}, "big": *new(big.Int).Lsh(big.NewInt(1), 64), "n": int64(9007199254740992), "nan": math.NaN(), "text": "a\x00b\xff"}, c, "input")
	want := map[string]any{"bytes": map[string]any{"type": "bytes", "base64": "AP8="}, "big": "18446744073709551616", "n": "9007199254740992", "nan": nil, "text": "ab�"}
	if !reflect.DeepEqual(r.value, want) {
		t.Fatalf("%#v", r.value)
	}
}

type hostile struct {
	Public string `json:"visible"`
	hidden string
}

func (hostile) MarshalJSON() ([]byte, error) { panic("must not run") }
func (hostile) String() string               { panic("must not run") }
func TestHostileSharedCycleLimits(t *testing.T) {
	c, _ := core(t, testConfig())
	shared := map[string]any{"v": 1}
	loop := map[string]any{}
	loop["self"] = loop
	r := captureValue([]any{hostile{Public: "ok"}, shared, shared, loop}, c, "input")
	b, _ := json.Marshal(r.value)
	if string(b) != `[{"visible":"ok"},{"v":1},{"v":1},{"self":"[CIRCULAR]"}]` {
		t.Fatal(string(b))
	}
	wide := make(map[string]any, 1001)
	for i := 0; i < 1001; i++ {
		wide[strings.Repeat("a", i+1)] = 1
	}
	if !captureValue(wide, c, "input").omitted {
		t.Fatal("width")
	}
	var deep any = "leaf"
	for i := 0; i < 32; i++ {
		deep = []any{deep}
	}
	if !captureValue(deep, c, "input").omitted {
		t.Fatal("depth")
	}
}
func TestAllSecretsAndHeaders(t *testing.T) {
	names := strings.Fields("authorization proxy-authorization cookie set-cookie x-api-key password access_token refresh_token client_secret api_key secret stripe-signature x-hub-signature x-hub-signature-256 x-slack-signature x-hubspot-signature x-hubspot-signature-v3 x-twilio-signature x-shopify-hmac-sha256")
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			for _, v := range []any{map[string]any{name: "sentinel"}, []any{[]any{name, "sentinel"}}, []any{map[string]any{"name": name, "value": "sentinel"}}, []any{map[string]any{"name": 12, "key": name, "value": "sentinel"}}, []any{"Accept", "json", name, "sentinel"}, "Accept: json\r\n" + name + ": sentinel"} {
				wire := buildTestEnvelope(t, Event{Operation: Received, Name: "x", Input: Payload(v)})
				if bytes.Contains(wire, []byte("sentinel")) {
					t.Fatal(string(wire))
				}
			}
		})
	}
}
func TestLimitsRedactionBeforeTruncation(t *testing.T) {
	c, d := core(t, testConfig())
	r := captureValue(strings.Repeat("😀", 40000), c, "input")
	s := r.value.(string)
	if !r.truncated || len(utf16.Encode([]rune(s))) != 65536 || !strings.Contains(s, "[TRUNCATED: ") {
		t.Fatal("UTF16 limit")
	}
	b := buildEnvelope(c, d, "jrn_test", Entity{"order", "42"}, "", Event{Operation: Received, Name: "x", Input: Payload(map[string]any{"password": strings.Repeat("a", 70000)})})
	if b == nil || d.snapshot().PayloadsTruncated != 0 {
		t.Fatal("redaction must precede truncation")
	}
	c.MaxEventBytes = 1000
	b = buildEnvelope(c, d, "jrn_test", Entity{"order", "42"}, "", Event{Operation: Received, Name: "x", Input: Payload(strings.Repeat("a", 70000)), Output: Payload("small"), Metadata: map[string]any{"ok": true}})
	e := eventMap(t, b)
	if e["input"] != "[PAYLOAD_TOO_LARGE]" || e["output"] != "small" || d.snapshot().PayloadsOmitted != 1 || d.snapshot().PayloadsTruncated != 0 {
		t.Fatal("fitting/accounting")
	}
}
func TestLiteralPropagationVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/propagation.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name, Carrier, Action string
			Input                 map[string]json.RawMessage
			Expected              json.RawMessage
		}
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			var ctx Context
			json.Unmarshal(tc.Input["context"], &ctx)
			var level PropagationLevel
			json.Unmarshal(tc.Input["level"], &level)
			var carrier, data any
			json.Unmarshal(tc.Input["carrier"], &carrier)
			json.Unmarshal(tc.Input["data"], &data)
			var got any
			if tc.Action == "inject" {
				m, _ := carrier.(map[string]any)
				switch tc.Carrier {
				case "http":
					got = InjectHTTPHeaders(ctx, m, level)
				case "sqs":
					got = InjectSQSAttributes(ctx, m, level)
				case "payload":
					got = InjectPayload(ctx, data, level)
				}
			} else {
				switch tc.Carrier {
				case "http":
					got = ExtractHTTPContext(carrier)
				case "sqs":
					m, _ := carrier.(map[string]any)
					got = ExtractSQSContext(m)
				case "payload":
					v, c := ExtractPayload(carrier)
					m := map[string]any{"context": c}
					if data, ok := v.Get(); ok {
						m["data"] = data
					}
					got = m
				}
			}
			b, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var actual, expected any
			json.Unmarshal(b, &actual)
			json.Unmarshal(tc.Expected, &expected)
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("got %s want %s", b, tc.Expected)
			}
		})
	}
}
func TestDerivationVectors(t *testing.T) {
	finishWarnings := captureWarnings(t)
	defer func() {
		output := finishWarnings()
		assertWarningLines(t, output, 1)
		if !strings.Contains(output, "configuration_error") {
			t.Fatalf("missing derivation warning: %q", output)
		}
	}()
	raw, err := os.ReadFile("testdata/journey-id-derivation.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Vectors []struct {
			Name, Secret, Environment, JourneyID string
			Entity                               Entity
		}
		RefusedEmpty []struct {
			Name, Secret, Environment string
			Entity                    Entity
		}
		Refused []json.RawMessage
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Vectors) == 0 || len(f.Refused) == 0 || len(f.RefusedEmpty) == 0 {
		t.Fatal("derivation fixture case lists must all be nonempty")
	}
	checked := 0
	for _, v := range f.Vectors {
		checked++
		t.Run(v.Name, func(t *testing.T) {
			c := testConfig()
			c.Environment = v.Environment
			c.JourneyIDSecret = v.Secret
			r, d := core(t, c)
			if got := deriveJourneyID(r, d, v.Entity); got != v.JourneyID {
				t.Fatal(got, v.JourneyID)
			}
		})
	}
	for _, v := range f.RefusedEmpty {
		checked++
		c := testConfig()
		c.JourneyIDSecret = v.Secret
		r, d := core(t, c)
		if deriveJourneyID(r, d, v.Entity) == deriveJourneyID(r, d, v.Entity) {
			t.Fatal("invalid entity deterministic")
		}
	}
	for _, rawCase := range f.Refused {
		checked++
		var v struct {
			Name, Secret, Environment string
			Entity                    map[string]json.RawMessage
		}
		if err := json.Unmarshal(rawCase, &v); err != nil {
			t.Fatal(err)
		}
		t.Run(v.Name, func(t *testing.T) {
			c := testConfig()
			c.JourneyIDSecret = v.Secret
			c.Environment = v.Environment
			r, d := core(t, c)
			e := Entity{fixtureMalformedString(t, v.Entity["type"]), fixtureMalformedString(t, v.Entity["id"])}
			if deriveJourneyID(r, d, e) == deriveJourneyID(r, d, e) {
				t.Fatal("ill-formed UTF8 derived deterministically")
			}
		})
	}

	if checked != len(f.Vectors)+len(f.Refused)+len(f.RefusedEmpty) {
		t.Fatalf("only %d derivation cases accounted", checked)
	}
}
func ptr(v int64) *int64 { return &v }
func TestTimingLiteral(t *testing.T) {
	job := QueueJob{QueueName: "orders", ID: "42", TimestampMS: ptr(100), ProcessedOnMS: ptr(100), AttemptsMade: ptr(0)}
	want := map[string]any{"queue": "orders", "attempt": int64(1), "retryGroup": `queue:["orders","42"]`, "queueWaitMs": int64(0), "queueWaitBasis": "initial-enqueue"}
	if got := QueueMetadata(job, QueueTimingOptions{}); !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	job.AttemptsMade = ptr(1)
	if _, ok := QueueMetadata(job, QueueTimingOptions{})["queueWaitMs"]; ok {
		t.Fatal("retry used initial clock")
	}
	job.AttemptsMade = ptr(0)
	if _, ok := QueueMetadata(job, QueueTimingOptions{DeliveryCount: ptr(2)})["queueWaitMs"]; ok {
		t.Fatal("redelivery clock")
	}
	at := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	got := HTTPMetadata(HTTPResponse{StatusCode: 429, Headers: http.Header{"Retry-After": []string{"Mon, 21 Sep 2026 12:00:02 GMT"}}}, HTTPTimingOptions{TargetURL: "https://user:secret@example.com/path?key=secret", ObservedAt: &at})
	if !reflect.DeepEqual(got, map[string]any{"httpStatusCode": 429, "targetHost": "example.com", "retryAfterMs": int64(2000)}) {
		t.Fatal(got)
	}
}
func TestDiagnosticsReentrantConcurrent(t *testing.T) {
	var d *diagnostics
	d = newDiagnostics(func(Diagnostic) { _ = d.snapshot() }, false)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, _ := resolveConfig(testConfig())
			for j := 0; j < 10; j++ {
				buildEnvelope(c, d, "jrn_test", Entity{"order", "42"}, "", Event{Operation: Received, Name: "x", Input: Payload(strings.Repeat("x", 70000))})
			}
		}()
	}
	wg.Wait()
	if d.snapshot().PayloadsTruncated != 80 {
		t.Fatal("race lost counters")
	}
}

// JSON's lone UTF-16 surrogate has no legal UTF-8 encoding. Preserve the literal
// token as native invalid UTF-8 rather than allowing encoding/json to repair it
// into a different, valid U+FFFD business identity before the SDK sees it.
func fixtureMalformedString(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	pattern := regexp.MustCompile(`\\u([dD][89aAbBcCdDeEfF][0-9a-fA-F]{2})`)
	var bad []string
	replaced := pattern.ReplaceAllStringFunc(string(raw), func(token string) string {
		n, e := strconv.ParseUint(token[2:], 16, 16)
		if e != nil {
			t.Fatal(e)
		}
		bad = append(bad, string([]byte{byte(0xe0 | (n >> 12)), byte(0x80 | ((n >> 6) & 63)), byte(0x80 | (n & 63))}))
		return "__SURROGATE__"
	})
	var value string
	if err := json.Unmarshal([]byte(replaced), &value); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range bad {
		value = strings.Replace(value, "__SURROGATE__", invalid, 1)
	}
	return value
}

// Tests using this helper are deliberately sequential: os.Stderr and the
// documented warning scope are process-wide. A temporary file cannot fill a
// pipe and deadlock a warning-heavy failure. Cleanup restores globals on Fatal.
func captureWarnings(t *testing.T) func() string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "warnings-")
	if err != nil {
		t.Fatal(err)
	}
	previous := os.Stderr
	os.Stderr = f
	processWarnings.Lock()
	previousSeen := processWarnings.seen
	processWarnings.seen = map[string]bool{}
	processWarnings.Unlock()
	var output string
	var once sync.Once
	finish := func() string {
		once.Do(func() {
			os.Stderr = previous
			processWarnings.Lock()
			processWarnings.seen = previousSeen
			processWarnings.Unlock()
			if err := f.Close(); err != nil {
				t.Error(err)
			}
			raw, err := os.ReadFile(f.Name())
			if err != nil {
				t.Error(err)
			}
			output = string(raw)
		})
		return output
	}
	t.Cleanup(func() { finish() })
	return finish
}
func assertWarningLines(t *testing.T, output string, want int) {
	t.Helper()
	lines := strings.Split(strings.TrimSuffix(output, "\n"), "\n")
	if output == "" {
		lines = nil
	}
	if len(lines) != want {
		t.Fatalf("got %d warning lines, want %d: %q", len(lines), want, output)
	}
	for _, line := range lines {
		if !strings.HasPrefix(line, "wayscribe: ") {
			t.Fatalf("unexpected stderr: %q", line)
		}
	}
	for _, secret := range []string{"private", "ada@example.com", "next@example.com", "+19195551234", "journey id test vector secret"} {
		if strings.Contains(output, secret) {
			t.Fatalf("unsafe warning: %q", output)
		}
	}
}
