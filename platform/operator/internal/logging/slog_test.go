package logging

import (
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/go-logr/logr/funcr"
)

// The operator's username line and a Helm-style line logged through log/slog reach the logr
// sink with their messages and key/values (#473).
func TestBridgeSlogRoutesSlogToLogr(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	var lines []string
	BridgeSlog(funcr.New(func(_, args string) { lines = append(lines, args) }, funcr.Options{}))

	slog.Info("operator user, allowed to delete service/vcluster", "username", "x")
	slog.Default().Info(fmt.Sprintf("preparing upgrade for %s", "vcluster"), "namespace", "pi-x")
	slog.Debug("dropped: V(4) is above the sink's verbosity")

	want := []string{
		`"msg"="operator user, allowed to delete service/vcluster" "username"="x"`,
		`"msg"="preparing upgrade for vcluster" "namespace"="pi-x"`,
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d: %q", len(lines), len(want), lines)
	}
	for i, w := range want {
		if !strings.Contains(lines[i], w) {
			t.Errorf("line %d = %q, want it to contain %q", i, lines[i], w)
		}
	}
}
