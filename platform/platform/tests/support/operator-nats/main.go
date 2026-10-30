// Command operator-nats connects to NATS exactly as the wasmCloud runtime-operator v2.8.0 does, for
// the scheduler NATS broker test (#541 m6e, design-541 §8.2): the options of
// runtime-operator/pkg/wasmbus/nats.go:28-50 (NatsConnect) followed by those of
// runtime-operator/cmd/main.go:184-207 (RootCAs, ClientCert and the connection state handlers),
// with the operator's nats.go version (go.mod of runtime-operator/v2.8.0).
//
// Usage: operator-nats <address> <ca file> <cert file> <key file> <subject>
//
// It connects to nats://nats:4222, so the server certificate is verified against the name "nats"
// as in the cluster, through a dialer that sends every connection to <address> (the container's
// published port). That dialer is the one option the operator does not set; it changes only where
// the TCP connection goes (with the operator's 5 s connect timeout).
//
// It subscribes to <subject> and prints one line per connection event on stdout: "connected"
// first, then "disconnected: <error>", "reconnected", "error: <error>" and "closed: <last error>".
// It exits once the connection is closed for good, or closes it when stdin is closed.
package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"github.com/nats-io/nats.go"
)

func say(format string, args ...any) {
	fmt.Fprintf(os.Stdout, format+"\n", args...)
}

// redirect dials address whatever the URL names.
type redirect struct{ address string }

func (r redirect) Dial(network, _ string) (net.Conn, error) {
	return net.DialTimeout(network, r.address, 5*time.Second)
}

func main() {
	if len(os.Args) != 6 {
		fmt.Fprintln(os.Stderr, "usage: operator-nats <address> <ca> <cert> <key> <subject>")
		os.Exit(2)
	}
	address, ca, cert, key, subject := os.Args[1], os.Args[2], os.Args[3], os.Args[4], os.Args[5]
	closed := make(chan struct{})
	// pkg/wasmbus/nats.go:29-41, verbatim.
	opts := []nats.Option{
		nats.PingInterval(1 * time.Minute),    // default is 2m
		nats.MaxPingsOutstanding(1),           // default is 2
		nats.DrainTimeout(5 * time.Second),    // default is 30s
		nats.FlusherTimeout(30 * time.Second), // default is 1m
		nats.Timeout(5 * time.Second),         // default is 2s
		nats.ReconnectWait(1 * time.Second),   // default is 2s
		nats.MaxReconnects(-1),
		nats.ReconnectJitter(100*time.Millisecond, 1*time.Second),
	}
	// cmd/main.go:184-207 as the platform runs it (no creds file, no -nats-tls-first). The
	// handlers report on stdout instead of the operator's log.
	opts = append(opts,
		nats.RootCAs(ca),
		nats.ClientCert(cert, key),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) { say("disconnected: %v", err) }),
		nats.ReconnectHandler(func(_ *nats.Conn) { say("reconnected") }),
		nats.ClosedHandler(func(nc *nats.Conn) {
			say("closed: %v", nc.LastError())
			close(closed)
		}),
		nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
			say("error: %v", err)
		}),
	)
	opts = append(opts, nats.SetCustomDialer(redirect{address}))
	nc, err := nats.Connect("nats://nats:4222", opts...)
	if err != nil {
		say("refused: %v", err)
		os.Exit(1)
	}
	if _, err := nc.SubscribeSync(subject); err != nil {
		say("refused: %v", err)
		os.Exit(1)
	}
	if err := nc.Flush(); err != nil {
		say("refused: %v", err)
		os.Exit(1)
	}
	say("connected")
	stdin := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		close(stdin)
	}()
	select {
	case <-closed:
	case <-stdin:
		nc.Close()
		<-closed
	}
}
