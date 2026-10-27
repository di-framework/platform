// Package logging connects the operator's loggers.
package logging

import (
	"log/slog"

	"github.com/go-logr/logr"
)

// BridgeSlog makes log/slog's default logger write through l and returns it. Without it, slog's
// default handler writes to stderr apart from the controller-runtime (zap) logger, and its lines
// never showed up in the operator's pod log (#473). slog levels map to logr verbosity: Info is
// V(0), Debug is V(4), Error and above go to l.Error.
func BridgeSlog(l logr.Logger) *slog.Logger {
	s := slog.New(logr.ToSlogHandler(l))
	slog.SetDefault(s)
	return s
}
