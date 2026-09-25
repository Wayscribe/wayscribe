package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"wayscribe.dev/go/internal/conformance"
)

func main() {
	fixtures := flag.String("fixtures", "packages/protocol/conformance/sdk", "SDK fixture directory")
	run := flag.String("run", "fixture", "value substituted for {{run}}")
	flag.Parse()
	report, err := conformance.Run(*fixtures, *run)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(report); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
