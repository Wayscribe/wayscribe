package wayscribe

import (
	"bytes"
	"encoding/json"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

func jsonBytes(v any) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if e.Encode(v) != nil {
		return nil
	}
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
}
func validOperation(o Operation) bool {
	switch o {
	case Received, Identified, Transformed, Validated, Persisted, Published, Consumed, Delivered, Failed, Retried, Completed:
		return true
	}
	return false
}
func normalizeLabel(label string, d *diagnostics) string {
	label = repairText(label)
	if strings.TrimSpace(label) == "" {
		d.emit(Diagnostic{Kind: "invalid_option", Field: "journeyLabel"})
		return ""
	}
	if utf8.RuneCountInString(label) > 200 {
		label = prefixRunes(label, 199) + "…"
		d.emit(Diagnostic{Kind: "invalid_option", Field: "journeyLabel", Code: "truncated"})
	}
	publicWarning(label, "journeyLabel", d)
	return label
}
func captureMetadata(m map[string]any, c resolvedConfig, d *diagnostics) captured {
	r := captureMetadataDeferred(m, c)
	for _, v := range r.reports {
		d.emit(v)
	}
	r.reports = nil
	return r
}
func captureMetadataDeferred(m map[string]any, c resolvedConfig) captured {
	if len(m) > 1000 {
		return captured{value: tooLarge, omitted: true}
	}
	out := map[string]any{}
	dropped := 0
	for k, v := range m {
		if utf8.RuneCountInString(k) > 128 {
			dropped++
		} else {
			out[repairText(k)] = v
		}
	}
	if dropped > 0 {
		out["[KEY_TOO_LONG]"] = dropped
	}
	r := captureValue(out, c, "metadata")
	if dropped > 0 {
		r.reports = []Diagnostic{{Kind: "invalid_option", Field: "metadata"}}
	}
	return r
}

// buildEnvelope owns capture counters only. A nil result is a refusal; the
// recorder owns admission and final recorded/sent/rejected/dropped accounting.
// Inputs must remain stable for this call. The returned bytes are SDK-owned.
func buildEnvelope(c resolvedConfig, d *diagnostics, journeyID string, entity Entity, label string, e Event) (body []byte) {
	defer func() {
		if recover() != nil {
			d.emit(Diagnostic{Kind: "invalid_event", Code: "unreadable"})
			body = nil
		}
	}()
	if !c.enabled {
		return nil
	}
	if !validText(journeyID, 128, true) || !validText(entity.Type, 128, true) || !validText(entity.ID, 512, true) || !validText(e.Name, 256, true) || !validOperation(e.Operation) {
		d.emit(Diagnostic{Kind: "invalid_event", Code: "identity"})
		return nil
	}
	id := newID("evt_")
	if id == "" {
		d.emit(Diagnostic{Kind: "invalid_event", Code: "random_source"})
		return nil
	}
	timestamp := e.Timestamp
	if timestamp.IsZero() {
		timestamp = time.Now()
	}
	if timestamp.Year() < 0 || timestamp.Year() > 9999 {
		d.emit(Diagnostic{Kind: "invalid_option", Field: "Timestamp"})
		timestamp = time.Now()
	}
	event := map[string]any{"id": id, "journeyId": journeyID, "entity": entity, "operation": e.Operation, "name": e.Name, "timestamp": timestamp.UTC().Format("2006-01-02T15:04:05.000Z"), "service": c.Service, "environment": c.Environment, "runtime": map[string]any{"language": "go", "version": runtime.Version(), "sdk": map[string]any{"name": SDKName, "version": Version}}}
	if len(c.Deployment) > 0 {
		event["deployment"] = c.Deployment
	}
	if label != "" {
		if l := normalizeLabel(label, d); l != "" {
			event["journeyLabel"] = l
		}
	}
	if e.Error != nil {
		event["error"] = captureError(*e.Error, d)
	}
	for _, v := range []struct {
		k, s string
		max  int
	}{{"parentEventId", e.ParentEventID, 128}, {"traceId", e.TraceID, 128}, {"spanId", e.SpanID, 128}, {"messageId", e.MessageID, 256}, {"correlationId", e.CorrelationID, 256}} {
		if v.s == "" {
			continue
		}
		if validText(v.s, v.max, true) {
			event[v.k] = v.s
		} else {
			d.emit(Diagnostic{Kind: "invalid_option", Field: v.k})
		}
	}
	if e.DurationMS != nil {
		if *e.DurationMS < 0 {
			d.emit(Diagnostic{Kind: "invalid_option", Field: "durationMs"})
		} else {
			event["durationMs"] = min(*e.DurationMS, maxMS)
		}
	}
	if e.Aliases != nil {
		aliases := map[string]string{}
		if e.aliasesOversize || len(e.Aliases) > 1000 {
			d.emit(Diagnostic{Kind: "invalid_option", Field: "aliases"})
		} else {
			for k, v := range e.Aliases {
				if utf8.RuneCountInString(k) <= 128 && utf8.RuneCountInString(v) <= 512 {
					aliases[repairText(k)] = repairText(v)
				} else {
					d.emit(Diagnostic{Kind: "invalid_option", Field: "aliases"})
				}
			}
		}
		event["aliases"] = aliases
		display := []string{}
		seen := map[string]bool{}
		for _, key := range e.DisplayableAliases[:min(len(e.DisplayableAliases), 1000)] {
			if v, ok := aliases[key]; ok && !seen[key] {
				display = append(display, key)
				seen[key] = true
				publicWarning(v, "displayableAliases", d)
			}
		}
		if len(display) > 0 {
			event["displayableAliases"] = display
		}
		if e.displayOversize || len(e.DisplayableAliases) > 1000 {
			d.emit(Diagnostic{Kind: "invalid_option", Field: "displayableAliases"})
		}
	}
	captures := map[string]captured{}
	if e.metadataCapture != nil {
		r := *e.metadataCapture
		for _, v := range r.reports {
			d.emit(v)
		}
		if m, ok := r.value.(map[string]any); ok {
			copy := make(map[string]any, len(m))
			for k, v := range m {
				copy[k] = v
			}
			r.value = copy
		}
		captures["metadata"] = r
	} else if e.Metadata != nil {
		captures["metadata"] = captureMetadata(e.Metadata, c, d)
	}
	if e.Attempt > 0 && int64(e.Attempt) <= safeInteger {
		if e.Attempt > 1 {
			event["operation"] = Retried
		}
		r, exists := captures["metadata"]
		if !exists {
			r = captured{value: map[string]any{}}
		}
		if m, ok := r.value.(map[string]any); ok {
			m["attempt"] = e.Attempt
			if len(m) > 1000 {
				r = captured{value: tooLarge, omitted: true}
			}
		}
		captures["metadata"] = r
	} else if e.Attempt != 0 {
		d.emit(Diagnostic{Kind: "invalid_option", Field: "attempt"})
	}
	if c.CaptureMode != MetadataOnly {
		if e.Input.present {
			captures["input"] = captureValue(e.Input.value, c, "input")
		}
		if e.Output.present {
			captures["output"] = captureValue(e.Output.value, c, "output")
		}
	}
	for k, v := range captures {
		if k != "metadata" || !v.omitted {
			event[k] = v.value
		}
	}
	wire := func() []byte { return jsonBytes(map[string]any{"protocolVersion": "0.1", "event": event}) }
	body = wire()
	keys := []string{}
	for _, k := range []string{"input", "output"} {
		if _, ok := event[k]; ok {
			keys = append(keys, k)
		}
	}
	sort.SliceStable(keys, func(i, j int) bool { return len(jsonBytes(event[keys[i]])) > len(jsonBytes(event[keys[j]])) })
	for _, k := range keys {
		if len(body) <= c.MaxEventBytes {
			break
		}
		event[k] = tooLarge
		r := captures[k]
		r.omitted = true
		captures[k] = r
		body = wire()
	}
	if len(body) > c.MaxEventBytes {
		if _, ok := event["metadata"]; ok {
			delete(event, "metadata")
			r := captures["metadata"]
			r.omitted = true
			captures["metadata"] = r
			body = wire()
		}
	}
	for _, k := range []string{"input", "output", "metadata"} {
		r, ok := captures[k]
		if !ok {
			continue
		}
		if r.omitted {
			d.increment("payloads_omitted")
			d.emit(Diagnostic{Kind: "payload_omitted", Field: k})
		} else if r.truncated {
			d.increment("payloads_truncated")
			d.emit(Diagnostic{Kind: "payload_truncated", Field: k})
		}
		if r.unreadable {
			d.increment("capture_errors")
			d.emit(Diagnostic{Kind: "capture_error", Field: k})
		}
		if !r.omitted && len(body) <= c.MaxEventBytes {
			for _, n := range r.names {
				d.emit(n)
			}
		}
	}
	if len(body) > c.MaxEventBytes {
		d.emit(Diagnostic{Kind: "invalid_event", Code: "envelope_budget"})
		return nil
	}
	return body
}
