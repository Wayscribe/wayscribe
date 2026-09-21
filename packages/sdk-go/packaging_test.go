package wayscribe

import (
	"bytes"
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
	if string(goMod) != "module gitlab.com/jojithedev/wayscribe/packages/sdk-go\n\ngo 1.26\n" {
		t.Fatalf("unexpected module declaration:\n%s", goMod)
	}
	if SDKName != "wayscribe-go" || Version != "0.1.0-dev" {
		t.Fatalf("unexpected development identity %s/%s", SDKName, Version)
	}

	root := filepath.Clean(filepath.Join(module, "../.."))
	for _, name := range []string{"LICENSE", "NOTICE"} {
		packageCopy, err := os.ReadFile(filepath.Join(module, name))
		if err != nil {
			t.Fatal(err)
		}
		repositoryCopy, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		if len(packageCopy) == 0 || !bytes.Equal(packageCopy, repositoryCopy) {
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
		if dependency != "gitlab.com/jojithedev/wayscribe/packages/sdk-go" &&
			!strings.HasPrefix(dependency, "gitlab.com/jojithedev/wayscribe/packages/sdk-go/") {
			t.Fatalf("non-standard-library dependency %s", dependency)
		}
	}
}
