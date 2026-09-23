"""Credential masking for error text; labels and aliases are public text."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._diagnostics import Diagnostics
import re
from collections.abc import Mapping

from ._capture import REDACTED, SECRETS, fold, repair_text

_PROVIDER = "(?<![A-Za-z0-9_\\]-])(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9+/=]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}(?:\\.[A-Za-z0-9_-]+)*|(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])|AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])|(?:wsk|fr)_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])|sk-(?:proj-|ant-(?:api|admin)\\d\\d-)?[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])|SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}|xapp-[0-9A-Za-z-]{10,}|hf_[A-Za-z0-9]{30,})"


def mask_text(text: str) -> str:
    text = repair_text(text)
    text = re.sub(
        "-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[\\s\\S]*$)",
        REDACTED,
        text,
    )
    text = re.sub(
        "(?<![A-Za-z0-9+.\\]-])([A-Za-z][A-Za-z0-9+.-]*://)[^\\s/?#\"\\'<>,;\\[\\]]+@",
        lambda m: m[1] + REDACTED + "@",
        text,
    )
    text = re.sub(
        "(?<![A-Za-z0-9_\\]-])eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*",
        REDACTED,
        text,
    )
    text = re.sub(_PROVIDER, REDACTED, text)
    text = re.sub(
        "(hooks\\.slack\\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/)[A-Za-z0-9]+|(discord(?:app)?\\.com/api/webhooks/\\d+/)[A-Za-z0-9_-]+",
        lambda m: (m[1] or m[2]) + REDACTED,
        text,
    )
    assignment = re.compile(
        "(?<![A-Za-z0-9_.\\]-])([\"']?)([A-Za-z][A-Za-z0-9_.-]*)\\1([ \\t]*[=:][ \\t]*)(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[^\\s&,;<>\"']+)"
    )

    def replace(m):
        name = fold(m[2])
        words = re.sub("([a-z])([A-Z])", "\\1 \\2", m[2]).lower()
        words = re.split("[_.\\s-]+", words)
        secret = (
            name in SECRETS
            or name in ("token", "signature", "sig", "passwd", "pwd", "pass")
            and "=" in m[3]
            or len(words) > 1
            and words[-1]
            in (
                "password",
                "passwd",
                "pwd",
                "passphrase",
                "secret",
                "token",
                "credential",
                "credentials",
            )
            and (
                not (
                    words[-1] == "token"
                    and words[-2]
                    in (
                        "page",
                        "next",
                        "continuation",
                        "pagination",
                        "cursor",
                        "sync",
                        "resume",
                        "marker",
                        "csrf",
                        "xsrf",
                    )
                )
            )
            or " ".join(words[-2:])
            in (
                "api key",
                "secret key",
                "private key",
                "access key",
                "account key",
                "signing key",
                "master key",
                "shared key",
                "encryption key",
                "auth key",
                "session key",
                "client key",
            )
        )
        if not secret or m[4].startswith(REDACTED):
            return m[0]
        value = m[4]
        quote = value[0] if value[0] in "\"'" else ""
        if value.lower() in (
            "not",
            "missing",
            "unset",
            "undefined",
            "null",
            "none",
            "true",
            "false",
            "required",
            "invalid",
        ):
            return m[0]
        if ":" in m[3] and (not m[1]) and (not m[3].endswith((" ", "\t"))):
            return m[0]
        if name in ("authorization", "proxyauthorization") and value.lower() in (
            "bearer",
            "basic",
            "digest",
        ):
            return m[0]
        return m[1] + m[2] + m[1] + m[3] + quote + REDACTED + quote

    text = re.sub(
        "(?im)(\\b(?:cookie|set-cookie):[ \\t]*)([^\\r\\n]+)",
        lambda m: (
            m[1] + REDACTED if not m[2].startswith(REDACTED) and "=" in m[2] else m[0]
        ),
        text,
    )
    text = re.sub(
        "([?&]key=)([^\\s&#]+)",
        lambda m: m[1] + REDACTED if m[2] != REDACTED else m[0],
        text,
    )
    text = re.sub(
        '(\\\\"[A-Za-z][A-Za-z0-9_.-]*\\\\"[ \\t]*[=:][ \\t]*\\\\")(?:(?!\\\\").)*(?:\\\\")',
        lambda m: mask_text(m[0].replace('\\"', '"')).replace('"', '\\"'),
        text,
    )
    text = re.sub(
        "(?i)(\\b(?:authorization|proxy-authorization):[ \\t]*[A-Za-z-]+[ \\t]+)([A-Za-z0-9._~+/-]+=*)",
        lambda m: m[1] + REDACTED if not m[2].isalpha() else m[0],
        text,
    )
    text = assignment.sub(replace, text)
    return re.sub(
        "(?<![A-Za-z0-9_\\]-])(Bearer|Basic|Digest)([ \\t]+)([A-Za-z0-9._~+/-]{8,}=*)",
        lambda m: m[1] + m[2] + REDACTED,
        text,
        flags=re.IGNORECASE,
    )


# The value a reader sees in full, by the name the Node SDK reports it under.
_PUBLIC_FIELDS = {
    "journey_label": "journeyLabel",
    "displayable_alias": "displayableAliases",
    "error": "errorMessage",
}


def public_warning(value: str, field: str, diagnostics: Diagnostics) -> None:
    field = _PUBLIC_FIELDS.get(field, field)
    sample = value[:1024]
    for match in re.finditer(
        "(?<![^\\s<>()\"',;=:])[^\\s<>()\"',;=:@/\\[\\]]+@([A-Za-z0-9.-]+)", sample
    ):
        after = sample[match.end() : match.end() + 1]
        labels = match[1].rstrip(".").split(".")
        if (
            after not in (":", "/", "@")
            and len(labels) >= 2
            and all(labels)
            and re.fullmatch("[A-Za-z]{2,}", labels[-1])
        ):
            diagnostics.emit(
                "personal_data_in_public_value",
                "personal_data_shape",
                {"field": field, "shape": "email"},
            )
            break
    for match in re.finditer(
        "(?:^|[\\s<>()\\[\"',;=:])\\+([0-9][0-9 ().-]{0,19})", sample
    ):
        run = match[1].rstrip()
        digits = re.sub("\\D", "", run)
        if re.match("^(?:0[0-9]|1[0-4])(?:00|15|30|45)(?!\\d)", run):
            continue
        if 8 <= len(digits) <= 15 and (
            len(digits) >= 10 or re.search("\\d[ ().-]+\\d", run)
        ):
            diagnostics.emit(
                "personal_data_in_public_value",
                "personal_data_shape",
                {"field": field, "shape": "phone"},
            )


def capture_error(error: object, diagnostics: Diagnostics) -> dict[str, str]:
    try:
        if isinstance(error, BaseException):
            message = str(error)
            kind = type(error).__name__
            code = None
            stack = None
        elif isinstance(error, Mapping):
            message = error.get("message", "[UNCAPTURABLE]")
            kind = error.get("type")
            code = error.get("code")
            stack = error.get("stack")
        elif type(error) is str:
            message = error
            kind = None
            code = None
            stack = None
        else:
            message = "[UNCAPTURABLE]"
            kind = None
            code = None
            stack = None
        if type(message) is not str:
            message = "[UNCAPTURABLE]"
        masked = mask_text(message)
        out = {
            "message": (
                masked if len(masked) <= 4096 else masked[:4085] + "[TRUNCATED]"
            )
            or "[UNCAPTURABLE]"
        }
        for key, value, limit in (
            ("type", kind, 256),
            ("code", code, 256),
            ("stack", stack, 16384),
        ):
            if type(value) is str:
                out[key] = mask_text(value)[:limit]
        public_warning(out["message"], "error", diagnostics)
        return out
    except Exception:
        diagnostics.emit("capture_error", "unexpected_error", {"field": "error"})
        return {"message": "[UNCAPTURABLE]"}
