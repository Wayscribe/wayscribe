package conformance

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func fixtureDirectory(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate conformance test")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../../protocol/conformance/sdk"))
}

func reportCase(t *testing.T, report Report, id string) CapturedCase {
	t.Helper()
	for _, one := range report.Cases {
		if one.ID == id {
			return one
		}
	}
	t.Fatalf("missing report case %s", id)
	return CapturedCase{}
}

func TestPublicDriverAccountsForManifestAndCapturesPublicSDKBytes(t *testing.T) {
	report, err := Run(fixtureDirectory(t), "fixture")
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Cases) != 35 {
		t.Fatalf("executed %d cases, want 35", len(report.Cases))
	}
	if got, want := report.Skipped, []SkippedCase{
		{ID: "sdk/metadata-uncapturable", Reason: "Node-only throwing property getter"},
		{ID: "sdk/uncapturable-payload", Reason: "Node-only throwing property getter"},
	}; !slices.Equal(got, want) {
		t.Fatalf("skips = %#v, want %#v", got, want)
	}

	for _, one := range report.Cases {
		var flattened []map[string]any
		for _, body := range one.Batches {
			var batch struct {
				Events []struct {
					Event map[string]any `json:"event"`
				} `json:"events"`
			}
			if err := json.Unmarshal([]byte(body), &batch); err != nil {
				t.Fatalf("%s batch is not JSON: %v", one.ID, err)
			}
			for _, envelope := range batch.Events {
				flattened = append(flattened, envelope.Event)
			}
		}
		got, _ := json.Marshal(one.Events)
		want, _ := json.Marshal(flattened)
		if string(got) != string(want) {
			t.Fatalf("%s events do not come from captured batches", one.ID)
		}
	}

	hundred := reportCase(t, report, "sdk/hundred-and-one-events")
	if len(hundred.Batches) != 3 || len(hundred.Events) != 101 {
		t.Fatalf("101 events = %d batches/%d events, want 3/101", len(hundred.Batches), len(hundred.Events))
	}

	projected := reportCase(t, report, "sdk/projected-output").Events[0]
	if projected["operation"] != "delivered" || projected["input"] != "inv_42" || projected["output"] != float64(27) {
		t.Fatalf("projected wrapper event = %#v", projected)
	}

	aliases := reportCase(t, report, "sdk/identify-displayable").Events[0]
	if aliases["operation"] != "identified" || aliases["name"] != "identify" {
		t.Fatalf("identify event = %#v", aliases)
	}

	across := reportCase(t, report, "sdk/across-journeys")
	if len(across.Events) != 3 {
		t.Fatalf("across events = %d, want 3", len(across.Events))
	}
	journeys := map[string]bool{}
	for _, event := range across.Events {
		journeys[event["journeyId"].(string)] = true
	}
	if len(journeys) != 3 {
		t.Fatalf("across journey ids = %v", journeys)
	}

	diagnostics := reportCase(t, report, "sdk/unredacted-secret-name").Diagnostics
	var warningNames []any
	for _, diagnostic := range diagnostics {
		if diagnostic.Kind == "unredacted_secret_name" {
			warningNames = append(warningNames, diagnostic.Detail["name"])
		}
	}
	if !slices.Equal(warningNames, []any{"sessionCredential", "authToken"}) {
		t.Fatalf("unredacted-secret diagnostics = %#v", diagnostics)
	}
	encoded, _ := json.Marshal(diagnostics)
	for _, secret := range []string{"cfx-fake-sdk-SESSION", "cfx-fake-sdk-AUTH", "cfx-fake-sdk-hunter2"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("diagnostics exposed %s", secret)
		}
	}
}
