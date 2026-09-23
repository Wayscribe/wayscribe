package wayscribe

import (
	"errors"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type Config struct {
	Endpoint, APIKey, Service, Environment                                                                             string
	CaptureMode                                                                                                        CaptureMode
	Redact, KnownSafeNames                                                                                             []string
	JourneyIDSecret                                                                                                    string
	Propagation                                                                                                        PropagationLevel
	Deployment                                                                                                         map[string]string
	OnDiagnostic                                                                                                       func(Diagnostic)
	LogDiagnostics                                                                                                     bool
	BatchSize, MaxBufferedEvents, MaxEventBytes, MaxConcurrentSends, MaxAttempts, BreakerThreshold, EventRetryMaxSends int
	FlushInterval, RequestTimeout, BackoffBase, BackoffMax, BreakerReset, EventRetryBudget                             time.Duration
}

// Resolution has no callbacks, locks, network, or ambient configuration.
// The returned lists and maps belong to the SDK and are treated as immutable.
type resolvedConfig struct {
	Config
	enabled bool
}

func validText(s string, max int, blank bool) bool {
	return s != "" && utf8.ValidString(s) && !strings.ContainsRune(s, 0) && utf8.RuneCountInString(s) <= max && (blank || strings.TrimSpace(strings.Trim(s, "\ufeff")) != "")
}

// parseHTTPURL is url.Parse with one rule every supported toolchain agrees on:
// a bracket in the host is only the delimiter of an IPv6 literal. net/url
// accepted hosts such as "[REDACTED]" and "a[b]" before Go 1.24.8/1.25.2.
func parseHTTPURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || !strings.ContainsAny(u.Host, "[]") {
		return u, err
	}
	end := strings.IndexByte(u.Host, ']')
	if !strings.HasPrefix(u.Host, "[") || end < 0 || strings.ContainsAny(u.Host[end+1:], "[]") {
		return nil, errBracketedHost
	}
	if a, e := netip.ParseAddr(u.Hostname()); e != nil || !a.Is6() {
		return nil, errBracketedHost
	}
	return u, nil
}

var errBracketedHost = errors.New("bracketed host is not an IPv6 literal")

func resolveConfig(c Config) (resolvedConfig, []Diagnostic) {
	r := resolvedConfig{Config: c}
	r.OnDiagnostic = nil
	r.Redact = nil
	r.KnownSafeNames = nil
	r.Deployment = map[string]string{}
	var issues []Diagnostic
	reject := func(name string) {
		code := "setting_unusable"
		if name == "Endpoint" || name == "APIKey" || name == "Service" || name == "Environment" {
			code = "required_setting_unusable"
		}
		issues = append(issues, Diagnostic{Kind: "configuration_error", Code: code, Field: name})
	}
	for _, x := range []struct {
		name  string
		p     *string
		limit int
	}{{"Endpoint", &r.Endpoint, 65536}, {"APIKey", &r.APIKey, 65536}, {"Service", &r.Service, 128}, {"Environment", &r.Environment, 64}} {
		if !validText(*x.p, x.limit, false) {
			reject(x.name)
			*x.p = ""
		}
	}
	if r.Endpoint != "" {
		u, e := parseHTTPURL(r.Endpoint)
		validPort := true
		if e == nil && u.Port() != "" {
			p, err := strconv.Atoi(u.Port())
			validPort = err == nil && p >= 0 && p <= 65535
		}
		if e != nil || !validPort || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.IndexFunc(r.Endpoint, func(c rune) bool { return c <= 32 || c == 127 }) >= 0 {
			reject("Endpoint")
			r.Endpoint = ""
		}
	}
	if r.APIKey != "" && strings.IndexFunc(r.APIKey, func(c rune) bool { return c < 32 || c > 126 }) >= 0 {
		reject("APIKey")
		r.APIKey = ""
	}
	if strings.HasPrefix(r.Endpoint, "http://") {
		issues = append(issues, Diagnostic{Kind: "insecure_endpoint", Code: "unencrypted_endpoint"})
	}
	r.enabled = r.Endpoint != "" && r.APIKey != "" && r.Service != "" && r.Environment != ""
	if r.CaptureMode == "" {
		r.CaptureMode = RedactedPayload
	}
	if r.CaptureMode != MetadataOnly && r.CaptureMode != RedactedPayload && r.CaptureMode != FullPayload {
		reject("CaptureMode")
		r.CaptureMode = RedactedPayload
	}
	if r.Propagation == "" {
		r.Propagation = JourneyAndType
	}
	if r.Propagation != JourneyOnly && r.Propagation != JourneyAndType && r.Propagation != Full {
		reject("Propagation")
		r.Propagation = JourneyAndType
	}
	for _, v := range []struct {
		name string
		src  []string
		dst  *[]string
	}{{"Redact", c.Redact, &r.Redact}, {"KnownSafeNames", c.KnownSafeNames, &r.KnownSafeNames}} {
		bad := len(v.src) > 1000
		for _, s := range v.src[:min(len(v.src), 1000)] {
			if !validText(s, 1024, false) {
				bad = true
				continue
			}
			*v.dst = append(*v.dst, s)
		}
		if bad {
			reject(v.name)
		}
	}
	if c.JourneyIDSecret != "" && (!validText(c.JourneyIDSecret, 65536, false) || len(c.JourneyIDSecret) < 32) {
		reject("JourneyIDSecret")
		r.JourneyIDSecret = ""
	}
	for _, v := range []struct {
		name     string
		p        *int
		def, max int
	}{{"BatchSize", &r.BatchSize, 50, 100}, {"MaxBufferedEvents", &r.MaxBufferedEvents, 1000, 9007199254740991}, {"MaxEventBytes", &r.MaxEventBytes, 262144, 262144}, {"MaxConcurrentSends", &r.MaxConcurrentSends, 4, 16}, {"MaxAttempts", &r.MaxAttempts, 3, 9007199254740991}, {"BreakerThreshold", &r.BreakerThreshold, 5, 9007199254740991}, {"EventRetryMaxSends", &r.EventRetryMaxSends, 10, 9007199254740991}} {
		if *v.p == 0 {
			*v.p = v.def
		} else if *v.p < 0 {
			reject(v.name)
			*v.p = v.def
		} else if *v.p > v.max {
			reject(v.name)
			*v.p = v.max
		}
	}
	for _, v := range []struct {
		name string
		p    *time.Duration
		def  time.Duration
	}{{"FlushInterval", &r.FlushInterval, time.Second}, {"RequestTimeout", &r.RequestTimeout, 1500 * time.Millisecond}, {"BackoffBase", &r.BackoffBase, 100 * time.Millisecond}, {"BackoffMax", &r.BackoffMax, 2 * time.Second}, {"BreakerReset", &r.BreakerReset, 30 * time.Second}, {"EventRetryBudget", &r.EventRetryBudget, 30 * time.Second}} {
		if *v.p == 0 {
			*v.p = v.def
		} else if *v.p < 0 {
			reject(v.name)
			*v.p = v.def
		}
	}
	if len(c.Deployment) > 1000 {
		reject("Deployment")
	} else {
		for k, v := range c.Deployment {
			limit := map[string]int{"gitCommit": 128, "version": 128, "image": 512}[k]
			if limit == 0 {
				reject("Deployment.*")
			} else if !validText(v, limit, false) {
				reject("Deployment." + k)
			} else {
				r.Deployment[k] = v
			}
		}
		if c.Deployment != nil && len(r.Deployment) == 0 {
			reject("Deployment")
		}
	}
	return r, issues
}
