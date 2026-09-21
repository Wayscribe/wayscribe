package wayscribe

import (
	"bytes"
	"context"
	"time"
	"unicode/utf8"
)

func Transform[I, T any](ctx context.Context, t Target, name string, input I, fn func(context.Context) (T, error), options ...Options[I, T]) (T, error) {
	return wrap(ctx, t, Transformed, name, input, fn, options...)
}
func Persist[I, T any](ctx context.Context, t Target, name string, input I, fn func(context.Context) (T, error), options ...Options[I, T]) (T, error) {
	return wrap(ctx, t, Persisted, name, input, fn, options...)
}
func Publish[I, T any](ctx context.Context, t Target, name string, input I, fn func(context.Context) (T, error), options ...Options[I, T]) (T, error) {
	return wrap(ctx, t, Published, name, input, fn, options...)
}
func Consume[I, T any](ctx context.Context, t Target, name string, input I, fn func(context.Context) (T, error), options ...Options[I, T]) (T, error) {
	return wrap(ctx, t, Consumed, name, input, fn, options...)
}
func Deliver[I, T any](ctx context.Context, t Target, name string, input I, fn func(context.Context) (T, error), options ...Options[I, T]) (T, error) {
	return wrap(ctx, t, Delivered, name, input, fn, options...)
}
func Validate[I, T any](ctx context.Context, t Target, name string, input I, fn func(context.Context) (T, error), options ...Options[I, T]) (T, error) {
	return wrap(ctx, t, Validated, name, input, fn, options...)
}

func snapshotContext(s journeySnapshot) Context {
	e := s.entity
	return Context{JourneyID: s.id, Entity: &e}
}
func projected(c resolvedConfig, field string, fn func() any) (out captured) {
	out = captured{value: uncapturable, unreadable: true}
	guarded(func() { out = captureValue(fn(), c, field) })
	return
}

type metadataParts struct {
	whole captured
	parts map[string]captured
}

func metadataSnapshot(m map[string]any, c resolvedConfig) metadataParts {
	out := metadataParts{whole: captureMetadataDeferred(m, c), parts: map[string]captured{}}
	if out.whole.omitted || len(m) > 1000 {
		return out
	}
	// Fragments carry evidence for exactly the keys surviving a later overwrite.
	values, ok := out.whole.value.(map[string]any)
	if !ok {
		return out
	}
	remainingNames := 100
	for k, v := range m {
		if utf8.RuneCountInString(k) > 128 {
			continue
		}
		key := repairText(k)
		part := captureMetadataDeferred(map[string]any{k: v}, c)
		// Whole-object header recognition is authoritative. A fragment must never
		// undo redaction that depended on a sibling name/key field.
		if p, ok := part.value.(map[string]any); !ok || !bytes.Equal(jsonBytes(p[key]), jsonBytes(values[key])) {
			part = captureValue(map[string]any{key: values[key]}, c, "metadata")
		}
		part.names = part.names[:min(len(part.names), remainingNames)]
		remainingNames -= len(part.names)
		out.parts[key] = part
	}
	if n, ok := values["[KEY_TOO_LONG]"]; ok {
		out.parts["[KEY_TOO_LONG]"] = captured{value: map[string]any{"[KEY_TOO_LONG]": n}}
	}

	return out
}
func mergeMetadata(a, b metadataParts, c resolvedConfig) captured {
	if a.whole.omitted || b.whole.omitted {
		return captured{value: tooLarge, omitted: true}
	}
	parts := make(map[string]captured, len(a.parts)+len(b.parts))
	for k, v := range a.parts {
		parts[k] = v
	}
	for k, v := range b.parts {
		parts[k] = v
	}
	if len(parts) > 1000 {
		return captured{value: tooLarge, omitted: true}
	}
	values := map[string]any{}
	for k, p := range parts {
		values[k] = p.value.(map[string]any)[k]
	}
	r := captureValue(values, c, "metadata")
	if r.omitted {
		return r
	}
	for _, p := range parts {
		r.truncated = r.truncated || p.truncated
		r.unreadable = r.unreadable || p.unreadable
		r.names = append(r.names, p.names[:min(len(p.names), max(0, 100-len(r.names)))]...)
	}
	r.reports = append(append([]Diagnostic(nil), a.whole.reports...), b.whole.reports...)
	return r
}

func wrap[I, T any](ctx context.Context, target Target, op Operation, name string, input I, fn func(context.Context) (T, error), options ...Options[I, T]) (result T, err error) {
	start := time.Now()
	var ss []journeySnapshot
	var events []Event
	var o Options[I, T]
	var static metadataParts
	guarded(func() {
		if target == nil {
			return
		}
		ss = target.targets()
		if len(ss) == 0 {
			return
		}
		if len(options) > 0 {
			o = options[0]
		}
		c := ss[0].recorder.c
		base := snapshotEvent(Event{Operation: op, Name: name, Input: Payload(input), Metadata: o.Metadata, Aliases: o.Aliases, DisplayableAliases: o.DisplayableAliases, Attempt: o.Attempt, Timestamp: start}, c)
		if o.MetadataFrom != nil {
			static = metadataSnapshot(o.Metadata, c)
		}
		events = make([]Event, len(ss))
		for i := range events {
			events[i] = base
		}
		// All mutable options and the default input are now SDK-owned.
		if c.CaptureMode != MetadataOnly && o.CaptureInput != nil {
			for i, s := range ss {
				events[i].Input = Payload(projected(c, "input", func() any { return o.CaptureInput(input, snapshotContext(s)) }))
			}
		}
		ss[0].recorder.optionCount(len(options))
	})
	finish := func(panicked bool, panicValue any) {
		guarded(func() {
			if len(events) != len(ss) {
				return
			}
			duration := min(max(time.Since(start).Milliseconds(), 0), maxMS)
			var failure *ErrorInfo
			// Detach all default outputs before calling any application projection/error.
			for i, s := range ss {
				events[i].DurationMS = &duration
				if !panicked && s.recorder.c.CaptureMode != MetadataOnly {
					events[i].Output = Payload(captureValue(result, s.recorder.c, "output"))
				}
			}
			for i, s := range ss {
				c := s.recorder.c
				if !panicked && c.CaptureMode != MetadataOnly && o.CaptureOutput != nil {
					events[i].Output = Payload(projected(c, "output", func() any { return o.CaptureOutput(result, snapshotContext(s)) }))
				}
				if !panicked && o.MetadataFrom != nil {
					guarded(func() {
						m := o.MetadataFrom(result, snapshotContext(s))
						dynamic := metadataSnapshot(m, c)
						merged := mergeMetadata(static, dynamic, c)
						events[i].metadataCapture = &merged
					})
				}
			}
			if panicked {
				failure = &ErrorInfo{Type: "panic", Message: "host callback panicked"}
				if e, ok := panicValue.(error); ok {
					failure = hostError(e)
				} else if message, ok := panicValue.(string); ok {
					failure.Message = message
				}
			} else if err != nil {
				failure = hostError(err)
			} else if o.IsFailure != nil {
				guarded(func() {
					if reason := o.IsFailure(result); reason != nil {
						failure = &ErrorInfo{Message: reason.Message, Code: reason.Code}
						if failure.Message == "" {
							failure.Message = "result_failed"
						}
					}
				})
			}
			for i, s := range ss {
				e := events[i]
				if failure != nil {
					e.Error = failure
				}
				s.record(e)
			}
		})
	}
	// A Goexit unwinds defers with recover()==nil and never reaches finish(false).
	defer func() {
		if p := recover(); p != nil {
			finish(true, p)
			panic(p)
		}
	}()
	result, err = fn(ctx)
	finish(false, nil)
	return
}
