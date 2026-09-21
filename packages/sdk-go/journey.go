package wayscribe

import (
	"sync"
	"time"
)

// Target is sealed: a wrapper targets a Journey or a recorder-owned Group.
type Target interface{ targets() []journeySnapshot }
type Journey struct {
	recorder *Recorder
	id       string
	entity   Entity
	mu       sync.RWMutex
	label    string
}
type Group struct {
	recorder *Recorder
	journeys []*Journey
}
type journeySnapshot struct {
	recorder *Recorder
	id       string
	entity   Entity
	label    string
}

func (j *Journey) targets() []journeySnapshot {
	if j == nil || j.recorder == nil || j.recorder.d == nil {
		return nil
	}
	j.mu.RLock()
	s := journeySnapshot{j.recorder, j.id, j.entity, j.label}
	j.mu.RUnlock()
	return []journeySnapshot{s}
}
func (g *Group) targets() []journeySnapshot {
	if g == nil {
		return nil
	}
	out := make([]journeySnapshot, 0, len(g.journeys))
	for _, j := range g.journeys {
		out = append(out, j.targets()...)
	}
	return out
}
func (r *Recorder) Journey(e Entity, options ...JourneyOptions) *Journey {
	j := &Journey{recorder: r, entity: e, id: newID("jrn_")}
	var o JourneyOptions
	if len(options) > 0 {
		o = options[0]
		if o.JourneyID != "" {
			j.id = o.JourneyID
		}
	}
	if r != nil && r.d != nil {
		if o.Label != "" {
			j.label = normalizeLabel(o.Label, r.d)
		}
		r.optionCount(len(options))
	}
	return j
}
func (r *Recorder) Resume(c Context, e Entity) *Journey {
	id := c.JourneyID
	valid := usableCarrier(id, true) && validText(id, 128, true)
	if !valid {
		id = newID("jrn_")
	}
	j := &Journey{recorder: r, id: id, entity: e}
	if !valid && c.JourneyID != "" && r != nil && r.d != nil {
		r.d.emit(Diagnostic{Kind: "invalid_option", Field: "journeyId"})
	}
	return j
}
func (r *Recorder) ForEntity(e Entity, options ...LabelOptions) *Journey {
	j := &Journey{recorder: r, entity: e}
	var o LabelOptions
	if len(options) > 0 {
		o = options[0]
	}
	if r != nil && r.d != nil {
		j.id = deriveJourneyID(r.c, r.d, e)
		if o.Label != "" {
			j.label = normalizeLabel(o.Label, r.d)
		}
		r.optionCount(len(options))
	}
	return j
}
func (r *Recorder) Across(journeys ...*Journey) *Group {
	g := &Group{recorder: r}
	seen := map[string]bool{}
	bad := false
	for _, j := range journeys {
		if j == nil || j.recorder != r {
			bad = true
			continue
		}
		if !seen[j.id] {
			seen[j.id] = true
			g.journeys = append(g.journeys, j)
		}
	}
	if bad && r != nil && r.d != nil {
		r.d.emit(Diagnostic{Kind: "invalid_option", Field: "journeys"})
	}
	return g
}
func (r *Recorder) optionCount(n int) {
	if n > 1 && r != nil && r.d != nil {
		r.d.emit(Diagnostic{Kind: "invalid_option", Field: "options", Code: "multiple"})
	}
}
func (j *Journey) Context() Context {
	if j == nil {
		return Context{}
	}
	e := j.entity
	return Context{JourneyID: j.id, Entity: &e}
}
func (j *Journey) Label(label string) {
	if j == nil || j.recorder == nil || j.recorder.d == nil {
		return
	}
	label = normalizeLabel(label, j.recorder.d)
	if label != "" {
		j.mu.Lock()
		j.label = label
		j.mu.Unlock()
	}
}
func (j *Journey) Record(e Event) { recordTargets(j, e) }
func (g *Group) Record(e Event)   { recordTargets(g, e) }
func (j *Journey) Identify(aliases map[string]string, options ...IdentifyOptions) {
	if j == nil {
		return
	}
	e := Event{Operation: Identified, Name: "identify", Aliases: aliases}
	if len(options) > 0 {
		e.DisplayableAliases = options[0].DisplayableAliases
	}
	recordTargetsCount(j, e, len(options))
}
func (j *Journey) Fail(name string, err error) { failTargets(j, name, err) }
func (g *Group) Fail(name string, err error)   { failTargets(g, name, err) }
func (j *Journey) Complete(name string) {
	if name == "" {
		name = "complete"
	}
	j.Record(Event{Operation: Completed, Name: name})
}
func (g *Group) Complete(name string) {
	if name == "" {
		name = "complete"
	}
	g.Record(Event{Operation: Completed, Name: name})
}
func guarded(fn func()) { defer func() { _ = recover() }(); fn() }
func failTargets(t Target, name string, err error) {
	guarded(func() {
		if t == nil {
			return
		}
		ss := t.targets()
		info := hostError(err)
		e := Event{Operation: Failed, Name: name, Error: info, Timestamp: time.Now()}
		for _, s := range ss {
			s.record(e)
		}
	})
}
func recordTargets(t Target, e Event) { recordTargetsCount(t, e, 0) }
func recordTargetsCount(t Target, e Event, n int) {
	guarded(func() {
		if t == nil {
			return
		}
		ss := t.targets()
		if len(ss) == 0 {
			return
		}
		e = snapshotEvent(e, ss[0].recorder.c)
		ss[0].recorder.optionCount(n)
		for _, s := range ss {
			s.record(e)
		}
	})
}
func (s journeySnapshot) record(e Event) {
	guarded(func() {
		r := s.recorder
		if r == nil || r.d == nil {
			return
		}
		b := buildEnvelope(r.c, r.d, s.id, s.entity, s.label, e)
		if b != nil {
			r.enqueue(b)
		}
	})
}

// No callback occurs here. Once this barrier returns, application reentry can
// mutate original fields without changing this event or another group member.
func snapshotEvent(e Event, c resolvedConfig) Event {
	if e.Timestamp.IsZero() {
		e.Timestamp = time.Now()
	}
	if e.Error != nil {
		x := *e.Error
		e.Error = &x
	}
	if e.DurationMS != nil {
		x := *e.DurationMS
		e.DurationMS = &x
	}
	if e.Aliases != nil {
		m := map[string]string{}
		if len(e.Aliases) > 1000 { // preserve the existing oversize refusal without copying an unbounded map
			e.aliasesOversize = true
		} else {
			for k, v := range e.Aliases {
				m[k] = v
			}
		}
		e.Aliases = m
	}
	if len(e.DisplayableAliases) > 1000 {
		e.displayOversize = true
	}
	e.DisplayableAliases = append([]string(nil), e.DisplayableAliases[:min(len(e.DisplayableAliases), 1000)]...)
	if e.metadataCapture == nil && e.Metadata != nil {
		x := captureMetadataDeferred(e.Metadata, c)
		e.metadataCapture = &x
	}
	e.Metadata = nil
	if c.CaptureMode != MetadataOnly {
		if e.Input.present {
			e.Input = Payload(captureValue(e.Input.value, c, "input"))
		}
		if e.Output.present {
			e.Output = Payload(captureValue(e.Output.value, c, "output"))
		}
	}
	return e
}
