package installer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	listedDigest   = "sha256:6fea016378c3c6313427f2d6df0fed5ca369ab8f5676eb49d99844625312bb80"
	unlistedDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

// registryNatsJS is the shape tsc emits for platform/src/tenancy/registry-nats.ts.
const registryNatsJS = `"use strict";
exports.NATS_CREDENTIALS_HOST_IMAGE_DIGESTS = exports.NATS_TENANT_ACCOUNT = void 0;
exports.NATS_TENANT_ACCOUNT = 'TENANT';
exports.NATS_CREDENTIALS_HOST_IMAGE_DIGESTS = [
    // ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive
    '` + listedDigest + `',
];
exports.OTHER = ['` + unlistedDigest + `'];
`

// withPlatformModule makes the fake npm install also write the package's registry-nats.js (or
// nothing, for src == "").
func withPlatformModule(p *Pulumi, src string) {
	install := p.npmInstall
	p.npmInstall = func(ctx context.Context, dir string) error {
		if err := install(ctx, dir); err != nil {
			return err
		}
		if src == "" {
			return nil
		}
		path := filepath.Join(dir, approvedDigestsFile)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		return os.WriteFile(path, []byte(src), 0o600)
	}
}

func TestApprovedHostImage(t *testing.T) {
	for name, tc := range map[string]struct {
		module, image, want string
	}{
		"listed":              {module: registryNatsJS, image: "ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@" + listedDigest},
		"not listed":          {module: registryNatsJS, image: "ghcr.io/di-framework/wash@" + unlistedDigest, want: "@di-framework/platform@6.0.17 does not list " + unlistedDigest + " (ghcr.io/di-framework/wash@" + unlistedDigest + ") in NATS_CREDENTIALS_HOST_IMAGE_DIGESTS"},
		"tag only":            {module: registryNatsJS, image: "ghcr.io/di-framework/wash:2.8.0", want: "ghcr.io/di-framework/wash:2.8.0 is not pinned by digest"},
		"package without it":  {module: "", image: "ghcr.io/di-framework/wash@" + listedDigest, want: "does not list " + listedDigest},
		"module without list": {module: "exports.X = ['" + listedDigest + "'];\n", image: "ghcr.io/di-framework/wash@" + listedDigest, want: "does not list " + listedDigest},
	} {
		t.Run(name, func(t *testing.T) {
			s := &fakeStack{fail: map[string][]error{}}
			p, _ := newTestPulumi(t, s)
			withPlatformModule(p, tc.module)
			r := request()
			r.ApprovedHostImage = tc.image
			_, err := p.Install(context.Background(), r, Options{})
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if !errors.Is(err, ErrHostImageNotApproved) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err %v, want %q", err, tc.want)
			}
			if len(s.calls) != 0 {
				t.Fatalf("refused install touched the stack: %v", s.calls)
			}
		})
	}
}

func TestApprovedHostImageUnchecked(t *testing.T) {
	s := &fakeStack{fail: map[string][]error{}}
	p, _ := newTestPulumi(t, s)
	if _, err := p.Install(context.Background(), request(), Options{}); err != nil {
		t.Fatalf("no ApprovedHostImage, no package list: %v", err)
	}
}

func TestApprovedHostImageReadError(t *testing.T) {
	s := &fakeStack{fail: map[string][]error{}}
	p, _ := newTestPulumi(t, s)
	install := p.npmInstall
	p.npmInstall = func(ctx context.Context, dir string) error {
		if err := install(ctx, dir); err != nil {
			return err
		}
		// A directory where the module should be can't be read as a file.
		return os.MkdirAll(filepath.Join(dir, approvedDigestsFile), 0o700)
	}
	r := request()
	r.ApprovedHostImage = "ghcr.io/di-framework/wash@" + listedDigest
	if _, err := p.Install(context.Background(), r, Options{}); err == nil || errors.Is(err, ErrHostImageNotApproved) ||
		!strings.Contains(err.Error(), "read the approved host images of @di-framework/platform@6.0.17") {
		t.Fatalf("err %v", err)
	}
}
