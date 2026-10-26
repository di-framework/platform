package installer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/auto"
)

func TestSecretSettingsAndUnset(t *testing.T) {
	s := &fakeStack{fail: map[string][]error{}, held: auto.ConfigMap{
		"platform-instance:tenantAuth":                {Value: "{}"},
		"platform-instance:tenantHostImagePullPolicy": {Value: "Never"},
		"platform-instance:insecureRegistries":        {Value: "[]"},
		"platform-instance:tenantAuthClientSecret":    {Value: "old", Secret: true},
	}}
	p, _ := newTestPulumi(t, s)
	r := request()
	r.SecretSettings = map[string]string{TenantAuthClientSecretKey: "s3cret"}
	r.Unset = []string{"tenantAuth", TenantAuthClientSecretKey, "tenantHostImagePullPolicy"}
	if _, err := p.Install(context.Background(), r, Options{}); err != nil {
		t.Fatal(err)
	}
	if got := s.config["platform-instance:tenantAuthClientSecret"]; got.Value != "s3cret" || !got.Secret {
		t.Fatalf("secret setting %+v", got)
	}
	// Held and not set by the request: removed. Set by the request, or not the operator's: kept.
	want := []string{"platform-instance:tenantAuth", "platform-instance:tenantHostImagePullPolicy"}
	if !reflect.DeepEqual(s.removed, want) {
		t.Fatalf("removed %v, want %v", s.removed, want)
	}
	if want := []string{"config", "getconfig", "rmconfig", "up", "outputs"}; !reflect.DeepEqual(s.calls, want) {
		t.Fatalf("calls %v", s.calls)
	}

	// Nothing to remove: no removal call.
	s.calls, s.held = nil, auto.ConfigMap{}
	if _, err := p.Install(context.Background(), r, Options{}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"config", "getconfig", "up", "outputs"}; !reflect.DeepEqual(s.calls, want) {
		t.Fatalf("calls %v", s.calls)
	}

	// The program writes the client secret Secret from the encrypted config key.
	projectDir, _ := p.dirs(r.ID)
	prog, _ := os.ReadFile(filepath.Join(projectDir, "index.ts"))
	for _, want := range []string{"config.getSecret('tenantAuthClientSecret')", "new k8s.core.v1.Secret(", "from '@di-framework/platform/existing'"} {
		if !strings.Contains(string(prog), want) {
			t.Fatalf("index.ts lacks %q:\n%s", want, prog)
		}
	}
}

func TestUnsetErrors(t *testing.T) {
	boom := errors.New("boom")
	for op, want := range map[string]string{"getconfig": "read config: boom", "rmconfig": "unset config: boom"} {
		s := &fakeStack{fail: map[string][]error{op: {boom}}, held: auto.ConfigMap{"platform-instance:tenantAuth": {}}}
		p, _ := newTestPulumi(t, s)
		r := request()
		r.Unset = []string{"tenantAuth"}
		if _, err := p.Install(context.Background(), r, Options{}); err == nil || err.Error() != want {
			t.Fatalf("%s: err %v, want %q", op, err, want)
		}
	}
}

func TestInvalidSecretSettings(t *testing.T) {
	for name, mutate := range map[string]func(*Request){
		"secret kubeconfig": func(r *Request) { r.SecretSettings = map[string]string{"kubeconfig": "/etc/passwd"} },
		"setting twice":     func(r *Request) { r.SecretSettings = map[string]string{"httpNodePort": "1"} },
		"unset kubeconfig":  func(r *Request) { r.Unset = []string{"kubeconfig"} },
	} {
		t.Run(name, func(t *testing.T) {
			s := &fakeStack{fail: map[string][]error{}}
			p, _ := newTestPulumi(t, s)
			r := request()
			mutate(&r)
			if _, err := p.Install(context.Background(), r, Options{}); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("err %v, want ErrInvalidRequest", err)
			}
		})
	}
}
