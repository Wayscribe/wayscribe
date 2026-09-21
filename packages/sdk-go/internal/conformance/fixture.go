package conformance

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

type fixture struct {
	ID        string         `json:"id"`
	Languages []string       `json:"languages"`
	Recorder  map[string]any `json:"recorder"`
	Calls     []fixtureCall  `json:"calls"`
	Expect    struct {
		Diagnostics []Diagnostic `json:"diagnostics"`
	} `json:"expect"`
}

type fixtureCall struct {
	Call     string         `json:"call"`
	Name     string         `json:"name"`
	Journeys int            `json:"journeys"`
	Repeat   int            `json:"repeat"`
	Args     map[string]any `json:"args"`
}

type absentValue struct{}
type fixtureProjection func(any, map[string]any) any
type fixtureError struct{ message string }
type ConnectionError struct{ message string }

func (e fixtureError) Error() string    { return e.message }
func (e ConnectionError) Error() string { return e.message }

type deferredReference struct {
	parent any
	key    any
	path   string
}

func expandFixture(value any, run string) (any, error) {
	var deferred []deferredReference
	var build func(any) (any, error)
	var place func(any, any, any) (any, error)

	place = func(child, parent, key any) (any, error) {
		if tag, supplied, ok := singleTag(child); ok && (tag == "$cycle" || tag == "$ref") {
			path, ok := supplied.(string)
			if !ok {
				return nil, fmt.Errorf("%s path is not a string", tag)
			}
			deferred = append(deferred, deferredReference{parent: parent, key: key, path: path})
			return absentValue{}, nil
		}
		return build(child)
	}

	build = func(child any) (any, error) {
		switch value := child.(type) {
		case string:
			return strings.ReplaceAll(value, "{{run}}", run), nil
		case []any:
			out := make([]any, 0, len(value))
			for _, item := range value {
				expanded, err := place(item, out, len(out))
				if err != nil {
					return nil, err
				}
				if _, absent := expanded.(absentValue); absent {
					expanded = nil
				}
				out = append(out, expanded)
			}
			return out, nil
		case map[string]any:
			if tag, supplied, ok := singleTag(value); ok {
				switch tag {
				case "$literal":
					return substituteFixture(supplied, run), nil
				case "$string":
					spec := supplied.(map[string]any)
					return strings.Repeat(spec["char"].(string), fixtureInt(spec["count"])), nil
				case "$array":
					spec := supplied.(map[string]any)
					out := make([]any, fixtureInt(spec["count"]))
					for index := range out {
						item, err := build(spec["value"])
						if err != nil {
							return nil, err
						}
						out[index] = item
					}
					return out, nil
				case "$concat":
					var out strings.Builder
					for _, piece := range supplied.([]any) {
						expanded, err := build(piece)
						if err != nil {
							return nil, err
						}
						out.WriteString(fmt.Sprint(expanded))
					}
					return out.String(), nil
				case "$nest":
					spec := supplied.(map[string]any)
					out, err := build(spec["leaf"])
					if err != nil {
						return nil, err
					}
					for range fixtureInt(spec["depth"]) {
						out = map[string]any{"n": out}
					}
					return out, nil
				case "$date":
					return time.Parse(time.RFC3339Nano, supplied.(string))
				case "$bigint":
					integer, ok := new(big.Int).SetString(supplied.(string), 10)
					if !ok {
						return nil, fmt.Errorf("invalid bigint %q", supplied)
					}
					return integer, nil
				case "$number":
					switch supplied {
					case "NaN":
						return math.NaN(), nil
					case "Infinity":
						return math.Inf(1), nil
					case "-Infinity":
						return math.Inf(-1), nil
					}
				case "$undefined":
					return absentValue{}, nil
				case "$utf16":
					return fixtureUTF16(supplied.([]any)), nil
				case "$map":
					return build(supplied)
				case "$set":
					return build(supplied)
				case "$buffer":
					return []byte(supplied.(string)), nil
				case "$projection":
					path := supplied.(string)
					return fixtureProjection(func(argument any, _ map[string]any) any {
						result, err := resolveFixture(argument, path)
						if err != nil {
							panic(err)
						}
						return result
					}), nil
				case "$throwingProjection":
					message := supplied.(string)
					return fixtureProjection(func(any, map[string]any) any { panic(message) }), nil
				case "$error":
					spec, err := build(supplied)
					if err != nil {
						return nil, err
					}
					fields := spec.(map[string]any)
					message, _ := fields["message"].(string)
					if fields["name"] == "ConnectionError" {
						return ConnectionError{message: message}, nil
					}
					return fixtureError{message: message}, nil
				case "$throwingGetter":
					return nil, errors.New("throwing getters are not representable in Go")
				default:
					return nil, fmt.Errorf("unknown fixture tag %s", tag)
				}
			}
			out := make(map[string]any, len(value))
			for name, item := range value {
				key := strings.ReplaceAll(name, "{{run}}", run)
				expanded, err := place(item, out, key)
				if err != nil {
					return nil, err
				}
				if _, absent := expanded.(absentValue); !absent {
					out[key] = expanded
				}
			}
			return out, nil
		default:
			return child, nil
		}
	}

	built, err := build(value)
	if err != nil {
		return nil, err
	}
	for _, reference := range deferred {
		resolved, err := resolveFixture(built, reference.path)
		if err != nil {
			return nil, err
		}
		switch parent := reference.parent.(type) {
		case map[string]any:
			parent[reference.key.(string)] = resolved
		case []any:
			parent[reference.key.(int)] = resolved
		default:
			return nil, fmt.Errorf("unsupported reference parent %T", reference.parent)
		}
	}
	return built, nil
}

func singleTag(value any) (string, any, bool) {
	object, ok := value.(map[string]any)
	if !ok || len(object) != 1 {
		return "", nil, false
	}
	for key, supplied := range object {
		if strings.HasPrefix(key, "$") && key != "$matches" && key != "$absent" {
			return key, supplied, true
		}
	}
	return "", nil, false
}

func substituteFixture(value any, run string) any {
	switch value := value.(type) {
	case string:
		return strings.ReplaceAll(value, "{{run}}", run)
	case []any:
		out := make([]any, len(value))
		for index, item := range value {
			out[index] = substituteFixture(item, run)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, item := range value {
			out[strings.ReplaceAll(key, "{{run}}", run)] = substituteFixture(item, run)
		}
		return out
	default:
		return value
	}
}

func fixtureInt(value any) int {
	switch value := value.(type) {
	case json.Number:
		result, _ := strconv.Atoi(value.String())
		return result
	case float64:
		return int(value)
	case int:
		return value
	default:
		panic(fmt.Sprintf("fixture integer has type %T", value))
	}
}

func fixtureUTF16(values []any) string {
	units := make([]uint16, len(values))
	for index, value := range values {
		units[index] = uint16(fixtureInt(value))
	}
	var out strings.Builder
	for index := 0; index < len(units); index++ {
		unit := units[index]
		if utf16.IsSurrogate(rune(unit)) {
			if index+1 < len(units) {
				decoded := utf16.DecodeRune(rune(unit), rune(units[index+1]))
				if decoded != '\uFFFD' {
					out.WriteRune(decoded)
					index++
					continue
				}
			}
			out.WriteByte(0xff)
			continue
		}
		out.WriteRune(rune(unit))
	}
	return out.String()
}

func resolveFixture(root any, pointer string) (any, error) {
	if pointer == "" || pointer == "#" {
		return root, nil
	}
	current := root
	for _, raw := range strings.Split(strings.TrimPrefix(strings.TrimPrefix(pointer, "#"), "/"), "/") {
		segment := strings.ReplaceAll(strings.ReplaceAll(raw, "~1", "/"), "~0", "~")
		switch value := current.(type) {
		case map[string]any:
			var ok bool
			current, ok = value[segment]
			if !ok {
				return nil, fmt.Errorf("JSON pointer %q does not resolve", pointer)
			}
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(value) {
				return nil, fmt.Errorf("JSON pointer %q does not resolve", pointer)
			}
			current = value[index]
		case []byte:
			if segment != "length" {
				return nil, fmt.Errorf("JSON pointer %q does not resolve", pointer)
			}
			return len(value), nil
		case string:
			if segment != "length" {
				return nil, fmt.Errorf("JSON pointer %q does not resolve", pointer)
			}
			return len(value), nil
		default:
			return nil, fmt.Errorf("JSON pointer %q does not resolve through %T", pointer, current)
		}
	}
	return current, nil
}
