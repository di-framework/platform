package controller

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// imageHarness is an instance at version with spec.platform.tenantHostImage set to image.
func imageHarness(t *testing.T, version, image string) *harness {
	t.Helper()
	h := newHarness(t, "")
	inst := h.get()
	inst.Spec.Version = version
	inst.Spec.Platform.TenantHostImage = image
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.readyTarget()
	return h
}

func (h *harness) update(mutate func(*v1alpha1.PlatformInstance)) {
	h.t.Helper()
	inst := h.get()
	mutate(inst)
	inst.Generation++
	if err := h.c.Update(context.Background(), inst); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) lastImage() any {
	return h.in.installs[len(h.in.installs)-1].Settings["tenantHostImage"]
}

// C1: a changed host image is a spec change, installed with the new value and recorded.
func TestChangedTenantHostImageReinstalls(t *testing.T) {
	h := imageHarness(t, "6.0.17", "localhost/wash:one")
	h.reconcile()
	h.reconcile()
	h.update(func(i *v1alpha1.PlatformInstance) { i.Spec.Platform.TenantHostImage = "localhost/wash:two" })
	h.reconcile()
	if len(h.in.installs) != 2 || h.lastImage() != "localhost/wash:two" ||
		conditionReason(h.get(), v1alpha1.ConditionInstalled) != "SpecChanged" {
		t.Fatalf("installs %d image %v reason %q", len(h.in.installs), h.lastImage(), conditionReason(h.get(), v1alpha1.ConditionInstalled))
	}
	if got := h.get().Status.Applied.TenantHostImage; got != "localhost/wash:two" {
		t.Fatalf("recorded %q", got)
	}
}

// W1: a new instance records the operator default once and keeps it while the field is empty;
// an explicit value then wins and is recorded, and clearing the field keeps the recorded one.
func TestDefaultTenantHostImageIsRecorded(t *testing.T) {
	h := imageHarness(t, MinDefaultHostImageVersion, "")
	h.reconcile()
	h.reconcile()
	if h.lastImage() != DefaultTenantHostImage || h.get().Status.Applied.TenantHostImage != DefaultTenantHostImage {
		t.Fatalf("first install image %v applied %+v", h.lastImage(), h.get().Status.Applied)
	}
	// A later operator build with another default must not move it: the recorded value wins.
	inst := h.get()
	inst.Status.Applied.TenantHostImage = "ghcr.io/di-framework/wash:recorded"
	if err := h.c.Status().Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.update(func(i *v1alpha1.PlatformInstance) { i.Spec.Platform.Tenants = []v1alpha1.Tenant{{Name: "acme"}} })
	h.reconcile()
	if h.lastImage() != "ghcr.io/di-framework/wash:recorded" {
		t.Fatalf("repair image %v, want the recorded one", h.lastImage())
	}
	h.update(func(i *v1alpha1.PlatformInstance) { i.Spec.Platform.TenantHostImage = "localhost/wash:explicit" })
	h.reconcile()
	if h.lastImage() != "localhost/wash:explicit" || h.get().Status.Applied.TenantHostImage != "localhost/wash:explicit" {
		t.Fatalf("explicit image %v applied %+v", h.lastImage(), h.get().Status.Applied)
	}
	h.update(func(i *v1alpha1.PlatformInstance) { i.Spec.Platform.TenantHostImage = "" })
	h.reconcile()
	if h.lastImage() != "localhost/wash:explicit" {
		t.Fatalf("cleared field image %v, want the recorded explicit one", h.lastImage())
	}
}

// W1: the exclusive default with a platform that doesn't approve it is refused, visibly.
func TestDefaultTenantHostImageNeedsAnApprovingVersion(t *testing.T) {
	for _, version := range []string{"6.0.19", "5.9.30", "6.0.19-rc.1"} {
		h := imageHarness(t, version, "")
		h.reconcile()
		if _, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); !errors.Is(err, errTenantHostImage) {
			t.Fatalf("%s: err %v", version, err)
		}
		if len(h.in.installs) != 0 {
			t.Fatalf("%s: installed", version)
		}
		inst := h.get()
		for _, typ := range []string{v1alpha1.ConditionInstalled, v1alpha1.ConditionConfigApplied} {
			c := meta.FindStatusCondition(inst.Status.Conditions, typ)
			if c == nil || c.Status != metav1.ConditionFalse || c.Reason != v1alpha1.ReasonTenantHostImageUnsupported ||
				!strings.Contains(c.Message, "approved host build only from platform 6.0.20; spec.version is "+version) {
				t.Fatalf("%s: %s %+v", version, typ, c)
			}
		}
	}
	for _, version := range []string{"6.0.20", "6.0.20-rc.1", "6.1.0", "7.0.0"} {
		h := imageHarness(t, version, "")
		h.reconcile()
		h.reconcile()
		if len(h.in.installs) != 1 || h.lastImage() != DefaultTenantHostImage {
			t.Fatalf("%s: installs %d", version, len(h.in.installs))
		}
	}
}

// W4: an instance installed before the operator recorded the host image keeps the platform's
// default: the key is not set (and is removed if it was), and the empty value is recorded.
func TestPreexistingInstanceKeepsThePlatformDefault(t *testing.T) {
	h := imageHarness(t, "6.0.17", "")
	h.reconcile()
	inst := h.get()
	inst.Status.InstalledVersion = "6.0.17"
	inst.Status.ObservedGeneration = inst.Generation
	inst.Status.Conditions = []metav1.Condition{{Type: v1alpha1.ConditionInstalled, Status: metav1.ConditionTrue, Reason: "Installed", LastTransitionTime: metav1.Now()}}
	if err := h.c.Status().Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(36 * time.Hour)
	h.reconcile()
	if len(h.in.installs) != 1 || !h.in.options[0].Refresh {
		t.Fatalf("repair: installs %d", len(h.in.installs))
	}
	if _, set := h.in.installs[0].Settings["tenantHostImage"]; set {
		t.Fatalf("pre-existing instance got tenantHostImage %v", h.lastImage())
	}
	a := h.get().Status.Applied
	if a == nil || a.TenantHostImage != "" {
		t.Fatalf("applied %+v", a)
	}
	// Later repairs keep the recorded platform default.
	h.update(func(i *v1alpha1.PlatformInstance) { i.Spec.Version = "6.0.20" })
	h.reconcile()
	if _, set := h.in.installs[1].Settings["tenantHostImage"]; set {
		t.Fatal("recorded platform default replaced by the operator default")
	}
}

func TestVersionBefore(t *testing.T) {
	for v, want := range map[string]bool{"6.0.19": true, "6.0.20": false, "6.0.20-rc.1": false, "6.0.3": true, "6.1.0": false, "5.99.99": true, "10.0.0": false} {
		if got := versionBefore(v, "6.0.20"); got != want {
			t.Errorf("versionBefore(%s) = %v", v, got)
		}
	}
}
