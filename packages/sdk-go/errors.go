package wayscribe

import (
	"reflect"
	"regexp"
	"strings"
)

var privateKey = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)`)
var urlCredentials = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^\s/?#"'<>,;\[\]]+@`)
var jwtPattern = regexp.MustCompile(`eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*`)
var providerPattern = regexp.MustCompile(`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9+/=]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_.-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|(?:wsk|fr)_[A-Za-z0-9_-]{32}|sk-(?:proj-|ant-(?:api|admin)[0-9][0-9]-)?[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|xapp-[0-9A-Za-z-]{10,}|hf_[A-Za-z0-9]{30,}`)
var bearerPattern = regexp.MustCompile(`(?i)(Bearer|Basic|Digest)([ \t]+)([A-Za-z0-9._~+/-]{8,}=*)`)
var assignmentPattern = regexp.MustCompile(`(["']?)([A-Za-z][A-Za-z0-9_.-]*)(["']?)([ \t]*[=:][ \t]*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&,;<>"']+)`)
var cookiePattern = regexp.MustCompile(`(?im)(\b(?:cookie|set-cookie):[ \t]*)([^\r\n]+)`)
var queryKey = regexp.MustCompile(`([?&]key=)([^\s&#]+)`)
var webhookPattern = regexp.MustCompile(`(hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/|discord(?:app)?\.com/api/webhooks/[0-9]+/)[A-Za-z0-9_-]+`)

func maskText(s string) string {
	s = repairText(s)
	s = privateKey.ReplaceAllString(s, redacted)
	s = urlCredentials.ReplaceAllString(s, "${1}"+redacted+"@")
	s = jwtPattern.ReplaceAllString(s, redacted)
	s = providerPattern.ReplaceAllString(s, redacted)
	s = webhookPattern.ReplaceAllString(s, "${1}"+redacted)
	s = cookiePattern.ReplaceAllStringFunc(s, func(m string) string {
		v := cookiePattern.FindStringSubmatch(m)
		if strings.Contains(v[2], "=") {
			return v[1] + redacted
		}
		return m
	})
	s = queryKey.ReplaceAllString(s, "${1}"+redacted)
	s = bearerPattern.ReplaceAllString(s, "${1}${2}"+redacted)
	return assignmentPattern.ReplaceAllStringFunc(s, func(m string) string {
		v := assignmentPattern.FindStringSubmatch(m)
		name := fold(v[2])
		secret := secrets[name] || looksSecret(v[2], v[5])
		if (name == "token" || name == "signature" || name == "sig" || name == "pwd" || name == "pass") && strings.Contains(v[4], "=") {
			secret = true
		}
		if !secret || strings.HasPrefix(v[5], redacted) {
			return m
		}
		value := v[5]
		for _, word := range strings.Fields("not missing unset undefined null none true false required invalid") {
			if strings.ToLower(value) == word {
				return m
			}
		}
		if strings.Contains(v[4], ":") && v[1] == "" && !strings.HasSuffix(v[4], " ") && !strings.HasSuffix(v[4], "\t") {
			return m
		}
		quote := ""
		if strings.HasPrefix(value, "\"") || strings.HasPrefix(value, "'") {
			quote = value[:1]
		}
		return v[1] + v[2] + v[3] + v[4] + quote + redacted + quote
	})
}

// Explicit host error handling is the only discovery path that calls Error.
func hostError(err error) (out *ErrorInfo) {
	out = &ErrorInfo{Message: uncapturable}
	defer func() { _ = recover() }()
	if err != nil {
		t := reflect.TypeOf(err)
		for t.Kind() == reflect.Pointer {
			t = t.Elem()
		}
		out.Type = t.Name()
		out.Message = err.Error()
	}
	return out
}
func captureError(e ErrorInfo, d *diagnostics) map[string]any {
	message := maskText(e.Message)
	if message == "" {
		message = uncapturable
	}
	if len([]rune(message)) > 4096 {
		message = prefixRunes(message, 4085) + "[TRUNCATED]"
	}
	out := map[string]any{"message": message}
	if e.Type != "" {
		out["type"] = prefixRunes(maskText(e.Type), 256)
	}
	if e.Code != "" {
		out["code"] = prefixRunes(maskText(e.Code), 256)
	}
	if e.Stack != "" {
		out["stack"] = prefixRunes(maskText(e.Stack), 16384)
	}
	publicWarning(message, "error", d)
	return out
}

var emailPattern = regexp.MustCompile(`(?:^|[\s<>()"',;=:])[^\s<>()"',;=:@/\[\]]+@([A-Za-z0-9.-]+)`)
var phonePattern = regexp.MustCompile(`(?:^|[\s<>()\["',;=:])\+([0-9][0-9 ().-]{0,19})`)
var tldPattern = regexp.MustCompile(`^[A-Za-z]{2,}$`)
var timezonePattern = regexp.MustCompile(`^(?:0[0-9]|1[0-4])(?:00|15|30|45)(?:[^0-9]|$)`)

func publicWarning(value, field string, d *diagnostics) {
	sample := prefixRunes(value, 1024)
	for _, m := range emailPattern.FindAllStringSubmatchIndex(sample, -1) {
		after := ""
		if m[1] < len(sample) {
			after = sample[m[1] : m[1]+1]
		}
		domain := strings.TrimSuffix(sample[m[2]:m[3]], ".")
		labels := strings.Split(domain, ".")
		if after != ":" && after != "/" && after != "@" && len(labels) >= 2 && tldPattern.MatchString(labels[len(labels)-1]) && !strings.Contains(domain, "..") {
			d.emit(Diagnostic{Kind: "personal_data", Field: field, Shape: "email"})
			break
		}
	}
	for _, m := range phonePattern.FindAllStringSubmatch(sample, -1) {
		run := strings.TrimSpace(m[1])
		if timezonePattern.MatchString(run) {
			continue
		}
		digits := 0
		separator := false
		for _, r := range run {
			if r >= '0' && r <= '9' {
				digits++
			} else {
				separator = true
			}
		}
		if digits >= 8 && digits <= 15 && (digits >= 10 || separator) {
			d.emit(Diagnostic{Kind: "personal_data", Field: field, Shape: "phone"})
			break
		}
	}
}
