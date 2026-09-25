package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	wayscribe "wayscribe.dev/go"
)

func TestMalformedRequestReturnsSafeCountersAndShutsDownRecorder(t *testing.T) {
	recorder := wayscribe.New(wayscribe.Config{
		Endpoint:    "http://127.0.0.1:1",
		APIKey:      "synthetic-test-key",
		Service:     "mixed-go",
		Environment: "development",
	})
	done := make(chan struct{})
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{"))
	response := httptest.NewRecorder()

	newWorkerHandler(recorder, done).ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if got := response.Header().Get("content-type"); got != "application/json" {
		t.Fatalf("content-type = %q, want application/json", got)
	}
	var body struct {
		Error    string           `json:"error"`
		Counters map[string]int64 `json:"counters"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if body.Error != "invalid_json" {
		t.Fatalf("error = %q, want invalid_json", body.Error)
	}
	wantCounters := map[string]int64{"recorded": 0, "sent": 0, "rejected": 0, "dropped": 0}
	for name, want := range wantCounters {
		if got := body.Counters[name]; got != want {
			t.Fatalf("counter %s = %d, want %d", name, got, want)
		}
	}
	select {
	case <-done:
	default:
		t.Fatal("handler did not signal completion")
	}

	journey := recorder.Journey(wayscribe.Entity{Type: "customer", ID: "after-shutdown"})
	journey.Record(wayscribe.Event{Operation: wayscribe.Received, Name: "after-shutdown"})
	after := recorder.Counters()
	if after.Recorded != 1 || after.Dropped != 1 || after.DroppedByCause[wayscribe.AfterShutdown] != 1 {
		t.Fatalf("recorder accepted work after malformed request cleanup: %+v", after)
	}
}

func TestSecondRequestDoesNotPanic(t *testing.T) {
	recorder := wayscribe.New(wayscribe.Config{
		Endpoint:    "http://127.0.0.1:1",
		APIKey:      "synthetic-test-key",
		Service:     "mixed-go",
		Environment: "development",
	})
	done := make(chan struct{})
	handler := newWorkerHandler(recorder, done)
	for i := 0; i < 2; i++ {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{")))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("request %d: status = %d", i+1, response.Code)
		}
	}
	select {
	case <-done:
	default:
		t.Fatal("handler did not signal completion")
	}
}
