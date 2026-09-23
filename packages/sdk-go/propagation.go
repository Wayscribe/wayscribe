package wayscribe

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net/http"
	"sort"
	"strings"
)

var httpNames = []string{"x-wayscribe-journey-id", "x-wayscribe-entity-type", "x-wayscribe-entity-id"}
var sqsNames = []string{"wayscribeJourneyId", "wayscribeEntityType", "wayscribeEntityId"}
var payloadNames = []string{"journeyId", "entityType", "entityId"}

func usableCarrier(s string, journey bool) bool {
	if len(s) < 1 || len(s) > 256 || (journey && !strings.HasPrefix(s, "jrn_")) {
		return false
	}
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.ContainsRune("_.:@=+-", c)) {
			return false
		}
	}
	return true
}
func contextFields(c Context, level PropagationLevel, names []string) map[string]any {
	out := map[string]any{names[0]: c.JourneyID}
	if level == "" {
		level = JourneyAndType
	}
	if level != JourneyOnly && c.Entity != nil {
		out[names[1]] = c.Entity.Type
		if level == Full && usableCarrier(c.Entity.ID, false) {
			out[names[2]] = c.Entity.ID
		}
	}
	return out
}
func InjectHTTPHeaders(c Context, headers map[string]any, level PropagationLevel) map[string]any {
	out := map[string]any{}
	for k, v := range headers {
		lower := strings.ToLower(k)
		if lower != httpNames[0] && lower != httpNames[1] && lower != httpNames[2] {
			out[k] = v
		}
	}
	for k, v := range contextFields(c, level, httpNames) {
		out[k] = v
	}
	return out
}
func firstString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []string:
		if len(x) > 0 {
			return x[0]
		}
	case []any:
		if len(x) > 0 {
			s, _ := x[0].(string)
			return s
		}
	}
	return ""
}
func headerValue(m map[string]any, name string) string {
	if v, ok := m[name]; ok {
		return firstString(v)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		if strings.EqualFold(k, name) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) > 0 {
		return firstString(m[keys[0]])
	}
	return ""
}
func parsedContext(j, t, id string) *Context {
	if !usableCarrier(j, true) {
		return nil
	}
	c := &Context{JourneyID: j}
	if usableCarrier(t, false) && usableCarrier(id, false) {
		c.Entity = &Entity{t, id}
	}
	return c
}
func ExtractHTTPContext(carrier any) *Context {
	m := map[string]any{}
	switch x := carrier.(type) {
	case map[string]any:
		m = x
	case map[string]string:
		for k, v := range x {
			m[k] = v
		}
	case http.Header:
		// A repeated header is what Node's http module joins with ", ", which
		// no carrier value survives; taking the first copy would let whoever
		// adds a header choose the journey.
		for k, v := range x {
			if len(v) > 1 {
				m[k] = strings.Join(v, ", ")
			} else {
				m[k] = v
			}
		}
	default:
		return nil
	}
	return parsedContext(headerValue(m, httpNames[0]), headerValue(m, httpNames[1]), headerValue(m, httpNames[2]))
}
func InjectSQSAttributes(c Context, attrs map[string]any, level PropagationLevel) map[string]any {
	out := map[string]any{}
	for k, v := range attrs {
		if k != sqsNames[0] && k != sqsNames[1] && k != sqsNames[2] {
			out[k] = v
		}
	}
	for k, v := range contextFields(c, level, sqsNames) {
		out[k] = map[string]any{"DataType": "String", "StringValue": v}
	}
	return out
}
func ExtractSQSContext(attrs map[string]any) *Context {
	read := func(k string) string {
		v := attrs[k]
		switch x := v.(type) {
		case string:
			return x
		case map[string]any:
			s, _ := x["StringValue"].(string)
			return s
		case map[string]string:
			return x["StringValue"]
		}
		return ""
	}
	return parsedContext(read(sqsNames[0]), read(sqsNames[1]), read(sqsNames[2]))
}
func InjectPayload(c Context, data any, level PropagationLevel) map[string]any {
	return map[string]any{"_wayscribe": contextFields(c, level, payloadNames), "data": data}
}
func ExtractPayload(body any) (Value, *Context) {
	m, ok := body.(map[string]any)
	if !ok {
		return Payload(body), nil
	}
	wire, ok := m["_wayscribe"]
	if !ok {
		return Payload(body), nil
	}
	data, present := m["data"]
	v := Value{data, present}
	fields, ok := wire.(map[string]any)
	if !ok {
		return v, nil
	}
	read := func(k string) string { s, _ := fields[k].(string); return s }
	return v, parsedContext(read("journeyId"), read("entityType"), read("entityId"))
}
func HasJourney(body any) bool {
	m, ok := body.(map[string]any)
	if !ok {
		return false
	}
	c, ok := m["_wayscribe"].(map[string]any)
	if !ok {
		return false
	}
	s, ok := c["journeyId"].(string)
	return ok && s != ""
}
func newID(prefix string) string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		return ""
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	s := hex.EncodeToString(b[:])
	return prefix + s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}
func deriveJourneyID(c resolvedConfig, d *diagnostics, e Entity) string {
	if !validText(e.Type, 128, true) || !validText(e.ID, 512, true) {
		d.configurationError("entity_invalid", "entity")
		return newID("jrn_")
	}
	if len(c.JourneyIDSecret) < 32 {
		code := "journey_id_secret_unusable"
		if c.JourneyIDSecret == "" {
			code = "journey_id_secret_missing"
		}
		d.configurationError(code, "JourneyIDSecret")
		return newID("jrn_")
	}
	h := hmac.New(sha256.New, []byte(c.JourneyIDSecret))
	for _, s := range []string{"journey-id/v1", c.Environment, e.Type, e.ID} {
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(len(s)))
		h.Write(length[:])
		h.Write([]byte(s))
	}
	return "jrn_" + hex.EncodeToString(h.Sum(nil))[:32]
}
