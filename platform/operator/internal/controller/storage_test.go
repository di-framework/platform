package controller

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// cleanupJob returns the instance's cleanup Job, or nil when there is none.
func (h *harness) cleanupJob() *batchv1.Job {
	h.t.Helper()
	var inst v1alpha1.PlatformInstance
	if err := h.c.Get(context.Background(), key, &inst); err != nil {
		h.t.Fatal(err)
	}
	var job batchv1.Job
	err := h.c.Get(context.Background(), types.NamespacedName{Namespace: "platform-operator", Name: cleanupJobName(&inst)}, &job)
	if err != nil {
		if client.IgnoreNotFound(err) != nil {
			h.t.Fatal(err)
		}
		return nil
	}
	return &job
}

func (h *harness) jobCount() int {
	h.t.Helper()
	var jobs batchv1.JobList
	if err := h.c.List(context.Background(), &jobs); err != nil {
		h.t.Fatal(err)
	}
	return len(jobs.Items)
}

// finishCleanup marks the cleanup Job finished as the Job controller would.
func (h *harness) finishCleanup(typ batchv1.JobConditionType) {
	h.t.Helper()
	job := h.cleanupJob()
	if job == nil {
		h.t.Fatal("no cleanup Job to finish")
	}
	job.Status.Conditions = []batchv1.JobCondition{
		{Type: batchv1.JobSuspended, Status: corev1.ConditionFalse},
		{Type: typ, Status: corev1.ConditionTrue, Reason: "BackoffLimitExceeded", Message: "Job has reached the specified backoff limit"},
	}
	if err := h.c.Status().Update(context.Background(), job); err != nil {
		h.t.Fatal(err)
	}
}

// deleting creates an installed instance with the given spec and annotation changes, deletes it
// and runs it until the target is gone, so the next step is the storageRoot cleanup.
func deleting(t *testing.T, policy v1alpha1.DeletionPolicy, mutate func(*v1alpha1.PlatformInstance)) *harness {
	t.Helper()
	h := newHarness(t, policy)
	if mutate != nil {
		inst := h.get()
		mutate(inst)
		if err := h.c.Update(context.Background(), inst); err != nil {
			t.Fatal(err)
		}
	}
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	if err := h.c.Delete(context.Background(), h.get()); err != nil {
		t.Fatal(err)
	}
	h.tg.deleteDone = true
	return h
}

func (h *harness) released() bool {
	h.t.Helper()
	var inst v1alpha1.PlatformInstance
	return apierrors.IsNotFound(h.c.Get(context.Background(), key, &inst))
}

func TestDeleteRunsACleanupJobForExactlyTheInstanceRoot(t *testing.T) {
	h := deleting(t, v1alpha1.DeletionDelete, nil)
	if res := h.reconcile(); res.RequeueAfter != 10*time.Second {
		t.Fatalf("cleanup requeue %v, want the target poll", res.RequeueAfter)
	}
	job := h.cleanupJob()
	if job == nil {
		t.Fatal("no cleanup Job")
	}
	spec := job.Spec.Template.Spec
	c := spec.Containers[0]
	if want := []string{"rm", "-rf", "--", "/storage-root-base/team-a/one"}; !reflect.DeepEqual(c.Command, want) {
		t.Fatalf("command %q, want %q", c.Command, want)
	}
	if c.Image != CleanupImage || !strings.Contains(CleanupImage, "@sha256:") || len(c.Args) != 0 {
		t.Fatalf("image %q args %q", c.Image, c.Args)
	}
	hp := spec.Volumes[0].HostPath
	if hp == nil || hp.Path != "/var/lib/kubesolo/instances" || c.VolumeMounts[0].MountPath != "/storage-root-base" {
		t.Fatalf("mount %+v %+v", spec.Volumes, c.VolumeMounts)
	}
	if spec.RestartPolicy != corev1.RestartPolicyNever || *job.Spec.BackoffLimit != 0 || job.Spec.ActiveDeadlineSeconds == nil {
		t.Fatalf("job spec %+v", job.Spec)
	}
	if job.Annotations[OwnerAnnotation] != "team-a/one" || job.Labels["app.kubernetes.io/managed-by"] != "platform-operator" {
		t.Fatalf("job metadata %+v", job.ObjectMeta)
	}

	// Still running: the finalizer holds and no second Job is made.
	h.reconcile()
	if !containsFinalizer(h.get()) || h.jobCount() != 1 {
		t.Fatalf("running cleanup: finalizer %v jobs %d", containsFinalizer(h.get()), h.jobCount())
	}

	h.finishCleanup(batchv1.JobComplete)
	h.reconcile()
	if !h.released() || h.jobCount() != 0 {
		t.Fatalf("after cleanup: released %v jobs %d", h.released(), h.jobCount())
	}
}

func TestCustomStorageRootIsNeverCleaned(t *testing.T) {
	h := deleting(t, v1alpha1.DeletionDelete, func(inst *v1alpha1.PlatformInstance) {
		inst.Spec.Platform.StorageRoot = "/srv/data/team-a"
	})
	h.reconcile()
	if h.jobCount() != 0 || !h.released() {
		t.Fatalf("custom root: jobs %d released %v", h.jobCount(), h.released())
	}
	if got := h.in.installs[0].Settings["storageRoot"]; got != "/srv/data/team-a" {
		t.Fatalf("storageRoot setting %v", got)
	}
}

func TestSkipAnnotationReleasesWithoutCleaning(t *testing.T) {
	h := deleting(t, v1alpha1.DeletionDelete, func(inst *v1alpha1.PlatformInstance) {
		inst.Annotations = map[string]string{v1alpha1.AnnotationSkipStorageCleanup: "true"}
	})
	h.reconcile()
	if h.jobCount() != 0 || !h.released() {
		t.Fatalf("skip annotation: jobs %d released %v", h.jobCount(), h.released())
	}
}

func TestFailedCleanupKeepsTheFinalizer(t *testing.T) {
	h := deleting(t, v1alpha1.DeletionDelete, nil)
	h.reconcile()
	h.finishCleanup(batchv1.JobFailed)
	_, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key})
	if !errors.Is(err, ErrStorageCleanupFailed) {
		t.Fatalf("failed cleanup returned %v, want ErrStorageCleanupFailed for backoff", err)
	}
	inst := h.get()
	c := meta.FindStatusCondition(inst.Status.Conditions, v1alpha1.ConditionInstalled)
	if !containsFinalizer(inst) || c == nil || c.Reason != v1alpha1.ReasonStorageCleanupFailed ||
		!strings.Contains(c.Message, "/var/lib/kubesolo/instances/team-a/one") ||
		!strings.Contains(c.Message, v1alpha1.AnnotationSkipStorageCleanup) ||
		!strings.Contains(c.Message, "BackoffLimitExceeded") {
		t.Fatalf("failed cleanup status %+v", inst.Status)
	}
	if inst.Status.Phase != v1alpha1.PhaseDeleting {
		t.Fatalf("phase %s, want Deleting", inst.Status.Phase)
	}
	// The failed Job is removed so the retry runs a new one.
	if h.jobCount() != 0 {
		t.Fatal("failed Job left behind")
	}
	h.reconcile()
	if h.cleanupJob() == nil || !containsFinalizer(h.get()) {
		t.Fatal("retry didn't run a new cleanup Job")
	}

	// The way out: annotate the instance.
	inst = h.get()
	inst.Annotations = map[string]string{v1alpha1.AnnotationSkipStorageCleanup: "true"}
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.reconcile()
	if !h.released() {
		t.Fatal("skip annotation didn't release a failed cleanup")
	}
}

func TestRetainNeverCleansStorage(t *testing.T) {
	h := deleting(t, v1alpha1.DeletionRetain, nil)
	h.reconcile()
	if h.jobCount() != 0 || !h.released() || h.tg.deletes != 0 {
		t.Fatalf("Retain: jobs %d released %v deletes %d", h.jobCount(), h.released(), h.tg.deletes)
	}
}

func TestCleanupRefusesUnsafePaths(t *testing.T) {
	tests := []struct {
		name string
		base string
		ns   string
		want string
	}{
		{"relative base", "var/lib/instances", "team-a", "storage root base"},
		{"unclean base", "/var/lib/../instances", "team-a", "storage root base"},
		{"root base", "/", "team-a", "storage root base"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := deleting(t, v1alpha1.DeletionDelete, nil)
			h.r.StorageRootBase = tt.base
			_, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key})
			if !errors.Is(err, ErrUnsafeStoragePath) || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err %v", err)
			}
			if h.jobCount() != 0 || !containsFinalizer(h.get()) ||
				conditionReason(h.get(), v1alpha1.ConditionInstalled) != v1alpha1.ReasonStorageCleanupFailed {
				t.Fatalf("unsafe base: jobs %d status %+v", h.jobCount(), h.get().Status)
			}
		})
	}
}

func TestStorageRelPath(t *testing.T) {
	tests := []struct {
		ns, name, want string
		ok             bool
	}{
		{"team-a", "one", "team-a/one", true},
		{"team.a", "one.two", "team.a/one.two", true},
		{"", "one", "", false},
		{"team-a", "", "", false},
		{"..", "one", "", false},
		{"team-a", "..", "", false},
		{"team-a", ".", "", false},
		{".", "one", "", false},
		{"a..b", "one", "", false},
		{"team-a", "../etc", "", false},
		{"/etc", "one", "", false},
		{"team-a", "one/two", "", false},
		{`team\a`, "one", "", false},
	}
	for _, tt := range tests {
		got, err := storageRelPath(tt.ns, tt.name)
		if (err == nil) != tt.ok || got != tt.want {
			t.Errorf("storageRelPath(%q, %q) = %q, %v", tt.ns, tt.name, got, err)
		}
		if err != nil && !errors.Is(err, ErrUnsafeStoragePath) {
			t.Errorf("storageRelPath(%q, %q) error %v is not ErrUnsafeStoragePath", tt.ns, tt.name, err)
		}
	}
}

func TestCleanupNeedsANamespace(t *testing.T) {
	h := deleting(t, v1alpha1.DeletionDelete, nil)
	h.r.CleanupNamespace = ""
	if _, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); err == nil ||
		!strings.Contains(err.Error(), "--cleanup-namespace") {
		t.Fatalf("err %v", err)
	}
}

func TestCleanupJobOfAnotherInstanceIsNotTrusted(t *testing.T) {
	h := deleting(t, v1alpha1.DeletionDelete, nil)
	h.reconcile()
	job := h.cleanupJob()
	job.Annotations[OwnerAnnotation] = "team-b/other"
	if err := h.c.Update(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	h.finishCleanup(batchv1.JobComplete)
	if _, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); err == nil ||
		!strings.Contains(err.Error(), "team-b/other") {
		t.Fatalf("err %v", err)
	}
	if !containsFinalizer(h.get()) || h.jobCount() != 1 {
		t.Fatal("trusted another instance's Job")
	}
}

func TestCleanupJobNameFits(t *testing.T) {
	inst := &v1alpha1.PlatformInstance{}
	inst.Namespace, inst.Name = strings.Repeat("n", 63), strings.Repeat("x", 63)
	a := cleanupJobName(inst)
	inst.Namespace = "other"
	if len(a) > 63 || a == cleanupJobName(inst) {
		t.Fatalf("job names %q %q", a, cleanupJobName(inst))
	}
}
