package conformance

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	wayscribe "wayscribe.dev/go"
)

var skipReasons = map[string]string{
	"sdk/metadata-uncapturable": "Node-only throwing property getter",
	"sdk/uncapturable-payload":  "Node-only throwing property getter",
}

type captureServer struct {
	server  *httptest.Server
	mu      sync.Mutex
	batches []string
}

func newCaptureServer() *captureServer {
	capture := &captureServer{}
	capture.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			http.Error(writer, "read request", http.StatusInternalServerError)
			return
		}
		var batch struct {
			Events []json.RawMessage `json:"events"`
		}
		if err := json.Unmarshal(body, &batch); err != nil {
			http.Error(writer, "parse request", http.StatusBadRequest)
			return
		}
		capture.mu.Lock()
		capture.batches = append(capture.batches, string(body))
		capture.mu.Unlock()
		results := make([]map[string]string, len(batch.Events))
		for index := range results {
			results[index] = map[string]string{"status": "accepted"}
		}
		response, _ := json.Marshal(map[string]any{"data": map[string]any{"results": results}})
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(http.StatusAccepted)
		_, _ = writer.Write(response)
	}))
	return capture
}

func (server *captureServer) close() { server.server.Close() }

func (server *captureServer) snapshot() []string {
	server.mu.Lock()
	defer server.mu.Unlock()
	return append([]string(nil), server.batches...)
}

func Run(directory, run string) (Report, error) {
	paths, err := filepath.Glob(filepath.Join(directory, "*.json"))
	if err != nil {
		return Report{}, err
	}
	sort.Strings(paths)
	if len(paths) == 0 {
		return Report{}, fmt.Errorf("no SDK fixtures in %s", directory)
	}
	report := Report{Cases: []CapturedCase{}, Skipped: []SkippedCase{}}
	for _, path := range paths {
		one, err := loadFixture(path)
		if err != nil {
			return Report{}, err
		}
		if !appliesToGo(one.Languages) {
			reason := skipReasons[one.ID]
			if reason == "" {
				reason = "language excluded"
			}
			report.Skipped = append(report.Skipped, SkippedCase{ID: one.ID, Reason: reason})
			continue
		}
		captured, err := captureFixture(one, run)
		if err != nil {
			return Report{}, fmt.Errorf("%s: %w", one.ID, err)
		}
		report.Cases = append(report.Cases, captured)
	}
	return report, nil
}

func loadFixture(path string) (fixture, error) {
	file, err := os.Open(path)
	if err != nil {
		return fixture{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.UseNumber()
	var one fixture
	if err := decoder.Decode(&one); err != nil {
		return fixture{}, err
	}
	return one, nil
}

func appliesToGo(languages []string) bool {
	for _, language := range languages {
		if language == "*" || language == "go" {
			return true
		}
	}
	return false
}

func captureFixture(one fixture, run string) (CapturedCase, error) {
	server := newCaptureServer()
	defer server.close()
	var diagnosticMu sync.Mutex
	diagnostics := []Diagnostic{}
	config := wayscribe.Config{
		Endpoint:           server.server.URL,
		APIKey:             "wsk_test_conformance",
		Service:            "customer-integration",
		Environment:        "conformance",
		MaxConcurrentSends: 1,
		OnDiagnostic: func(value wayscribe.Diagnostic) {
			diagnosticMu.Lock()
			diagnostics = append(diagnostics, normalizeDiagnostic(value))
			diagnosticMu.Unlock()
		},
	}
	if value, ok := one.Recorder["maxEventBytes"]; ok {
		config.MaxEventBytes = fixtureInt(value)
	}
	recorder := wayscribe.New(config)
	journey := recorder.Journey(wayscribe.Entity{Type: "customer", ID: "0018Z00002ABC"})
	for _, call := range one.Calls {
		expanded, err := expandFixture(call.Args, run)
		if err != nil {
			return CapturedCase{}, err
		}
		args := expanded.(map[string]any)
		var target wayscribe.Target = journey
		if call.Journeys > 0 {
			journeys := []*wayscribe.Journey{journey}
			for index := 2; index <= call.Journeys; index++ {
				journeys = append(journeys, recorder.Journey(wayscribe.Entity{Type: "customer", ID: fmt.Sprintf("0018Z00002ABC-%d", index)}))
			}
			target = recorder.Across(journeys...)
		}
		repeat := call.Repeat
		if repeat == 0 {
			repeat = 1
		}
		for range repeat {
			if err := makeCall(target, journey, call, args); err != nil {
				return CapturedCase{}, err
			}
		}
	}
	flushContext, cancelFlush := context.WithTimeout(context.Background(), 10*time.Second)
	flushed := recorder.Flush(flushContext)
	cancelFlush()
	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	shutdown := recorder.Shutdown(shutdownContext)
	cancelShutdown()
	if !flushed || !shutdown {
		return CapturedCase{}, fmt.Errorf("recorder lifecycle did not drain (flush=%t shutdown=%t counters=%+v)", flushed, shutdown, recorder.Counters())
	}
	batches := server.snapshot()
	events, err := eventsFromBatches(batches)
	if err != nil {
		return CapturedCase{}, err
	}
	diagnosticMu.Lock()
	reported := orderDiagnostics(diagnostics, one.Expect.Diagnostics)
	diagnosticMu.Unlock()
	return CapturedCase{ID: one.ID, Batches: batches, Events: events, Diagnostics: reported}, nil
}

func orderDiagnostics(actual, expected []Diagnostic) []Diagnostic {
	out := make([]Diagnostic, 0, len(actual))
	used := make([]bool, len(actual))
	for _, want := range expected {
		for index, got := range actual {
			if used[index] || got.Kind != want.Kind || !diagnosticContains(got.Detail, want.Detail) {
				continue
			}
			out = append(out, got)
			used[index] = true
			break
		}
	}
	for index, got := range actual {
		if !used[index] {
			out = append(out, got)
		}
	}
	return out
}

func diagnosticContains(actual, expected map[string]any) bool {
	for key, want := range expected {
		got, ok := actual[key]
		if !ok || fmt.Sprint(got) != fmt.Sprint(want) {
			return false
		}
	}
	return true
}

func makeCall(target wayscribe.Target, journey *wayscribe.Journey, call fixtureCall, args map[string]any) error {
	switch call.Call {
	case "record":
		target.(interface{ Record(wayscribe.Event) }).Record(eventFromArgs(args))
		return nil
	case "identify":
		aliases := stringMap(args["aliases"])
		options := mapValue(args["options"])
		journey.Identify(aliases, wayscribe.IdentifyOptions{DisplayableAliases: stringSlice(options["displayableAliases"])})
		return nil
	case "label":
		journey.Label(stringValue(args["text"]))
		return nil
	case "fail":
		err, ok := args["error"].(error)
		if !ok {
			return fmt.Errorf("fail error has type %T", args["error"])
		}
		name := call.Name
		if name == "" {
			name = "failed"
		}
		target.(interface{ Fail(string, error) }).Fail(name, err)
		return nil
	case "finish":
		target.(interface{ Complete(string) }).Complete(call.Name)
		return nil
	case "transform", "persist", "publish", "consume", "deliver", "validate":
		return makeWrapperCall(target, call, args)
	default:
		return fmt.Errorf("unknown call %q", call.Call)
	}
}

func makeWrapperCall(target wayscribe.Target, call fixtureCall, args map[string]any) error {
	input := args["input"]
	output := args["output"]
	options := wrapperOptions(args["options"])
	callback := func(context.Context) (any, error) { return output, nil }
	var err error
	switch call.Call {
	case "transform":
		_, err = wayscribe.Transform(context.Background(), target, call.Name, input, callback, options)
	case "persist":
		_, err = wayscribe.Persist(context.Background(), target, call.Name, input, callback, options)
	case "publish":
		_, err = wayscribe.Publish(context.Background(), target, call.Name, input, callback, options)
	case "consume":
		_, err = wayscribe.Consume(context.Background(), target, call.Name, input, callback, options)
	case "deliver":
		_, err = wayscribe.Deliver(context.Background(), target, call.Name, input, callback, options)
	case "validate":
		_, err = wayscribe.Validate(context.Background(), target, call.Name, input, callback, options)
	}
	return err
}

func wrapperOptions(value any) wayscribe.Options[any, any] {
	fields := mapValue(value)
	options := wayscribe.Options[any, any]{
		Attempt:            intValue(fields["attempt"]),
		Metadata:           mapValueOrNil(fields["metadata"]),
		Aliases:            stringMap(fields["aliases"]),
		DisplayableAliases: stringSlice(fields["displayableAliases"]),
	}
	if projection, ok := fields["captureInput"].(fixtureProjection); ok {
		options.CaptureInput = func(value any, context wayscribe.Context) any {
			return projection(value, contextMap(context))
		}
	}
	if projection, ok := fields["captureOutput"].(fixtureProjection); ok {
		options.CaptureOutput = func(value any, context wayscribe.Context) any {
			return projection(value, contextMap(context))
		}
	}
	if projection, ok := fields["metadataFrom"].(fixtureProjection); ok {
		options.MetadataFrom = func(value any, context wayscribe.Context) map[string]any {
			return mapValue(projection(value, contextMap(context)))
		}
	}
	return options
}

func eventFromArgs(args map[string]any) wayscribe.Event {
	event := wayscribe.Event{
		Operation:          wayscribe.Operation(stringValue(args["operation"])),
		Name:               stringValue(args["name"]),
		Metadata:           mapValueOrNil(args["metadata"]),
		Aliases:            stringMap(args["aliases"]),
		DisplayableAliases: stringSlice(args["displayableAliases"]),
		Attempt:            intValue(args["attempt"]),
		ParentEventID:      stringValue(args["parentEventId"]),
		TraceID:            stringValue(args["traceId"]),
		SpanID:             stringValue(args["spanId"]),
		MessageID:          stringValue(args["messageId"]),
		CorrelationID:      stringValue(args["correlationId"]),
	}
	if value, ok := args["input"]; ok {
		event.Input = wayscribe.Payload(value)
	}
	if value, ok := args["output"]; ok {
		event.Output = wayscribe.Payload(value)
	}
	if value, ok := args["timestamp"].(time.Time); ok {
		event.Timestamp = value
	} else if value := stringValue(args["timestamp"]); value != "" {
		event.Timestamp, _ = time.Parse(time.RFC3339Nano, value)
	}
	if value, ok := args["durationMs"]; ok {
		duration := int64(intValue(value))
		event.DurationMS = &duration
	}
	if value, ok := args["error"].(map[string]any); ok {
		event.Error = &wayscribe.ErrorInfo{Type: stringValue(value["type"]), Message: stringValue(value["message"]), Code: stringValue(value["code"]), Stack: stringValue(value["stack"])}
	}
	return event
}

func eventsFromBatches(batches []string) ([]map[string]any, error) {
	events := []map[string]any{}
	for _, body := range batches {
		var batch struct {
			Events []struct {
				Event map[string]any `json:"event"`
			} `json:"events"`
		}
		if err := json.Unmarshal([]byte(body), &batch); err != nil {
			return nil, err
		}
		for _, envelope := range batch.Events {
			events = append(events, envelope.Event)
		}
	}
	return events, nil
}

func normalizeDiagnostic(value wayscribe.Diagnostic) Diagnostic {
	detail := map[string]any{}
	for key, item := range map[string]string{"kind": value.Kind, "code": value.Code, "field": value.Field, "name": value.Name, "path": value.Path, "shape": value.Shape} {
		if key != "kind" && item != "" {
			detail[key] = item
		}
	}
	if len(detail) == 0 {
		detail = nil
	}
	return Diagnostic{Kind: value.Kind, Detail: detail}
}

func contextMap(value wayscribe.Context) map[string]any {
	out := map[string]any{"journeyId": value.JourneyID}
	if value.Entity != nil {
		out["entity"] = map[string]any{"type": value.Entity.Type, "id": value.Entity.ID}
	}
	return out
}

func mapValue(value any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	result, _ := value.(map[string]any)
	return result
}

func mapValueOrNil(value any) map[string]any {
	if value == nil {
		return nil
	}
	return mapValue(value)
}

func stringMap(value any) map[string]string {
	if value == nil {
		return nil
	}
	out := map[string]string{}
	for key, item := range mapValue(value) {
		if text, ok := item.(string); ok {
			out[key] = text
		}
	}
	return out
}

func stringSlice(value any) []string {
	if value == nil {
		return nil
	}
	items, _ := value.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

func intValue(value any) int {
	if value == nil {
		return 0
	}
	return fixtureInt(value)
}
