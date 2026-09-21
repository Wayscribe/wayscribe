package wayscribe

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	redacted     = "[REDACTED]"
	tooLarge     = "[PAYLOAD_TOO_LARGE]"
	uncapturable = "[UNCAPTURABLE]"
	safeInteger  = int64(9007199254740991)
)

var secrets = func() map[string]bool {
	m := map[string]bool{}
	for _, s := range strings.Fields("authorization proxy-authorization cookie set-cookie x-api-key password access_token refresh_token client_secret api_key secret stripe-signature x-hub-signature x-hub-signature-256 x-slack-signature x-hubspot-signature x-hubspot-signature-v3 x-twilio-signature x-shopify-hmac-sha256") {
		m[fold(s)] = true
	}
	return m
}()

func fold(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '-' || r == '_' {
			return -1
		}
		return r
	}, strings.ToLower(s))
}
func repairText(s string) string {
	return strings.ReplaceAll(strings.ToValidUTF8(s, "�"), "\x00", "")
}
func prefixRunes(s string, n int) string {
	for i := range s {
		if n == 0 {
			return s[:i]
		}
		n--
	}
	return s
}
func utf16Length(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}
func truncateText(s string) string {
	return truncateKnown(s, utf16Length(s), strings.Contains(s, "\r\n"))
}
func truncateKnown(s string, length int, hasCRLF bool) string {
	if length <= 65536 {
		return s
	}
	sep := ""
	if hasCRLF {
		sep = "\r\n"
	}
	removed := length - 65536
	for {
		marker := fmt.Sprintf("%s[TRUNCATED: %d characters removed]", sep, removed)
		keep := 65536 - len(marker)
		if length-keep != removed {
			removed = length - keep
			continue
		}
		var b strings.Builder
		b.Grow(65536)
		for _, r := range s {
			units := 1
			if r > 0xffff {
				units = 2
			}
			if keep == 0 {
				break
			}
			if keep < units {
				b.WriteRune('�')
				break
			}
			b.WriteRune(r)
			keep -= units
		}
		return b.String() + marker
	}
}

type captured struct {
	value                          any
	truncated, omitted, unreadable bool
	names                          []Diagnostic
	reports                        []Diagnostic
}
type visit struct {
	kind reflect.Kind
	typ  reflect.Type
	ptr  uintptr
}
type captureWalk struct {
	config    resolvedConfig
	result    captured
	active    map[visit]bool
	remaining int
	field     string
}
type limitExceeded struct{}

func captureValue(value any, c resolvedConfig, field string) (out captured) {
	w := captureWalk{config: c, active: map[visit]bool{}, remaining: 4 * 262144, field: field}
	defer func() {
		if p := recover(); p != nil {
			out = w.result
			if _, ok := p.(limitExceeded); ok {
				out.value = tooLarge
				out.omitted = true
				out.truncated = false
				out.names = nil
			} else {
				out.value = uncapturable
				out.unreadable = true
			}
		}
	}()
	w.result.value = w.walk(reflect.ValueOf(value), 2, "")
	return w.result
}
func (w *captureWalk) spend(n int) {
	w.remaining -= n
	if w.remaining < 0 {
		panic(limitExceeded{})
	}
}

// Keep at most one string-limit prefix while counting the repaired text. A
// long source containing NUL/invalid UTF-8 is never copied in full first.
func (w *captureWalk) text(s string, paths ...string) string {
	path := ""
	if len(paths) > 0 {
		path = paths[0]
	}
	var b strings.Builder
	b.Grow(min(len(s), 65536*3))
	total := 0
	appendText := func(chunk string) {
		for _, r := range chunk {
			if r == 0 {
				continue
			}
			units := 1
			if r > 0xffff {
				units = 2
			}
			if total < 65536 {
				if total+units > 65536 {
					b.WriteRune('�')
				} else {
					b.WriteRune(r)
				}
			}
			total += units
		}
	}
	hasCRLF := strings.Contains(s, "\r\n")
	if !hasCRLF {
		appendText(s)
	} else {
		rest := s
		done := false
		lineIndex := 0
		for {
			line, next, more := strings.Cut(rest, "\r\n")
			if line == "" && lineIndex > 0 {
				done = true
			}
			if !done {
				if name, value, ok := strings.Cut(line, ":"); ok {
					if len(name) > 262144 {
						panic(limitExceeded{})
					}
					name = repairText(name)
					trimmed := strings.TrimLeft(value, " \t")
					space := value[:len(value)-len(trimmed)]
					if trimmed != "" && w.matched(name, name) {
						appendText(name)
						appendText(":")
						appendText(space)
						appendText(redacted)
					} else {
						w.warn(name, path, reflect.ValueOf(trimmed))
						appendText(line)
					}
				} else {
					appendText(line)
				}
			} else {
				appendText(line)
			}
			if !more {
				break
			}
			appendText("\r\n")
			rest = next
			lineIndex++
		}
	}
	out := b.String()
	if total > 65536 {
		w.result.truncated = true
		out = truncateKnown(out, total, hasCRLF)
	}
	w.spend(len(out))
	return out
}
func (w *captureWalk) matched(name, path string) bool {
	if secrets[fold(name)] {
		return true
	}
	if w.config.CaptureMode != FullPayload {
		for _, rule := range w.config.Redact {
			if strings.HasPrefix(rule, "**.") && !strings.ContainsAny(rule[3:], ".*[]") && fold(rule[3:]) == fold(name) {
				return true
			}
			if fold(rule) == fold(name) || fold(rule) == fold(path) || fold(rule) == fold(w.field+"."+path) || pathMatch(rule, path) || pathMatch(rule, w.field+"."+path) {
				return true
			}
		}
	}
	return false
}
func pathMatch(rule, path string) bool {
	r := strings.Split(strings.ReplaceAll(rule, "[*]", ".*"), ".")
	p := strings.Split(strings.ReplaceAll(path, "[*]", ".*"), ".")
	if len(r) != len(p) {
		return false
	}
	for i := range r {
		if r[i] != "*" && fold(r[i]) != fold(p[i]) {
			return false
		}
	}
	return true
}
func (w *captureWalk) warn(name, path string, v reflect.Value) {
	if len(w.result.names) >= 100 {
		return
	}
	for _, known := range w.config.KnownSafeNames {
		if fold(known) == fold(name) {
			return
		}
	}
	// Warning discovery is advisory: stop at a fixed indirection budget. The
	// normal walker still renders cycles and preserves readable siblings.
	for hops := 0; v.IsValid() && (v.Kind() == reflect.Interface || v.Kind() == reflect.Pointer); hops++ {
		if hops >= 64 {
			return
		}
		if v.IsNil() {
			return
		}
		v = v.Elem()
	}
	if !v.IsValid() {
		return
	}
	var value any
	switch v.Kind() {
	case reflect.String:
		value = v.String()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		value = 1
	default:
		return
	}
	if looksSecret(name, value) {
		full := w.field
		if path != "" {
			full += "." + path
		}
		w.result.names = append(w.result.names, Diagnostic{Kind: "unredacted_secret_name", Field: w.field, Name: prefixRunes(name, 256), Path: prefixRunes(full, 1024)})
	}
}
func pathKey(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}
func (w *captureWalk) walk(v reflect.Value, depth int, path string, arrayElement ...bool) any {
	positional := len(arrayElement) > 0 && arrayElement[0]
	w.spend(8)
	if depth > 32 {
		panic(limitExceeded{})
	}
	if !v.IsValid() {
		return nil
	}
	for v.Kind() == reflect.Interface {
		if v.IsNil() {
			return nil
		}
		v = v.Elem()
	}
	if v.CanInterface() {
		switch x := v.Interface().(type) {
		case captured:
			w.result.truncated = w.result.truncated || x.truncated
			w.result.omitted = w.result.omitted || x.omitted
			w.result.unreadable = w.result.unreadable || x.unreadable
			w.result.names = append(w.result.names, x.names...)
			return x.value
		case time.Time:
			if x.Year() < 0 || x.Year() > 9999 {
				w.result.unreadable = true
				return uncapturable
			}
			return w.text(x.UTC().Format(time.RFC3339Nano))
		case []byte:
			if x == nil {
				return nil
			}
			if depth >= 32 {
				panic(limitExceeded{})
			}
			encodedLen := base64.StdEncoding.EncodedLen(len(x))
			if encodedLen > 4*262144 {
				panic(limitExceeded{})
			}
			return w.walk(reflect.ValueOf(map[string]any{"type": "bytes", "base64": base64.StdEncoding.EncodeToString(x)}), depth, path)
		case big.Int:
			if x.BitLen() > 4*262144 {
				panic(limitExceeded{})
			}
			s := x.String()
			if len(s) > 65536 {
				panic(limitExceeded{})
			}
			return w.text(s)
		case json.Number:
			s := string(x)
			if len(s) > 65536 {
				panic(limitExceeded{})
			}
			if n, ok := new(big.Int).SetString(s, 10); ok {
				if n.IsInt64() && n.Int64() <= safeInteger && n.Int64() >= -safeInteger {
					return n.Int64()
				}
				return w.text(n.String())
			}
			n, e := strconv.ParseFloat(s, 64)
			if e != nil || math.IsNaN(n) || math.IsInf(n, 0) {
				return nil
			}
			return n
		}
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Map, reflect.Slice:
		if v.IsNil() {
			return nil
		}
		id := visit{v.Kind(), v.Type(), v.Pointer()}
		if w.active[id] {
			return "[CIRCULAR]"
		}
		w.active[id] = true
		defer delete(w.active, id)
	}
	switch v.Kind() {
	case reflect.Pointer:
		return w.walk(v.Elem(), depth, path, positional)
	case reflect.Bool:
		return v.Bool()
	case reflect.String:
		return w.text(v.String(), path)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n := v.Int()
		if n > safeInteger || n < -safeInteger {
			return w.text(strconv.FormatInt(n, 10))
		}
		return n
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		n := v.Uint()
		if n > uint64(safeInteger) {
			return w.text(strconv.FormatUint(n, 10))
		}
		return n
	case reflect.Float32, reflect.Float64:
		n := v.Float()
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return nil
		}
		return n
	case reflect.Map:
		if v.Len() > 1000 {
			panic(limitExceeded{})
		}
		if v.Type().Key().Kind() != reflect.String {
			w.result.unreadable = true
			return uncapturable
		}
		keys := v.MapKeys()
		sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
		fields := make([]captureField, 0, len(keys))
		for _, key := range keys {
			fields = append(fields, captureField{key.String(), v.MapIndex(key)})
		}
		return w.object(fields, depth, path, positional)
	case reflect.Struct:
		if v.NumField() > 1000 {
			panic(limitExceeded{})
		}
		fields := []captureField{}
		typ := v.Type()
		for i := 0; i < v.NumField(); i++ {
			sf := typ.Field(i)
			if sf.PkgPath != "" {
				continue
			}
			tag := strings.Split(sf.Tag.Get("json"), ",")
			if tag[0] == "-" {
				continue
			}
			name := sf.Name
			if tag[0] != "" {
				name = tag[0]
			}
			omit := false
			for _, opt := range tag[1:] {
				if (opt == "omitempty" && isEmpty(v.Field(i))) || (opt == "omitzero" && v.Field(i).IsZero()) {
					omit = true
				}
			}
			if !omit {
				fields = append(fields, captureField{name, v.Field(i)})
			}
		}
		return w.object(fields, depth, path, positional)
	case reflect.Array, reflect.Slice:
		if v.Len() > 1000 {
			panic(limitExceeded{})
		}
		out := make([]any, v.Len())
		interleaved := v.Len() >= 2 && v.Len()%2 == 0
		common := false
		for i := 0; interleaved && i < v.Len(); i++ {
			raw, ok := stringValue(v.Index(i))
			if !ok {
				interleaved = false
				break
			}
			if i%2 == 0 {
				name := repairedHeaderName(raw)
				if !headerToken.MatchString(name) {
					interleaved = false
					break
				}
				common = common || knownHeader(name)
			}
		}
		interleaved = interleaved && common
		pair := false
		if positional && v.Len() == 2 {
			_, pair = stringValue(v.Index(0))
		}
		for i := 0; i < v.Len(); i++ {
			p := path + "[*]"
			if w.matched("", p) {
				out[i] = redacted
				continue
			}
			if (interleaved && i%2 == 1) || (pair && i == 1) {
				rawName, _ := stringValue(v.Index(i - 1))
				name := repairedHeaderName(rawName)
				child, _ := stringValue(v.Index(i))
				if w.matched(name, pathKey(path, name)) && !commonHeaderValue(child) {
					out[i] = redacted
					continue
				}
				warningPath := path + "[*]"
				if pair {
					warningPath = path
				}
				w.warn(name, warningPath, v.Index(i))
			}
			out[i] = w.walk(v.Index(i), depth+1, p, true)
		}
		return out
	default:
		w.result.unreadable = true
		return uncapturable
	}
}
func isEmpty(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Array, reflect.Map, reflect.Slice, reflect.String:
		return v.Len() == 0
	default:
		return v.IsZero()
	}
}
func stringValue(v reflect.Value) (string, bool) {
	for v.IsValid() && v.Kind() == reflect.Interface {
		v = v.Elem()
	}
	if v.IsValid() && v.Kind() == reflect.String {
		return v.String(), true
	}
	return "", false
}

type captureField struct {
	name  string
	value reflect.Value
}

func (w *captureWalk) object(fields []captureField, depth int, path string, positional bool) map[string]any {
	out := map[string]any{}
	header := ""
	if positional {
		hasName := false
		for _, f := range fields {
			if repairedHeaderName(f.name) == "name" {
				header, hasName = stringValue(f.value)
			}
		}
		if !hasName {
			for _, f := range fields {
				if repairedHeaderName(f.name) == "key" {
					header, _ = stringValue(f.value)
				}
			}
		}
		header = repairedHeaderName(header)
	}
	for _, f := range fields {
		if len(f.name) > 262144 {
			panic(limitExceeded{})
		}
		name := repairText(f.name)
		if utf16Length(name) > 65536 {
			panic(limitExceeded{})
		}
		w.spend(len(name))
		p := pathKey(path, name)
		match := w.matched(name, p)
		if name == "value" && header != "" {
			child, _ := stringValue(f.value)
			match = match || (w.matched(header, pathKey(path, header)) && !commonHeaderValue(child))
			if !match {
				w.warn(header, path, f.value)
			}
		}
		if match {
			out[name] = redacted
		} else {
			w.warn(name, p, f.value)
			out[name] = w.walk(f.value, depth+1, p)
		}
	}
	return out
}

var headerToken = regexp.MustCompile("^:?[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

func repairedHeaderName(s string) string {
	// An over-limit name cannot match a configured name or remain a header
	// token after string truncation. Leave its normal capture to the walker;
	// shape discovery must not turn ordinary string truncation into omission.
	if utf8.ValidString(s) && !strings.ContainsRune(s, 0) {
		if utf16Length(s) > 65536 {
			return ""
		}
		return s
	}
	var b strings.Builder
	units := 0
	for _, r := range s {
		if r == 0 {
			continue
		}
		units++
		if r > 0xffff {
			units++
		}
		if units > 65536 {
			return ""
		}
		b.WriteRune(r)
	}
	return b.String()
}
func commonHeaderValue(s string) bool {
	// Every recognized common header name fits in 32 ASCII characters. NUL repair
	// can shrink a long value, so scan without copying its unbounded source.
	var b strings.Builder
	for _, r := range s {
		if r == 0 {
			continue
		}
		if r > 127 || b.Len() >= 32 {
			return false
		}
		b.WriteByte(byte(r))
	}
	return knownHeader(b.String())
}
func knownHeader(s string) bool {
	switch strings.ToLower(s) {
	case ":authority", ":method", ":path", ":protocol", ":scheme", ":status", "accept", "accept-encoding", "accept-language", "authorization", "cache-control", "connection", "content-length", "content-type", "cookie", "date", "etag", "host", "if-none-match", "location", "origin", "proxy-authorization", "referer", "set-cookie", "transfer-encoding", "user-agent", "vary", "www-authenticate", "x-api-key", "x-forwarded-for", "x-request-id":
		return true
	}
	return false
}

var versionSuffix = regexp.MustCompile(`v?[0-9]+$`)

func looksSecret(name string, value any) bool {
	name = versionSuffix.ReplaceAllString(fold(name), "")
	if s, ok := value.(string); ok {
		if s == "" || s == redacted {
			return false
		}
		trimmed := strings.TrimSpace(s)
		for _, x := range strings.Fields("true false none basic bearer oauth required optional") {
			if len(trimmed) == len(x) && strings.EqualFold(trimmed, x) {
				return false
			}
		}
	}
	terms := strings.Fields("token secret password passwd passphrase passcode credential credentials authorization auth bearer cookie cookies signature jwt otp cvv cvc apikey accesskey secretkey privatekey signingkey encryptionkey masterkey sessionkey authkey hmackey sharedkey subscriptionkey sessionid sessid secretstring secretvalue codeverifier clientassertion authcode authorizationcode otpcode mfacode recoverycode connectionstring databaseurl dsn passwordconfirmation")
	for _, term := range terms {
		if !strings.HasSuffix(name, term) {
			continue
		}
		pre := strings.TrimSuffix(name, term)
		except := ""
		if term == "token" {
			except = "page next continuation pagination sync client clientrequest idempotency resume cancel cursor start stop bos eos pad unk sep cls mask"
		}
		if term == "signature" {
			except = "email"
		}
		excluded := false
		for _, p := range strings.Fields(except) {
			if strings.HasSuffix(pre, p) {
				excluded = true
			}
		}
		if excluded {
			continue
		}
		if term == "auth" {
			if s, ok := value.(string); ok && utf8.RuneCountInString(s) < 8 {
				continue
			}
		}
		return true
	}
	if name == "pin" || name == "hmac" {
		return true
	}
	for _, p := range strings.Fields("card atm user account security login new old current") {
		if strings.HasSuffix(name, p+"pin") {
			return true
		}
	}
	for _, p := range strings.Fields("db user admin root database") {
		if strings.HasSuffix(name, p+"pwd") {
			return true
		}
	}
	return false
}
