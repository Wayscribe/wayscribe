#!/usr/bin/env python3
"""One-shot local HTTP worker using the installed public Wayscribe wheel."""

import http.client
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

from wayscribe import create_recorder, extract_http_context, inject_payload

MAX_BODY = 64 * 1024


def required(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required configuration: {name}")
    return value


def post_json(url, body):
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.query or parsed.fragment:
        raise RuntimeError("Go worker URL must be an owned loopback HTTP endpoint")
    encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
    try:
        connection.request(
            "POST",
            parsed.path or "/",
            body=encoded,
            headers={"content-type": "application/json", "content-length": str(len(encoded))},
        )
        response = connection.getresponse()
        data = response.read(MAX_BODY + 1)
        if len(data) > MAX_BODY:
            raise RuntimeError("Go worker response exceeded 64 KiB")
        if response.status != 200:
            raise RuntimeError(f"Go worker refused the request with HTTP {response.status}")
        return json.loads(data)
    finally:
        connection.close()


class Worker(HTTPServer):
    allow_reuse_address = False


def main():
    endpoint = required("WAYSCRIBE_ENDPOINT")
    api_key = required("WAYSCRIBE_API_KEY")
    environment = required("WAYSCRIBE_ENVIRONMENT")
    go_url = required("GO_WORKER_URL")
    recorder = create_recorder(
        endpoint=endpoint,
        api_key=api_key,
        service="mixed-python",
        environment=environment,
        request_timeout_ms=2000,
    )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format, *_args):
            return

        def do_POST(self):
            status = 500
            response = {"error": "Python worker failed"}
            try:
                length = int(self.headers.get("content-length", "0"))
                if length < 1 or length > MAX_BODY:
                    raise ValueError("request body size is invalid")
                message = json.loads(self.rfile.read(length))
                entity = message["entity"]
                payload = message["payload"]
                context = extract_http_context(self.headers)
                if context is None:
                    raise ValueError("missing Wayscribe HTTP context")
                journey = recorder.resume(context, entity=entity)
                output = journey.transform(
                    "normalize-email",
                    payload,
                    lambda: {
                        "email": payload["email"].strip().lower(),
                        "password": payload["password"],
                    },
                )
                envelope = inject_payload(
                    journey.context(), {"entity": entity, "payload": output}
                )
                go_result = post_json(go_url, envelope)
                recorder.shutdown(timeout_ms=5000)
                response = {
                    "journeyId": journey.context()["journeyId"],
                    "traceparent": self.headers.get("traceparent"),
                    "httpEntityIdPresent": "x-wayscribe-entity-id" in self.headers,
                    "counters": recorder.counters(),
                    "go": go_result,
                }
                status = 200
            except Exception as error:
                recorder.shutdown(timeout_ms=5000)
                response = {
                    "error": type(error).__name__,
                    "counters": recorder.counters(),
                }
            encoded = json.dumps(response, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = Worker(("127.0.0.1", 0), Handler)
    print(json.dumps({"type": "ready", "port": server.server_port}, separators=(",", ":")), flush=True)
    server.timeout = 15
    server.handle_request()
    server.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"python worker failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1)
