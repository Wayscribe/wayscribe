"""Loopback-only collector, preserving the exact received bytes."""

import json
import threading
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Collector:
    def __init__(self, respond=None, before_body=None):
        self.bodies = []
        self.paths = []
        self.headers = []
        self.received = threading.Event()
        self.respond = respond
        self.before_body = before_body
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                with owner.lock:
                    owner.bodies.append(body)
                    owner.paths.append(self.path)
                    owner.headers.append(dict(self.headers))
                    index = len(owner.bodies) - 1
                owner.received.set()
                extra = {}
                if owner.respond:
                    status, response, *rest = owner.respond(body, index)
                    extra = rest[0] if rest else {}
                else:
                    status, response = accepted(body)
                if not isinstance(response, bytes):
                    response = json.dumps(response).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(response)))
                    for name, value in extra.items():
                        self.send_header(name, value)
                    self.end_headers()
                    if owner.before_body:
                        owner.before_body()
                    self.wfile.write(response)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True
        )

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def events(self):
        return [e["event"] for b in self.bodies for e in json.loads(b)["events"]]

    def recorder(self, **options):
        from wayscribe import create_recorder

        return create_recorder(
            endpoint=self.endpoint,
            api_key="test-key",
            service="test",
            environment="development",
            **options,
        )


def accepted(body):
    return 202, {
        "data": {
            "results": [
                {"eventId": x["event"]["id"], "status": "accepted", "duplicate": False}
                for x in json.loads(body)["events"]
            ]
        }
    }


class CountingMapping(Mapping):
    """Finite stand-in for a huge/nonterminating mapping; counts host reads."""

    def __init__(self, size=2001, reported_size=None, *, repeated=False):
        self.size = size
        self.reported_size = size if reported_size is None else reported_size
        self.repeated = repeated
        self.iterations = 0
        self.reads = 0

    def __len__(self):
        return self.reported_size

    def __iter__(self):
        for index in range(self.size):
            self.iterations += 1
            yield "alias" if self.repeated else f"alias{index}"

    def __getitem__(self, key):
        self.reads += 1
        return "kept"
