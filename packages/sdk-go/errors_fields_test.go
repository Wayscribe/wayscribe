package wayscribe

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// targetRejected is a host error that names the fields it refused (ADR-072).
type targetRejected struct{ names []string }

func (targetRejected) Error() string      { return "A phone number is required." }
func (e targetRejected) Fields() []string { return e.names }

type panickingFields struct{}

func (panickingFields) Error() string    { return "A phone number is required." }
func (panickingFields) Fields() []string { panic("host bug") }

func opportunityLines(n int) []string {
	lines := make([]string, 0, n)
	for i := 0; i < n; i++ {
		lines = append(lines, fmt.Sprintf("Opportunity_Lines__c[%d].Unit_Price__c", i))
	}
	return lines
}

func TestHostErrorReadsFields(t *testing.T) {
	_, d := core(t, testConfig())
	out := captureError(*hostError(targetRejected{names: []string{"phone", "BillingAddress.PostalCode"}}), d)
	if !reflect.DeepEqual(out["fields"], []string{"phone", "BillingAddress.PostalCode"}) {
		t.Fatal(out)
	}
	if out["message"] != "A phone number is required." || out["type"] != "targetRejected" {
		t.Fatal(out)
	}
}

func TestHostErrorReadsWrappedFields(t *testing.T) {
	wrapped := fmt.Errorf("deliver-customer-to-target: %w", targetRejected{names: []string{"phone"}})
	if got := hostError(wrapped).Fields; !reflect.DeepEqual(got, []string{"phone"}) {
		t.Fatal(got)
	}
}

func TestErrorFieldsSanitized(t *testing.T) {
	_, d := core(t, testConfig())
	lines := opportunityLines(25)
	long := strings.Repeat("😀", 250)
	out := captureError(ErrorInfo{Message: "rejected", Fields: append([]string{"", long}, lines...)}, d)
	want := append([]string{strings.Repeat("😀", 200)}, lines[:19]...)
	if !reflect.DeepEqual(out["fields"], want) {
		t.Fatal(out["fields"])
	}
}

func TestErrorFieldsBoundaries(t *testing.T) {
	_, d := core(t, testConfig())
	// 201 multi-byte runes are cut to 200 runes, not bytes.
	got := captureError(ErrorInfo{Message: "m", Fields: []string{strings.Repeat("é", 201)}}, d)["fields"].([]string)
	if len(got) != 1 || len([]rune(got[0])) != 200 || got[0] != strings.Repeat("é", 200) {
		t.Fatal(len(got), len([]rune(got[0])))
	}
	// 21 entries are capped at 20.
	got = captureError(ErrorInfo{Message: "m", Fields: opportunityLines(21)}, d)["fields"].([]string)
	if len(got) != 20 {
		t.Fatal(len(got))
	}
	// Exactly 20 survive untouched.
	got = captureError(ErrorInfo{Message: "m", Fields: opportunityLines(20)}, d)["fields"].([]string)
	if len(got) != 20 {
		t.Fatal(len(got))
	}
}

func TestErrorFieldsRepairedBeforeDroppingEmpties(t *testing.T) {
	_, d := core(t, testConfig())
	// A NUL-only entry repairs to empty and is dropped; text around a NUL is kept.
	out := captureError(ErrorInfo{Message: "m", Fields: []string{"\x00", "ph\x00one", "\x00\x00", "ok"}}, d)
	if !reflect.DeepEqual(out["fields"], []string{"phone", "ok"}) {
		t.Fatal(out["fields"])
	}
	// Invalid UTF-8 becomes U+FFFD, the way message text does.
	out = captureError(ErrorInfo{Message: "m", Fields: []string{"a\xffb"}}, d)
	if !reflect.DeepEqual(out["fields"], []string{"a�b"}) {
		t.Fatal(out["fields"])
	}
	// The same through the Fields() convention, and nothing survives from only NULs.
	if got := hostError(targetRejected{names: []string{"\x00", "ph\x00one"}}).Fields; !reflect.DeepEqual(got, []string{"phone"}) {
		t.Fatal(got)
	}
	if got := hostError(targetRejected{names: []string{"\x00"}}).Fields; got != nil {
		t.Fatal(got)
	}
}

func TestErrorFieldsOmittedWhenNothingSurvives(t *testing.T) {
	_, d := core(t, testConfig())
	for _, given := range [][]string{nil, {}, {"", ""}, {"\x00"}} {
		out := captureError(ErrorInfo{Message: "rejected", Fields: given}, d)
		if _, ok := out["fields"]; ok {
			t.Fatal(out)
		}
	}
	if got := hostError(ConnectionError{}).Fields; got != nil {
		t.Fatal(got)
	}
	if got := hostError(targetRejected{names: []string{"", ""}}).Fields; got != nil {
		t.Fatal(got)
	}
}

func TestPanickingFieldsNeverEscapes(t *testing.T) {
	info := hostError(panickingFields{})
	if info.Message != "A phone number is required." || info.Type != "panickingFields" || info.Fields != nil {
		t.Fatal(info)
	}
}

func TestReturnedErrorFieldsRecorded(t *testing.T) {
	r, s := testRecorder(t, nil)
	j := r.Journey(Entity{"customer", "0018Z00002ABC"})
	_, err := Deliver(context.Background(), j, "deliver-customer-to-target", 0,
		func(context.Context) (int, error) {
			return 0, fmt.Errorf("deliver: %w", targetRejected{names: []string{"", "phone", "\x00"}})
		}, Options[int, int]{})
	if err == nil {
		t.Fatal("the host error must come back unchanged")
	}
	es := flushedEvents(t, r, s)
	if len(es) != 1 {
		t.Fatal(es)
	}
	got := es[0]["error"].(map[string]any)
	if !reflect.DeepEqual(got["fields"], []any{"phone"}) || got["type"] != "wrapError" {
		t.Fatal(got)
	}
}

func TestPanickingFieldsStillRecordsTheFailure(t *testing.T) {
	r, s := testRecorder(t, nil)
	j := r.Journey(Entity{"customer", "0018Z00002ABC"})
	_, err := Deliver(context.Background(), j, "deliver-customer-to-target", 0,
		func(context.Context) (int, error) { return 0, panickingFields{} }, Options[int, int]{})
	if err == nil {
		t.Fatal("the host error must come back")
	}
	es := flushedEvents(t, r, s)
	if len(es) != 1 {
		t.Fatal(es)
	}
	got := es[0]["error"].(map[string]any)
	if _, ok := got["fields"]; ok || got["message"] != "A phone number is required." {
		t.Fatal(got)
	}
}

func TestFailureReasonFieldsRecorded(t *testing.T) {
	r, s := testRecorder(t, nil)
	j := r.Journey(Entity{"customer", "0018Z00002ABC"})
	_, _ = Deliver(context.Background(), j, "deliver-customer-to-target", 0,
		func(context.Context) (int, error) { return 422, nil },
		Options[int, int]{IsFailure: func(int) *FailureReason {
			return &FailureReason{Message: "A phone number is required.", Code: "phone_required", Fields: []string{"phone"}}
		}})
	es := flushedEvents(t, r, s)
	if len(es) != 1 {
		t.Fatal(es)
	}
	got := es[0]["error"].(map[string]any)
	want := map[string]any{"message": "A phone number is required.", "code": "phone_required", "fields": []any{"phone"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
}
