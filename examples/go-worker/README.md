# Go worker example

This small external module imports only the public Wayscribe Go package and
records identity mapping, a transformation, a failed delivery, an explicit
retry, and completion. Its input has a secret-named field so the stored payload
shows client-side redaction while the phone change remains available as a field
diff.

The Go SDK is an unpublished development module. From this repository checkout,
the example's `go.mod` uses a local `replace` directive rather than implying that
the module can be downloaded from a public registry.

Configure the worker explicitly in application code:

```sh
export WAYSCRIBE_ENDPOINT=http://127.0.0.1:8080
export WAYSCRIBE_API_KEY=replace-with-a-project-environment-key
export WAYSCRIBE_ENVIRONMENT=development
GOTOOLCHAIN=local GOWORK=off go run .
```

`main.go` reads those values and passes them into `wayscribe.New`; the SDK does
not read ambient Wayscribe configuration. The example verifies the delivery
wrapper preserves its exact host error and retry result, then shuts down with a
five-second bound.
