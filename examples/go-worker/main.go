package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	wayscribe "wayscribe.dev/go"
)

type DeliveryRejected struct{ message string }

func (e *DeliveryRejected) Error() string { return e.message }

func required(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func run() error {
	endpoint, err := required("WAYSCRIBE_ENDPOINT")
	if err != nil {
		return err
	}
	apiKey, err := required("WAYSCRIBE_API_KEY")
	if err != nil {
		return err
	}
	environment := os.Getenv("WAYSCRIBE_ENVIRONMENT")
	if environment == "" {
		environment = "development"
	}
	entityID := os.Getenv("WORKER_ENTITY_ID")
	if entityID == "" {
		entityID = "customer-go-42"
	}
	alias := os.Getenv("WORKER_ALIAS")
	if alias == "" {
		alias = "crm-go-9001"
	}

	recorder := wayscribe.New(wayscribe.Config{
		Endpoint:    endpoint,
		APIKey:      apiKey,
		Service:     "go-worker",
		Environment: environment,
	})
	journey := recorder.Journey(wayscribe.Entity{Type: "customer", ID: entityID})
	journey.Identify(map[string]string{"crmCustomerId": alias})

	source := map[string]any{
		"customerId": entityID,
		"phone":      "+1 919 555 1234",
		"password":   "worker-secret",
	}
	normalized, err := wayscribe.Transform(
		context.Background(),
		journey,
		"normalize-customer",
		source,
		func(context.Context) (map[string]any, error) {
			return map[string]any{
				"customerId": entityID,
				"phone":      nil,
				"password":   "worker-secret",
			}, nil
		},
	)
	if err != nil {
		return err
	}

	rejection := &DeliveryRejected{message: "target refused the customer"}
	_, deliveryErr := wayscribe.Deliver(
		context.Background(),
		journey,
		"deliver-customer",
		normalized,
		func(context.Context) (map[string]any, error) { return nil, rejection },
	)
	if deliveryErr != rejection {
		return errors.New("the wrapper replaced or swallowed the host error")
	}

	retryResult, err := wayscribe.Deliver(
		context.Background(),
		journey,
		"deliver-customer",
		normalized,
		func(context.Context) (map[string]any, error) {
			return map[string]any{"accepted": false}, nil
		},
		wayscribe.Options[map[string]any, map[string]any]{
			Attempt: 2,
			IsFailure: func(response map[string]any) *wayscribe.FailureReason {
				if response["accepted"] == true {
					return nil
				}
				return &wayscribe.FailureReason{
					Message: "target rejected retry",
					Code:    "target_rejected",
				}
			},
		},
	)
	if err != nil || retryResult["accepted"] != false {
		return errors.New("the wrapper changed the retry result")
	}

	journey.Complete("")
	shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !recorder.Shutdown(shutdownContext) {
		return errors.New("the recorder did not finish its bounded shutdown")
	}
	counters := recorder.Counters()
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"journeyId": journey.Context().JourneyID,
		"entityId":  entityID,
		"alias":     alias,
		"counters": map[string]int64{
			"recorded": counters.Recorded,
			"sent":     counters.Sent,
			"rejected": counters.Rejected,
			"dropped":  counters.Dropped,
		},
	})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
