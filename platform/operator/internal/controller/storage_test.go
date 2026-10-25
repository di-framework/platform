package controller

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

const cleanupNS = "platform-operator"

// cleanupJob returns the instance's cleanup Job, or nil when there is none.
func (h *harness) cleanupJob() *batchv1.Job {
	h.t.Helper()
	var job batchv1.Job
	err := h.c.Get(context.Background(), types.NamespacedName{Namespace: cleanupNS, Name: cleanupJobName(h.get())}, &job)
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

// cleanupPod stands in for the pod the Job controller starts. Its finalizer keeps it after a
// delete, as a terminating pod stays until its container has stopped.
func (h *harness) cleanupPod(job *batchv1.Job) *corev1.Pod {
	h.t.Helper()
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Namespace: cleanupNS, Name: job.Name + "-pod", Labels: job.Spec.Template.Labels,
		Finalizers: []string{"test/terminating"},
	}}
	if err := h.c.Create(context.Background(), pod); err != nil {
		h.t.Fatal(err)
	}
	return pod
}

// podState reports whether the pod still exists and whether it has been asked to go.
func (h *harness) podState(pod *corev1.Pod) (exists, deleting bool) {
	h.t.Helper()
	var p corev1.Pod
	err := h.c.Get(context.Background(), client.ObjectKeyFromObject(pod), &p)
	if apierrors.IsNotFound(err) {
		return false, false
	}
	if err != nil {
		h.t.Fatal(err)
	}
	return true, !p.DeletionTimestamp.IsZero()
}

// stopPod lets a terminating pod go, as kubelet does once its container has stopped.
func (h *harness) stopPod(pod *corev1.Pod) {
	h.t.Helper()
	var p corev1.Pod
	if err := h.c.Get(context.Background(), client.ObjectKeyFromObject(pod), &p); err != nil {
		h.t.Fatal(err)
	}
	controllerutil.RemoveFinalizer(&p, "test/terminating")
	if err := h.c.Update(context.Background(), &p); err != nil {
		h.t.Fatal(err)
	}
}

// finishCleanup marks the cleanup Job finished as the Job controller would.
func (h *harness) finishCleanup(typ batchv1.JobConditionType) {
	h.t.Helper()
	job := h.cleanupJob()
	if job == nil {
		h.t.Fatal("no cleanup Job to finish")
	}
	finish(h, job, typ)
}

func finish(h *harness, job *batchv1.Job, typ batchv1.JobConditionType) {
	h.t.Helper()
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

func (h *harness) annotate(k, v string) {
	h.t.Helper()
	inst := h.get()
	if inst.Annotations == nil {
		inst.Annotations = map[string]string{}
	}
	inst.Annotations[k] = v
	if err := h.c.Update(context.Background(), inst); err != nil {
		h.t.Fatal(err)
	}
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
	want := []string{"sh", "-c", cleanupScript, "cleanup",
		"/storage-root-base", "team-a/one", "team-a"}
	if !reflect.DeepEqual(c.Command, want) {
		t.Fatalf("command %q, want %q", c.Command, want)
	}
	if c.Image != CleanupImage || !strings.Contains(CleanupImage, "@sha256:") || len(c.Args) != 0 {
		t.Fatalf("image %q args %q", c.Image, c.Args)
	}
	hp := spec.Volumes[0].HostPath
	if hp == nil || hp.Path != "/var/lib/kubesolo/instances" || c.VolumeMounts[0].MountPath != "/storage-root-base" ||
		hp.Type == nil || *hp.Type != corev1.HostPathDirectoryOrCreate {
		t.Fatalf("mount %+v %+v", spec.Volumes, c.VolumeMounts)
	}
	if spec.RestartPolicy != corev1.RestartPolicyNever || *job.Spec.BackoffLimit != 0 ||
		job.Spec.ActiveDeadlineSeconds == nil || *job.Spec.ActiveDeadlineSeconds != 300 ||
		job.Spec.TTLSecondsAfterFinished == nil || *job.Spec.TTLSecondsAfterFinished != 3600 {
		t.Fatalf("job spec %+v", job.Spec)
	}
	if spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken {
		t.Fatal("service account token mounted")
	}
	if psc := spec.SecurityContext; psc == nil || psc.SeccompProfile == nil || psc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Fatalf("pod security context %+v", spec.SecurityContext)
	}
	sc := c.SecurityContext
	if sc == nil || sc.RunAsUser == nil || *sc.RunAsUser != 0 ||
		sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation ||
		sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem || sc.Privileged != nil ||
		sc.Capabilities == nil || !reflect.DeepEqual(sc.Capabilities.Drop, []corev1.Capability{"ALL"}) ||
		!reflect.DeepEqual(sc.Capabilities.Add, []corev1.Capability{"DAC_OVERRIDE", "FOWNER"}) {
		t.Fatalf("container security context %+v", sc)
	}
	for _, rl := range []corev1.ResourceList{c.Resources.Requests, c.Resources.Limits} {
		if rl.Cpu().IsZero() || rl.Memory().IsZero() {
			t.Fatalf("resources %+v", c.Resources)
		}
	}
	if job.Annotations[OwnerAnnotation] != "team-a/one" || job.Labels["app.kubernetes.io/managed-by"] != "platform-operator" ||
		job.Labels[LabelInstanceUID] != "uid-1" || job.Spec.Template.Labels[LabelInstanceUID] != "uid-1" ||
		job.Labels[LabelInstanceKey] == "" {
		t.Fatalf("job metadata %+v", job.ObjectMeta)
	}

	// Still running: the finalizer holds and no second Job is made.
	pod := h.cleanupPod(job)
	h.reconcile()
	if !containsFinalizer(h.get()) || h.jobCount() != 1 {
		t.Fatalf("running cleanup: finalizer %v jobs %d", containsFinalizer(h.get()), h.jobCount())
	}
	if exists, deleting := h.podState(pod); !exists || deleting {
		t.Fatal("the running Job's own pod was deleted")
	}

	// Done: the Job goes, and the instance waits for its pod.
	h.finishCleanup(batchv1.JobComplete)
	h.reconcile()
	h.reconcile()
	if h.released() || h.jobCount() != 0 {
		t.Fatalf("after cleanup with the pod left: released %v jobs %d", h.released(), h.jobCount())
	}
	h.stopPod(pod)
	h.reconcile()
	if !h.released() {
		t.Fatal("not released once the Job and its pod were gone")
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

func TestCustomStorageRootOverlappingTheBaseIsRejected(t *testing.T) {
	for _, root := range []string{
		"/var/lib/kubesolo/instances", "/var/lib/kubesolo/instances/team-b/two", "/var/lib/kubesolo/instances/team-a/one/x",
		"/var/lib/kubesolo/instances/../instances/team-a", "/",
		// With a base inside the root's platform data trees.
		"/srv/x",
	} {
		t.Run(root, func(t *testing.T) {
			h := newHarness(t, v1alpha1.DeletionDelete)
			if root == "/srv/x" {
				h.r.StorageRootBase = "/srv/x/di-tenants/instances"
			}
			inst := h.get()
			inst.Spec.Platform.StorageRoot = root
			if err := h.c.Update(context.Background(), inst); err != nil {
				t.Fatal(err)
			}
			h.readyTarget()
			h.reconcile()
			h.reconcile()
			if len(h.in.installs) != 0 || conditionReason(h.get(), v1alpha1.ConditionInstalled) != v1alpha1.ReasonInvalidStorageRoot ||
				h.get().Status.Phase != v1alpha1.PhaseFailed {
				t.Fatalf("installs %d status %+v", len(h.in.installs), h.get().Status)
			}
		})
	}
	// Roots the cleanup can't reach are accepted and installed, the platform's own default
	// /var/lib/kubesolo (which contains the base) among them.
	for _, root := range []string{"/var/lib/kubesolo", "/var/lib", "/var/lib/kubesolo/instances-other", "/srv/team-a"} {
		t.Run("accepts "+root, func(t *testing.T) {
			h := newHarness(t, v1alpha1.DeletionDelete)
			inst := h.get()
			inst.Spec.Platform.StorageRoot = root
			if err := h.c.Update(context.Background(), inst); err != nil {
				t.Fatal(err)
			}
			h.readyTarget()
			h.reconcile()
			h.reconcile()
			if len(h.in.installs) != 1 || h.get().Status.Phase != v1alpha1.PhaseReady {
				t.Fatalf("installs %d status %+v", len(h.in.installs), h.get().Status)
			}
		})
	}
	if customRootOverlapsCleanup("relative/dir", "/var/lib/kubesolo/instances") {
		t.Error("relative root reported as overlapping")
	}
}

// An instance installed before the check (or before --storage-root-base moved) never flips to
// Failed because of it.
func TestInstalledInstanceIsNotFailedByTheStorageRootCheck(t *testing.T) {
	h := newHarness(t, v1alpha1.DeletionDelete)
	inst := h.get()
	inst.Spec.Platform.StorageRoot = "/data/one"
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	h.r.StorageRootBase = "/data"
	h.now = h.now.Add(time.Hour)
	h.reconcile()
	if got := h.get(); got.Status.Phase != v1alpha1.PhaseReady || len(h.in.installs) != 2 ||
		conditionReason(got, v1alpha1.ConditionInstalled) == v1alpha1.ReasonInvalidStorageRoot {
		t.Fatalf("installs %d status %+v", len(h.in.installs), got.Status)
	}
}

// storage-cleaned counts only with this incarnation's UID: "true" or a copied UID is ignored.
func TestStorageCleanedAnnotationNeedsThisUID(t *testing.T) {
	for _, v := range []string{"true", "uid-0"} {
		t.Run(v, func(t *testing.T) {
			h := deleting(t, v1alpha1.DeletionDelete, func(inst *v1alpha1.PlatformInstance) {
				inst.Annotations = map[string]string{AnnotationStorageCleaned: v}
			})
			h.reconcile()
			if h.released() || h.cleanupJob() == nil {
				t.Fatalf("annotation %q skipped the cleanup: released %v", v, h.released())
			}
			h.finishCleanup(batchv1.JobComplete)
			h.reconcile()
			if !h.released() {
				t.Fatal("not released after the cleanup")
			}
		})
	}
}

// TestCleanupScript runs the real cleanupScript with /bin/sh against temp trees laid out as the
// pod sees them: the base, and things beside and outside it that must survive.
func TestCleanupScript(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("no /bin/sh")
	}
	type tree struct{ base, outside string }
	mk := func(t *testing.T, paths ...string) {
		t.Helper()
		for _, p := range paths {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(p, "f"), []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	exists := func(p string) bool { _, err := os.Lstat(p); return err == nil }
	run := func(t *testing.T, tr tree, ns, name string) error {
		t.Helper()
		p, err := newStoragePath(tr.base, ns, name)
		if err != nil {
			t.Fatal(err)
		}
		args := cleanupArgs(tr.base, p)
		cmd := exec.Command("/bin/sh", args[1:]...)
		cmd.Dir = t.TempDir() // a stray relative path lands here, not in the tree
		out, err := cmd.CombinedOutput()
		t.Logf("%s", out)
		return err
	}
	setup := func(t *testing.T) tree {
		t.Helper()
		root := t.TempDir()
		tr := tree{base: filepath.Join(root, "base"), outside: filepath.Join(root, "outside")}
		mk(t, filepath.Join(tr.base, "team-b", "one"), filepath.Join(tr.base, "team-a", "two"), filepath.Join(tr.outside, "one"))
		return tr
	}

	t.Run("removes exactly the instance directory", func(t *testing.T) {
		tr := setup(t)
		mk(t, filepath.Join(tr.base, "team-a", "one", "deep", "er"))
		if err := run(t, tr, "team-a", "one"); err != nil {
			t.Fatal(err)
		}
		if exists(filepath.Join(tr.base, "team-a", "one")) || !exists(filepath.Join(tr.base, "team-a", "two", "f")) ||
			!exists(filepath.Join(tr.base, "team-b", "one", "f")) || !exists(filepath.Join(tr.outside, "one", "f")) {
			t.Fatal("removed the wrong things")
		}
	})
	t.Run("already gone", func(t *testing.T) {
		tr := setup(t)
		if err := run(t, tr, "team-c", "one"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("symlink at the namespace is refused", func(t *testing.T) {
		tr := setup(t)
		if err := os.Symlink(tr.outside, filepath.Join(tr.base, "team-x")); err != nil {
			t.Fatal(err)
		}
		if err := run(t, tr, "team-x", "one"); err == nil {
			t.Fatal("followed a namespace symlink")
		}
		if !exists(filepath.Join(tr.outside, "one", "f")) {
			t.Fatal("the symlink's target was removed")
		}
	})
	t.Run("symlinked base is refused", func(t *testing.T) {
		tr := setup(t)
		link := filepath.Join(filepath.Dir(tr.base), "link")
		if err := os.Symlink(tr.base, link); err != nil {
			t.Fatal(err)
		}
		tr.base = link
		if err := run(t, tr, "team-a", "two"); err == nil {
			t.Fatal("followed a symlinked base")
		}
		if !exists(filepath.Join(link, "team-a", "two", "f")) {
			t.Fatal("data removed through a symlinked base")
		}
	})
	t.Run("symlink at the name removes only the link", func(t *testing.T) {
		tr := setup(t)
		if err := os.Symlink(filepath.Join(tr.outside, "one"), filepath.Join(tr.base, "team-a", "one")); err != nil {
			t.Fatal(err)
		}
		if err := run(t, tr, "team-a", "one"); err != nil {
			t.Fatal(err)
		}
		if exists(filepath.Join(tr.base, "team-a", "one")) || !exists(filepath.Join(tr.outside, "one", "f")) {
			t.Fatal("link kept or its target removed")
		}
	})
	// The API server never admits these names, but storageRelPath does, so the script must take
	// them as one operand each: not split on spaces, not read as rm options.
	for _, tt := range []struct{ ns, name string }{
		{"-rf", "one"}, {"-x y", "one"}, {"team-a", "two words"}, {"team-a", "-rf"},
	} {
		t.Run(tt.ns+"/"+tt.name, func(t *testing.T) {
			tr := setup(t)
			mk(t, filepath.Join(tr.base, tt.ns, tt.name), filepath.Join(tr.base, tt.ns, "keep"),
				filepath.Join(tr.base, "y"), filepath.Join(tr.base, "team-a", "two"))
			if err := run(t, tr, tt.ns, tt.name); err != nil {
				t.Fatal(err)
			}
			if exists(filepath.Join(tr.base, tt.ns, tt.name)) || !exists(filepath.Join(tr.base, tt.ns, "keep", "f")) ||
				!exists(filepath.Join(tr.base, "y", "f")) || !exists(filepath.Join(tr.base, "team-a", "two", "f")) {
				t.Fatal("removed the wrong things")
			}
		})
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

// escapeMidJob starts a cleanup Job and its pod, applies the way out, and checks that the Job
// is deleted and the instance is released only once the pod is gone.
func escapeMidJob(t *testing.T, way func(h *harness)) {
	t.Helper()
	h := deleting(t, v1alpha1.DeletionDelete, nil)
	h.reconcile()
	job := h.cleanupJob()
	if job == nil {
		t.Fatal("no cleanup Job")
	}
	pod := h.cleanupPod(job)

	way(h)
	h.reconcile()
	if h.jobCount() != 0 {
		t.Fatal("the cleanup Job outlived the way out")
	}
	if exists, deleting := h.podState(pod); !exists || !deleting {
		t.Fatalf("pod exists %v deleting %v, want terminating", exists, deleting)
	}
	if h.released() {
		t.Fatal("released while the cleanup pod still exists")
	}
	if c := meta.FindStatusCondition(h.get().Status.Conditions, v1alpha1.ConditionReady); c == nil ||
		c.Reason != "WaitingForStorageCleanup" || !strings.Contains(c.Message, "pod "+pod.Name) {
		t.Fatalf("no condition names the pod being waited for: %+v", c)
	}
	h.stopPod(pod)
	h.reconcile()
	if !h.released() {
		t.Fatal("not released once the cleanup pod was gone")
	}
}

func TestSkipAnnotationMidJobDeletesTheJobFirst(t *testing.T) {
	escapeMidJob(t, func(h *harness) { h.annotate(v1alpha1.AnnotationSkipStorageCleanup, "true") })
}

func TestRetainMidJobDeletesTheJobFirst(t *testing.T) {
	escapeMidJob(t, func(h *harness) {
		inst := h.get()
		inst.Spec.DeletionPolicy = v1alpha1.DeletionRetain
		if err := h.c.Update(context.Background(), inst); err != nil {
			h.t.Fatal(err)
		}
	})
}

func TestFailedCleanupBacksOff(t *testing.T) {
	h := deleting(t, v1alpha1.DeletionDelete, nil)
	h.reconcile()
	h.finishCleanup(batchv1.JobFailed)
	res, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key})
	if err != nil || res.RequeueAfter != 10*time.Second {
		t.Fatalf("failed cleanup: %v %v, want a 10s backoff", res, err)
	}
	inst := h.get()
	c := meta.FindStatusCondition(inst.Status.Conditions, v1alpha1.ConditionInstalled)
	if !containsFinalizer(inst) || c == nil || c.Reason != v1alpha1.ReasonStorageCleanupFailed ||
		!strings.Contains(c.Message, "/var/lib/kubesolo/instances/team-a/one") ||
		!strings.Contains(c.Message, v1alpha1.AnnotationSkipStorageCleanup) ||
		!strings.Contains(c.Message, "BackoffLimitExceeded") || !strings.Contains(c.Message, "attempt 1") {
		t.Fatalf("failed cleanup status %+v", inst.Status)
	}
	if inst.Status.Phase != v1alpha1.PhaseDeleting || inst.Annotations[AnnotationCleanupFailures] != "1" {
		t.Fatalf("phase %s annotations %v", inst.Status.Phase, inst.Annotations)
	}
	// The failed Job is removed, and the next one waits out the backoff.
	if h.jobCount() != 0 {
		t.Fatal("failed Job left behind")
	}
	h.now = h.now.Add(4 * time.Second)
	if res := h.reconcile(); h.jobCount() != 0 || res.RequeueAfter != 6*time.Second {
		t.Fatalf("retried within the backoff: jobs %d requeue %v", h.jobCount(), res.RequeueAfter)
	}
	h.now = h.now.Add(6 * time.Second)
	h.reconcile()
	if h.cleanupJob() == nil || !containsFinalizer(h.get()) {
		t.Fatal("retry didn't run a new cleanup Job")
	}

	// The second failure doubles the wait.
	h.finishCleanup(batchv1.JobFailed)
	if res := h.reconcile(); res.RequeueAfter != 20*time.Second || h.get().Annotations[AnnotationCleanupFailures] != "2" {
		t.Fatalf("second failure requeue %v annotations %v", res.RequeueAfter, h.get().Annotations)
	}

	// The way out: annotate the instance.
	h.annotate(v1alpha1.AnnotationSkipStorageCleanup, "true")
	h.reconcile()
	if !h.released() || h.jobCount() != 0 {
		t.Fatalf("skip annotation: released %v jobs %d", h.released(), h.jobCount())
	}
}

func TestCleanupBackoff(t *testing.T) {
	want := map[int]time.Duration{0: 0, 1: 10 * time.Second, 2: 20 * time.Second, 3: 40 * time.Second,
		5: 160 * time.Second, 6: 5 * time.Minute, 7: 5 * time.Minute, 100: 5 * time.Minute}
	for n, d := range want {
		if got := cleanupBackoff(n); got != d {
			t.Errorf("cleanupBackoff(%d) = %v, want %v", n, got, d)
		}
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

// The API server never admits these names; the fake client does, so this pins that Reconcile
// itself refuses them before any Job exists.
func TestCleanupRefusesAnUnsafeInstanceName(t *testing.T) {
	h := newHarness(t, v1alpha1.DeletionDelete)
	bad := types.NamespacedName{Namespace: "team-a", Name: "x..y"}
	inst := &v1alpha1.PlatformInstance{
		ObjectMeta: metav1.ObjectMeta{Namespace: bad.Namespace, Name: bad.Name, UID: "uid-bad", Finalizers: []string{Finalizer}},
		Spec:       v1alpha1.PlatformInstanceSpec{Version: "6.0.17", Target: v1alpha1.TargetSpec{Type: v1alpha1.TargetVCluster}},
	}
	if err := h.c.Create(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	if err := h.c.Delete(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.tg.deleteDone = true
	_, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: bad})
	if !errors.Is(err, ErrUnsafeStoragePath) {
		t.Fatalf("err %v, want ErrUnsafeStoragePath", err)
	}
	var got v1alpha1.PlatformInstance
	if err := h.c.Get(context.Background(), bad, &got); err != nil {
		t.Fatal(err)
	}
	if !containsFinalizer(&got) || conditionReason(&got, v1alpha1.ConditionInstalled) != v1alpha1.ReasonStorageCleanupFailed || h.jobCount() != 0 {
		t.Fatalf("unsafe name: jobs %d status %+v", h.jobCount(), got.Status)
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

// A finished Job left by an earlier instance of the same name, even under this incarnation's
// Job name, is deleted unread, and a fresh Job runs for this one.
func TestCleanupJobOfAnEarlierIncarnationIsNotTrusted(t *testing.T) {
	h := deleting(t, v1alpha1.DeletionDelete, nil)
	inst := h.get()
	old := inst.DeepCopy()
	old.UID = "uid-0"
	stale := []*batchv1.Job{
		cleanupJob(types.NamespacedName{Namespace: cleanupNS, Name: cleanupJobName(old)}, old, storagePath{"/var/lib/kubesolo/instances", "team-a/one"}),
		cleanupJob(types.NamespacedName{Namespace: cleanupNS, Name: cleanupJobName(inst)}, old, storagePath{"/var/lib/kubesolo/instances", "team-a/one"}),
	}
	for _, job := range stale {
		if err := h.c.Create(context.Background(), job); err != nil {
			t.Fatal(err)
		}
		finish(h, job, batchv1.JobComplete)
	}

	h.reconcile()
	if h.released() || h.jobCount() != 0 {
		t.Fatalf("trusted a stale Job: released %v jobs %d", h.released(), h.jobCount())
	}
	h.reconcile()
	job := h.cleanupJob()
	if job == nil || job.Labels[LabelInstanceUID] != "uid-1" || len(job.Status.Conditions) != 0 || h.released() {
		t.Fatalf("no fresh cleanup Job for this incarnation: %+v released %v", job, h.released())
	}
}

func TestCleanupJobNameFits(t *testing.T) {
	inst := &v1alpha1.PlatformInstance{}
	inst.Namespace, inst.Name, inst.UID = strings.Repeat("n", 63), strings.Repeat("x", 253), "uid-1"
	a := cleanupJobName(inst)
	inst.UID = "uid-2"
	b := cleanupJobName(inst)
	inst.Namespace = "other"
	if len(a) > 63 || a == b || b == cleanupJobName(inst) {
		t.Fatalf("job names %q %q %q", a, b, cleanupJobName(inst))
	}
}
