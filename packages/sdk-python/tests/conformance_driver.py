#!/usr/bin/env python3
"""Run the language-neutral SDK fixtures through the public Python recorder."""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import inspect
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from wayscribe import create_recorder

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURES = ROOT / "packages/protocol/conformance/sdk"
SKIPPED = {
    "sdk/metadata-uncapturable": "Node-only throwing property getter",
    "sdk/uncapturable-payload": "Node-only throwing property getter",
}
UNDEFINED = object()


class _CaptureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), _CaptureHandler)
        self.batches: list[str] = []
        self.lock = threading.Lock()


class _CaptureHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        parsed = json.loads(body)
        with self.server.lock:
            self.server.batches.append(body)
        response = json.dumps(
            {
                "data": {
                    "results": [
                        {"status": "accepted"} for _entry in parsed.get("events", [])
                    ]
                }
            },
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(202)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format: str, *args: object) -> None:
        return


def _single_tag(value: object) -> tuple[str, object] | None:
    if type(value) is not dict or len(value) != 1:
        return None
    key = next(iter(value))
    if (
        type(key) is not str
        or not key.startswith("$")
        or key in ("$matches", "$absent")
    ):
        return None
    return key, value[key]


def _substitute(value: object, run: str) -> object:
    if type(value) is str:
        return value.replace("{{run}}", run)
    if type(value) is list:
        return [_substitute(child, run) for child in value]
    if type(value) is dict:
        return {
            str(key).replace("{{run}}", run): _substitute(child, run)
            for key, child in value.items()
        }
    return value


def _resolve(root: object, pointer: str) -> object:
    if pointer in ("", "#"):
        return root
    current = root
    for raw in pointer.removeprefix("#").removeprefix("/").split("/"):
        segment = raw.replace("~1", "/").replace("~0", "~")
        if type(current) is list:
            current = current[int(segment)]
        elif type(current) is dict:
            current = current[segment]
        elif segment == "length" and type(current) in (bytes, bytearray, str, tuple):
            current = len(current)
        else:
            raise ValueError(f"JSON pointer {pointer!r} does not resolve")
    return current


def _expand(value: object, run: str) -> object:
    deferred: list[tuple[dict[str, object] | list[object], str | int, str]] = []

    def place(
        child: object, parent: dict[str, object] | list[object], key: str | int
    ) -> object:
        tagged = _single_tag(child)
        if tagged is not None and tagged[0] in ("$cycle", "$ref"):
            deferred.append((parent, key, str(tagged[1])))
            return UNDEFINED
        return build(child)

    def build(child: object) -> object:
        if type(child) is str:
            return child.replace("{{run}}", run)
        if type(child) is list:
            result: list[object] = []
            for item in child:
                result.append(place(item, result, len(result)))
            return result
        if type(child) is not dict:
            return child

        tagged = _single_tag(child)
        if tagged is not None:
            tag, supplied = tagged
            if tag == "$literal":
                return _substitute(supplied, run)
            if tag == "$string":
                return str(supplied["char"]) * int(supplied["count"])
            if tag == "$array":
                return [
                    build(supplied["value"]) for _index in range(int(supplied["count"]))
                ]
            if tag == "$concat":
                return "".join(str(build(piece)) for piece in supplied)
            if tag == "$nest":
                nested = build(supplied["leaf"])
                for _level in range(int(supplied["depth"])):
                    nested = {"n": nested}
                return nested
            if tag == "$date":
                return dt.datetime.fromisoformat(str(supplied).replace("Z", "+00:00"))
            if tag == "$bigint":
                return int(str(supplied))
            if tag == "$number":
                return {
                    "NaN": float("nan"),
                    "Infinity": float("inf"),
                    "-Infinity": -float("inf"),
                }[str(supplied)]
            if tag == "$undefined":
                return UNDEFINED
            if tag == "$utf16":
                encoded = b"".join(int(unit).to_bytes(2, "little") for unit in supplied)
                return encoded.decode("utf-16-le", "surrogatepass")
            if tag == "$map":
                return build(supplied)
            if tag == "$set":
                return set(build(supplied))
            if tag == "$error":
                error = build(supplied)
                exception_type = type(str(error.get("name", "Error")), (Exception,), {})
                return exception_type(error["message"])
            if tag == "$buffer":
                return str(supplied).encode("utf-8")
            if tag == "$projection":
                pointer = str(supplied)

                def project(argument: object) -> object:
                    return _resolve(argument, pointer)

                return project
            if tag == "$throwingProjection":
                message = str(supplied)

                def fail_projection(_argument: object) -> object:
                    raise RuntimeError(message)

                return fail_projection
            if tag == "$throwingGetter":
                raise ValueError("throwing getters are not representable in Python")
            raise ValueError(f"unknown fixture tag {tag}")

        result: dict[str, object] = {}
        for name, item in child.items():
            key = name.replace("{{run}}", run)
            expanded = place(item, result, key)
            if expanded is not UNDEFINED:
                result[key] = expanded
        return result

    built = build(value)
    for parent, key, pointer in deferred:
        resolved = _resolve(built, pointer)
        parent[key] = resolved
    return built


def _snake_options(options: object) -> dict[str, object]:
    if type(options) is not dict:
        return {}
    names = {
        "captureInput": "capture_input",
        "captureOutput": "capture_output",
        "displayableAliases": "displayable_aliases",
        "isFailure": "is_failure",
        "metadataFrom": "metadata_from",
        "parentEventId": "parent_event_id",
        "traceId": "trace_id",
        "spanId": "span_id",
        "messageId": "message_id",
        "correlationId": "correlation_id",
        "journeyLabel": "journey_label",
    }
    return {names.get(key, key): value for key, value in options.items()}


def _run_awaitable(value: object) -> object:
    return asyncio.run(value) if inspect.isawaitable(value) else value


def _group(recorder: object, first: object, size: int) -> object:
    others = [
        recorder.journey({"type": "customer", "id": f"0018Z00002ABC-{index}"})
        for index in range(2, size + 1)
    ]
    return recorder.across([first, *others])


def _make_call(target: object, call: dict[str, object], run: str) -> None:
    args = _expand(call.get("args", {}), run)
    name = call.get("name", "receive-order")
    kind = call["call"]
    if kind == "record":
        fields = _snake_options(args)
        operation = fields.pop("operation")
        event_name = fields.pop("name")
        target.record(operation=operation, name=event_name, **fields)
        return
    if kind == "identify":
        options = _snake_options(args.get("options", {}))
        target.identify(args["aliases"], **options)
        return
    if kind == "label":
        target.label(args["text"])
        return
    if kind == "fail":
        target.fail(name, args["error"], **_snake_options(args.get("options", {})))
        return
    if kind == "finish":
        target.complete(name="complete")
        return
    options = _snake_options(args.get("options", {}))
    result = getattr(target, kind)(
        name, args.get("input"), lambda: args.get("output"), **options
    )
    _run_awaitable(result)


def _diagnostic(report: dict[str, object]) -> dict[str, object]:
    detail = {key: value for key, value in report.items() if key != "kind"}
    result: dict[str, object] = {"kind": report["kind"]}
    if detail:
        result["detail"] = detail
    return result


def capture_case(case: dict[str, object], run: str) -> dict[str, object]:
    server = _CaptureServer()
    thread = threading.Thread(
        target=lambda: server.serve_forever(poll_interval=0.01), daemon=True
    )
    thread.start()
    diagnostics: list[dict[str, object]] = []
    recorder_options = {
        "endpoint": f"http://127.0.0.1:{server.server_port}",
        "api_key": "wsk_test_conformance",
        "service": "customer-integration",
        "environment": "conformance",
        "on_diagnostic": lambda report: diagnostics.append(_diagnostic(report)),
    }
    for key, value in (case.get("recorder") or {}).items():
        recorder_options[{"maxEventBytes": "max_event_bytes"}.get(key, key)] = value
    recorder = create_recorder(**recorder_options)
    try:
        journey = recorder.journey({"type": "customer", "id": "0018Z00002ABC"})
        for call in case.get("calls", []):
            target = (
                journey
                if call.get("journeys") is None
                else _group(recorder, journey, int(call["journeys"]))
            )
            for _repeat in range(int(call.get("repeat", 1))):
                _make_call(target, call, run)
        recorder.shutdown(timeout_ms=5000)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    batches = list(server.batches)
    events = [
        entry["event"]
        for body in batches
        for entry in json.loads(body).get("events", [])
    ]
    return {
        "id": case["id"],
        "batches": batches,
        "events": events,
        "diagnostics": diagnostics,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--run", default="fixture")
    args = parser.parse_args()

    cases = []
    skipped = []
    for path in sorted(args.fixtures.glob("*.json")):
        case = json.loads(path.read_text(encoding="utf-8"))
        if "python" not in case["languages"] and "*" not in case["languages"]:
            skipped.append(
                {
                    "id": case["id"],
                    "reason": SKIPPED.get(case["id"], "language excluded"),
                }
            )
            continue
        cases.append(capture_case(case, args.run))
    print(
        json.dumps(
            {"cases": cases, "skipped": skipped},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
