package controller

import (
	"context"
	"sync"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// expectedWrites remembers, per instance, a status write the next rounds must see. The informer
// cache can lag the reconciler's own status patch, and a round that acts on the older copy repeats
// what the patch recorded: a second pod delete at the start of a resync (#481).
//
// It holds the resourceVersion known to include the write. A cached instance at that version has
// caught up; any other version (older, or newer from another writer) is settled by one read past
// the cache. resourceVersions are opaque, so only equality is compared.
type expectedWrites struct {
	mu   sync.Mutex
	want map[client.ObjectKey]string
}

// expect records that inst, as returned by a write, must be seen before the next round acts.
func (e *expectedWrites) expect(inst *v1alpha1.PlatformInstance) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.want == nil {
		e.want = map[client.ObjectKey]string{}
	}
	e.want[client.ObjectKeyFromObject(inst)] = inst.ResourceVersion
}

// wrote moves an open expectation to inst's version after a later write, which includes the
// expected one.
func (e *expectedWrites) wrote(inst *v1alpha1.PlatformInstance) {
	e.mu.Lock()
	defer e.mu.Unlock()
	k := client.ObjectKeyFromObject(inst)
	if _, ok := e.want[k]; ok {
		e.want[k] = inst.ResourceVersion
	}
}

// lagging reports whether a cached inst may predate an expected write; a cache at the expected
// version closes the expectation.
func (e *expectedWrites) lagging(inst *v1alpha1.PlatformInstance) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	k := client.ObjectKeyFromObject(inst)
	want, ok := e.want[k]
	if ok && want == inst.ResourceVersion {
		delete(e.want, k)
		return false
	}
	return ok
}

// forget drops the expectation for key, whose instance is gone.
func (e *expectedWrites) forget(key client.ObjectKey) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.want, key)
}

// fresh replaces a cached inst with the live instance, read past the cache, while the cache may
// not show a write this reconciler expects (see expectWrite). Without an APIReader it does
// nothing.
func (r *Reconciler) fresh(ctx context.Context, inst *v1alpha1.PlatformInstance) error {
	if r.APIReader == nil || !r.writes.lagging(inst) {
		return nil
	}
	var live v1alpha1.PlatformInstance
	if err := r.APIReader.Get(ctx, client.ObjectKeyFromObject(inst), &live); err != nil {
		if apierrors.IsNotFound(err) {
			// The instance is gone; nothing remains to wait for.
			r.writes.forget(client.ObjectKeyFromObject(inst))
		}
		return err
	}
	*inst = live
	// The live copy includes the write; wait for the cache to reach it.
	r.writes.expect(inst)
	return nil
}

// expectWrite makes the next rounds act on a copy that includes this write of inst (just
// patched), reading past the cache until the cache has it. Use it after a status write whose
// absence would make the next round repeat an action.
func (r *Reconciler) expectWrite(inst *v1alpha1.PlatformInstance) {
	if r.APIReader != nil {
		r.writes.expect(inst)
	}
}

// updateInstance updates inst and moves an open expectation to the written version, so every
// write of the instance keeps the guard in fresh current.
func (r *Reconciler) updateInstance(ctx context.Context, inst *v1alpha1.PlatformInstance) error {
	if err := r.Update(ctx, inst); err != nil {
		return err
	}
	r.writes.wrote(inst)
	return nil
}
