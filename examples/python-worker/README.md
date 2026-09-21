# Python worker example

This small worker records one customer journey through identity mapping,
transformation, a failed delivery, a retry and completion. The input includes a
secret-named field so the recorded payload demonstrates client-side redaction;
the phone change remains visible as a field diff.

Install the unpublished development package from a built wheel, then configure
the recorder explicitly in the application process:

```sh
export WAYSCRIBE_ENDPOINT=http://127.0.0.1:8080
export WAYSCRIBE_API_KEY=replace-with-a-project-environment-key
export WAYSCRIBE_ENVIRONMENT=development
python worker.py
```

`worker.py` reads those settings and passes them to `create_recorder`. The SDK
does not read Wayscribe configuration from ambient environment variables. The
example catches its own delivery exception, verifies the wrapper preserved the
same exception object, records attempt 2 explicitly, and shuts down with a
bounded flush before the process exits.
