"""Loopback-only collector, preserving the exact received bytes."""

import json
import threading
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
                if owner.respond:
                    status, response = owner.respond(body, index)
                else:
                    status, response = accepted(body)
                if not isinstance(response, bytes):
                    response = json.dumps(response).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(response)))
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
