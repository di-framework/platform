package main

import (
	"flag"
	"io"
	"os"
	"testing"

	"github.com/di-framework/platform/operator/internal/installer"
)

// release.yml checks the version compiled into the binary with --print-default-version (#523): it
// prints installer.DefaultVersion alone and exits without a cluster, passphrase or state directory.
func TestPrintDefaultVersion(t *testing.T) {
	args, cmdLine, stdout := os.Args, flag.CommandLine, os.Stdout
	t.Cleanup(func() { os.Args, flag.CommandLine, os.Stdout = args, cmdLine, stdout })
	os.Args = []string{"platform-operator", "--print-default-version", "--passphrase-file", "/nonexistent"}
	flag.CommandLine = flag.NewFlagSet(os.Args[0], flag.ContinueOnError)
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w

	runErr := run()
	w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if runErr != nil {
		t.Fatalf("run() = %v, want nil", runErr)
	}
	if got, want := string(out), installer.DefaultVersion+"\n"; got != want {
		t.Fatalf("printed %q, want %q", got, want)
	}
}
