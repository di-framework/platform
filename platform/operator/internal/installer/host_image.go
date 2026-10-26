package installer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// approvedDigestsFile is the installed platform package's module that exports
// NATS_CREDENTIALS_HOST_IMAGE_DIGESTS, relative to the project directory.
var approvedDigestsFile = filepath.Join("node_modules", "@di-framework", "platform", "dist", "tenancy", "registry-nats.js")

var (
	approvedDigestsList = regexp.MustCompile(`(?s)exports\.NATS_CREDENTIALS_HOST_IMAGE_DIGESTS\s*=\s*\[(.*?)\]`)
	approvedDigest      = regexp.MustCompile(`['"](sha256:[0-9a-f]{64})['"]`)
)

// checkApprovedHostImage fails with ErrHostImageNotApproved unless the platform package installed
// in projectDir lists image's digest in NATS_CREDENTIALS_HOST_IMAGE_DIGESTS. It fails closed: a
// tag-only image, or a package without the list, is not approved.
func checkApprovedHostImage(projectDir, version, image string) error {
	at := strings.LastIndex(image, "@")
	if at < 0 {
		return fmt.Errorf("%w: %s is not pinned by digest", ErrHostImageNotApproved, image)
	}
	digest := image[at+1:]
	src, err := os.ReadFile(filepath.Join(projectDir, approvedDigestsFile))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read the approved host images of @di-framework/platform@%s: %w", version, err)
	}
	if m := approvedDigestsList.FindSubmatch(src); m != nil {
		for _, d := range approvedDigest.FindAllSubmatch(m[1], -1) {
			if string(d[1]) == digest {
				return nil
			}
		}
	}
	return fmt.Errorf("%w: @di-framework/platform@%s does not list %s (%s) in NATS_CREDENTIALS_HOST_IMAGE_DIGESTS",
		ErrHostImageNotApproved, version, digest, image)
}
