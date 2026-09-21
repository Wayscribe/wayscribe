package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"

	wayscribe "gitlab.com/jojithedev/wayscribe/packages/sdk-go"
)

const maxBody = 64 * 1024

func required(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("missing required configuration: %s", name)
	}
	return value, nil
}

func counters(value wayscribe.Counters) map[string]int64 {
	return map[string]int64{
		"recorded": int64(value.Recorded),
		"sent":     int64(value.Sent),
		"rejected": int64(value.Rejected),
		"dropped":  int64(value.Dropped),
	}
}

func shutdownRecorder(recorder *wayscribe.Recorder) {
	shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	recorder.Shutdown(shutdownContext)
}

func workerRequest(recorder *wayscribe.Recorder, request *http.Request) (int, map[string]any) {
	if request.Method != http.MethodPost {
		return http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"}
	}
	body, readErr := io.ReadAll(io.LimitReader(request.Body, maxBody+1))
	if readErr != nil || len(body) > maxBody {
		return http.StatusBadRequest, map[string]any{"error": "invalid_body"}
	}
	var envelope any
	if json.Unmarshal(body, &envelope) != nil {
		return http.StatusBadRequest, map[string]any{"error": "invalid_json"}
	}
	value, propagated := wayscribe.ExtractPayload(envelope)
	data, present := value.Get()
	if propagated == nil || !present {
		return http.StatusBadRequest, map[string]any{"error": "missing_payload_context"}
	}
	message, ok := data.(map[string]any)
	if !ok {
		return http.StatusBadRequest, map[string]any{"error": "invalid_message"}
	}
	entityValue, ok := message["entity"].(map[string]any)
	if !ok {
		return http.StatusBadRequest, map[string]any{"error": "invalid_entity"}
	}
	entity := wayscribe.Entity{Type: fmt.Sprint(entityValue["type"]), ID: fmt.Sprint(entityValue["id"])}
	journey := recorder.Resume(*propagated, entity)
	payload := message["payload"]
	_, _ = wayscribe.Deliver(request.Context(), journey, "deliver-customer", payload,
		func(context.Context) (map[string]any, error) {
			return map[string]any{"status": 503}, errors.New("synthetic destination refused attempt")
		})
	_, _ = wayscribe.Deliver(request.Context(), journey, "deliver-customer", payload,
		func(context.Context) (map[string]any, error) {
			return map[string]any{"status": 202}, nil
		}, wayscribe.Options[any, map[string]any]{Attempt: 2})
	journey.Complete("")
	return http.StatusOK, map[string]any{
		"journeyId":              journey.Context().JourneyID,
		"payloadEntityIdPresent": propagated.Entity != nil,
	}
}

func newWorkerHandler(recorder *wayscribe.Recorder, done chan<- struct{}) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		defer close(done)
		status, body := workerRequest(recorder, request)
		shutdownRecorder(recorder)
		body["counters"] = counters(recorder.Counters())
		response.Header().Set("content-type", "application/json")
		response.WriteHeader(status)
		_ = json.NewEncoder(response).Encode(body)
	})
}

func main() {
	endpoint, err := required("WAYSCRIBE_ENDPOINT")
	if err != nil {
		fmt.Fprintln(os.Stderr, "go worker failed: missing configuration")
		os.Exit(1)
	}
	apiKey, err := required("WAYSCRIBE_API_KEY")
	if err != nil {
		fmt.Fprintln(os.Stderr, "go worker failed: missing configuration")
		os.Exit(1)
	}
	environment, err := required("WAYSCRIBE_ENVIRONMENT")
	if err != nil {
		fmt.Fprintln(os.Stderr, "go worker failed: missing configuration")
		os.Exit(1)
	}
	recorder := wayscribe.New(wayscribe.Config{
		Endpoint:       endpoint,
		APIKey:         apiKey,
		Service:        "mixed-go",
		Environment:    environment,
		RequestTimeout: 2 * time.Second,
	})
	defer shutdownRecorder(recorder)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, "go worker failed: listen")
		os.Exit(1)
	}
	done := make(chan struct{})
	server := &http.Server{ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second}
	server.Handler = newWorkerHandler(recorder, done)

	encoded, _ := json.Marshal(map[string]any{"type": "ready", "port": listener.Addr().(*net.TCPAddr).Port})
	fmt.Println(string(encoded))
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, "go worker failed: serve")
		}
	}()
	<-done
	shutdownContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownContext)
}
