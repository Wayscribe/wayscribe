package wayscribe

import "time"

type Entity struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}
type Context struct {
	JourneyID string  `json:"journeyId"`
	Entity    *Entity `json:"entity,omitempty"`
}
type Operation string

const (
	Received    Operation = "received"
	Identified  Operation = "identified"
	Transformed Operation = "transformed"
	Validated   Operation = "validated"
	Persisted   Operation = "persisted"
	Published   Operation = "published"
	Consumed    Operation = "consumed"
	Delivered   Operation = "delivered"
	Failed      Operation = "failed"
	Retried     Operation = "retried"
	Completed   Operation = "completed"
)

type PropagationLevel string

const (
	JourneyOnly    PropagationLevel = "journey-only"
	JourneyAndType PropagationLevel = "journey-and-type"
	Full           PropagationLevel = "full"
)

type CaptureMode string

const (
	MetadataOnly    CaptureMode = "metadata-only"
	RedactedPayload CaptureMode = "redacted-payload"
	FullPayload     CaptureMode = "full-payload"
)

// Value distinguishes absence from an explicitly supplied JSON null.
// Payload marks presence; it does not copy or capture v.
type Value struct {
	value   any
	present bool
}

func Payload(v any) Value        { return Value{v, true} }
func (v Value) Get() (any, bool) { return v.value, v.present }

type ErrorInfo struct {
	Type    string `json:"type,omitempty"`
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
	Stack   string `json:"stack,omitempty"`
}
type Event struct {
	metadataCapture                                          *captured
	aliasesOversize, displayOversize                         bool
	Operation                                                Operation
	Name                                                     string
	Input, Output                                            Value
	Error                                                    *ErrorInfo
	Metadata                                                 map[string]any
	Aliases                                                  map[string]string
	DisplayableAliases                                       []string
	Timestamp                                                time.Time
	DurationMS                                               *int64
	Attempt                                                  int
	ParentEventID, TraceID, SpanID, MessageID, CorrelationID string
}
type JourneyOptions struct{ JourneyID, Label string }
type LabelOptions struct{ Label string }
type IdentifyOptions struct{ DisplayableAliases []string }
type FailureReason struct{ Message, Code string }
type Options[I, T any] struct {
	Attempt            int
	Metadata           map[string]any
	Aliases            map[string]string
	DisplayableAliases []string
	CaptureInput       func(I, Context) any
	CaptureOutput      func(T, Context) any
	MetadataFrom       func(T, Context) map[string]any
	IsFailure          func(T) *FailureReason
}
