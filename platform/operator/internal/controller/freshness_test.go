package controller

import (
	"context"
	"errors"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/targets"
)

// failingReader fails every read past the cache with err.
type failingReader struct{ err error }

func (f failingReader) Get(context.Context, client.ObjectKey, client.Object, ...client.GetOption) error {
	return f.err
}

// ensureCounter counts the Ensure calls that reach the target.
type ensureCounter struct {
	targets.Target
	ensures int
}

func (e *ensureCounter) Ensure(ctx context.Context, inst *v1alpha1.PlatformInstance) (targets.State, error) {
	e.ensures++
	return e.Target.Ensure(ctx, inst)
}

// openExpectation installs the instance and leaves an expectation the cache has not reached.
func openExpectation(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t, "")
	h.r.APIReader = h.c
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	inst := h.get()
	inst.ResourceVersion = "expected-but-not-cached"
	h.r.writes.expect(inst)
	return h
}

func (h *harness) expectation() (string, bool) {
	h.r.writes.mu.Lock()
	defer h.r.writes.mu.Unlock()
	v, ok := h.r.writes.want[key]
	return v, ok
}

// A failed read past the cache fails the round closed: no Ensure, the error returned, and the
// expectation still open (#481).
func TestFreshReadFailureSkipsEnsure(t *testing.T) {
	h := openExpectation(t)
	boom := errors.New("apiserver unavailable")
	h.r.APIReader = failingReader{err: boom}
	tg := &ensureCounter{Target: h.r.Target}
	h.r.Target = tg
	_, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key})
	if !errors.Is(err, boom) {
		t.Fatalf("Reconcile error %v, want %v", err, boom)
	}
	if tg.ensures != 0 {
		t.Fatalf("Ensure called %d times after a failed read", tg.ensures)
	}
	if _, ok := h.expectation(); !ok {
		t.Fatal("a failed read closed the expectation")
	}
}

// A NotFound from the read past the cache ends the round quietly and drops the expectation.
func TestFreshNotFoundForgetsExpectation(t *testing.T) {
	h := openExpectation(t)
	h.r.APIReader = failingReader{err: apierrors.NewNotFound(schema.GroupResource{Resource: "platforminstances"}, key.Name)}
	tg := &ensureCounter{Target: h.r.Target}
	h.r.Target = tg
	if _, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if tg.ensures != 0 {
		t.Fatalf("Ensure called %d times for a deleted instance", tg.ensures)
	}
	if v, ok := h.expectation(); ok {
		t.Fatalf("expectation %q left after the instance was gone", v)
	}
}

// Once the instance is gone from the cache, its expectation is dropped.
func TestDeletedInstanceForgetsExpectation(t *testing.T) {
	h := openExpectation(t)
	inst := h.get()
	inst.Finalizers = nil
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	if err := h.c.Delete(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	if _, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if v, ok := h.expectation(); ok {
		t.Fatalf("expectation %q left after the instance was deleted", v)
	}
}

// An update of the instance moves an open expectation to the written version, so the guard
// stays current for every writer of the instance.
func TestUpdateInstanceMovesExpectation(t *testing.T) {
	h := openExpectation(t)
	inst := h.get()
	if inst.Annotations == nil {
		inst.Annotations = map[string]string{}
	}
	inst.Annotations["test"] = "x"
	if err := h.r.updateInstance(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	if v, _ := h.expectation(); v != inst.ResourceVersion {
		t.Fatalf("expectation at %q, want the written version %q", v, inst.ResourceVersion)
	}
}
