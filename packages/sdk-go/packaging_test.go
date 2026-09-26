package wayscribe

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestModuleIdentityLegalFilesAndDependencies(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate package source")
	}
	module := filepath.Dir(source)
	goMod, err := os.ReadFile(filepath.Join(module, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	if string(goMod) != "module wayscribe.dev/go\n\ngo 1.22\n" {
		t.Fatalf("unexpected module declaration:\n%s", goMod)
	}
	if SDKName != "wayscribe.dev/go" || Version != "0.2.0" {
		t.Fatalf("unexpected module identity %s/%s", SDKName, Version)
	}

	root := filepath.Clean(filepath.Join(module, "../.."))
	for _, name := range []string{"LICENSE", "NOTICE"} {
		packageCopy, err := os.ReadFile(filepath.Join(module, name))
		if err != nil {
			t.Fatal(err)
		}
		if len(packageCopy) == 0 {
			t.Fatalf("%s is empty", name)
		}
		repositoryCopy, err := os.ReadFile(filepath.Join(root, name))
		if errors.Is(err, fs.ErrNotExist) && !insideRepository(module) {
			continue // a module-only copy, as a consumer downloads it
		}
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(packageCopy, repositoryCopy) {
			t.Fatalf("%s is missing or differs from the repository copy", name)
		}
	}

	command := exec.Command("go", "list", "-deps", "-f", "{{if not .Standard}}{{.ImportPath}}{{end}}", "./...")
	command.Dir = module
	command.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v\n%s", err, output)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency != "wayscribe.dev/go" &&
			!strings.HasPrefix(dependency, "wayscribe.dev/go/") {
			t.Fatalf("non-standard-library dependency %s", dependency)
		}
	}
}

// insideRepository reports whether module sits at packages/sdk-go of the
// Wayscribe repository, where the shared sources beside it must be compared.
func insideRepository(module string) bool {
	_, err := os.Stat(filepath.Join(module, "..", "protocol", "fixtures"))
	return err == nil
}

// The vectors in testdata are copies, so a module-only checkout can run them.
// Inside the repository they must stay byte-identical to the shared sources.
func TestSharedFixtureCopiesMatchTheirSources(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	module := filepath.Dir(source)
	if !insideRepository(module) {
		t.Skip("module-only copy: no shared fixtures to compare")
	}
	for _, name := range []string{"propagation.json", "journey-id-derivation.json"} {
		copied, err := os.ReadFile(filepath.Join(module, "testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		shared, err := os.ReadFile(filepath.Join(module, "..", "protocol", "fixtures", name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(copied, shared) {
			t.Fatalf("testdata/%s differs from packages/protocol/fixtures/%s; copy it again", name, name)
		}
	}
}
