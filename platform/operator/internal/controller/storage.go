package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path"
	"strconv"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// CleanupImage runs the storageRoot cleanup Job: busybox 1.38.0, pinned to its multi-arch index.
const CleanupImage = "docker.io/library/busybox:1.38.0@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e"

// cleanupMount is where the cleanup Job mounts the parent of --storage-root-base.
const cleanupMount = "/storage-root-parent"

// cleanupDeadline bounds one cleanup Job, so a pod that can't start (an image that won't pull, a
// missing --storage-root-base) fails the Job instead of holding the finalizer silently.
const cleanupDeadline int64 = 300

// cleanupTTL removes a finished Job the operator didn't delete itself.
const cleanupTTL int32 = 3600

// cleanupBackoffBase and cleanupBackoffMax bound the wait between failed cleanup attempts: the
// base after the first failure, doubling per failure, capped at the max.
const (
	cleanupBackoffBase = 10 * time.Second
	cleanupBackoffMax  = 5 * time.Minute
)

// Labels and annotations on cleanup Jobs, their pods and the instance.
const (
	// OwnerAnnotation on a cleanup Job names the PlatformInstance ("<namespace>/<name>") it cleans.
	OwnerAnnotation = "platform.di-framework.dev/instance"
	// LabelInstanceKey is a hash of the instance's <namespace>/<name>, shared by every incarnation.
	LabelInstanceKey = "platform.di-framework.dev/instance-key"
	// LabelInstanceUID is the UID of the incarnation a cleanup Job belongs to.
	LabelInstanceUID = "platform.di-framework.dev/instance-uid"
	// AnnotationCleanupFailures counts the failed cleanup attempts of a deleting instance.
	AnnotationCleanupFailures = "platform.di-framework.dev/storage-cleanup-failures"
	// AnnotationStorageCleaned holds the UID of the incarnation whose cleanup Job succeeded. Any
	// other value ("true", another UID from a copied manifest) is ignored.
	AnnotationStorageCleaned = "platform.di-framework.dev/storage-cleaned"
	// AnnotationCleanupFailedAt is when the last cleanup attempt failed (RFC 3339).
	AnnotationCleanupFailedAt = "platform.di-framework.dev/storage-cleanup-failed-at"
)

// ErrUnsafeStoragePath reports a storageRoot the cleanup refuses to remove.
var ErrUnsafeStoragePath = errors.New("unsafe storage path")

// ErrStorageCleanupFailed reports a cleanup Job that failed.
var ErrStorageCleanupFailed = errors.New("storage cleanup failed")

// storageRoot is the instance's storageRoot: spec.platform.storageRoot, or the operator's default.
func (r *Reconciler) storageRoot(inst *v1alpha1.PlatformInstance) string {
	if root := inst.Spec.Platform.StorageRoot; root != "" {
		return root
	}
	// Kubernetes names can't contain "/", so <namespace>/<name> is unique per instance.
	return path.Join(r.StorageRootBase, inst.Namespace, inst.Name)
}

// storagePath is a validated default storageRoot: a checked base and exactly <namespace>/<name>
// under it. Only newStoragePath builds one, so the cleanup can't run on an unchecked path.
type storagePath struct {
	base, rel string
}

func (p storagePath) String() string { return path.Join(p.base, p.rel) }

// newStoragePath validates --storage-root-base and the instance's namespace and name.
func newStoragePath(base, namespace, name string) (storagePath, error) {
	if err := CheckStorageBase(base); err != nil {
		return storagePath{}, err
	}
	rel, err := storageRelPath(namespace, name)
	if err != nil {
		return storagePath{}, err
	}
	return storagePath{base: base, rel: rel}, nil
}

// storageRelPath is the default storageRoot relative to --storage-root-base: exactly
// <namespace>/<name>. It refuses anything that could reach outside that directory.
func storageRelPath(namespace, name string) (string, error) {
	for _, part := range []string{namespace, name} {
		if part == "" || part == "." || strings.Contains(part, "..") || strings.ContainsAny(part, `/\`) {
			return "", fmt.Errorf("%w: %q/%q", ErrUnsafeStoragePath, namespace, name)
		}
	}
	return namespace + "/" + name, nil
}

// CheckStorageBase requires an absolute, clean --storage-root-base at least two levels deep: the
// cleanup Job mounts its parent, which must not be the node's root.
func CheckStorageBase(base string) error {
	if !path.IsAbs(base) || path.Clean(base) != base || path.Dir(base) == "/" || base == "/" {
		return fmt.Errorf("%w: storage root base %q must be an absolute, clean directory whose parent isn't /", ErrUnsafeStoragePath, base)
	}
	return nil
}

// platformDataDirs are where the platform writes under a storageRoot (src/tenancy, src/index.ts).
var platformDataDirs = []string{"di-tenants", "di-framework"}

func within(p, dir string) bool { return p == dir || dir == "/" || strings.HasPrefix(p, dir+"/") }

// customRootOverlapsCleanup reports whether a custom storageRoot's data could be removed by the
// cleanup of some default storageRoot <base>/<ns>/<name>: the root lies inside the base, or the
// base lies inside one of the platform's data trees under the root. A root that merely contains
// the base (the platform's own /var/lib/kubesolo) is disjoint from what the cleanup removes.
func customRootOverlapsCleanup(root, base string) bool {
	root = path.Clean(root)
	if !path.IsAbs(root) {
		return false
	}
	if root == "/" || within(root, base) {
		return true
	}
	for _, d := range platformDataDirs {
		if within(base, path.Join(root, d)) {
			return true
		}
	}
	return false
}

func shortHash(s string, n int) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:n]
}

// instanceKey labels every cleanup Job of <namespace>/<name>, whatever the incarnation.
func instanceKey(inst *v1alpha1.PlatformInstance) string { return shortHash(owner(inst), 16) }

// cleanupJobName is the cleanup Job of this incarnation: a hash of <namespace>/<name> and a hash
// of the UID, so it fits in 63 characters and a recreated instance never reuses it.
func cleanupJobName(inst *v1alpha1.PlatformInstance) string {
	return "pi-storage-cleanup-" + instanceKey(inst) + "-" + shortHash(string(inst.UID), 8)
}

func owner(inst *v1alpha1.PlatformInstance) string { return inst.Namespace + "/" + inst.Name }

// cleanupBackoff is the wait after the given number of failed attempts.
func cleanupBackoff(failures int) time.Duration {
	if failures < 1 {
		return 0
	}
	d := cleanupBackoffBase
	for i := 1; i < failures && d < cleanupBackoffMax; i++ {
		d *= 2
	}
	return min(d, cleanupBackoffMax)
}

// sweepCleanup deletes every cleanup Job and pod of the instance's <namespace>/<name>, except
// this incarnation's Job and its pods when keepCurrent is set, and returns the ones still
// left ("Job x", "pod y"). A Job of another incarnation is never read, only deleted: its rm could still
// run against a recreated instance's data, and its result says nothing about this one.
func (r *Reconciler) sweepCleanup(ctx context.Context, inst *v1alpha1.PlatformInstance, keepCurrent bool) ([]string, error) {
	if r.CleanupNamespace == "" {
		return nil, nil // no cleanup Job can have been created
	}
	sel := []client.ListOption{client.InNamespace(r.CleanupNamespace), client.MatchingLabels{LabelInstanceKey: instanceKey(inst)}}
	current := func(o client.Object) bool {
		return keepCurrent && o.GetLabels()[LabelInstanceUID] == string(inst.UID)
	}
	var left []string

	var jobs batchv1.JobList
	if err := r.List(ctx, &jobs, sel...); err != nil {
		return nil, fmt.Errorf("list storage cleanup Jobs: %w", err)
	}
	for i := range jobs.Items {
		job := &jobs.Items[i]
		if current(job) && job.Name == cleanupJobName(inst) {
			continue
		}
		left = append(left, "Job "+job.Name)
		if job.DeletionTimestamp.IsZero() {
			if err := r.Delete(ctx, job, client.PropagationPolicy(metav1.DeletePropagationBackground)); client.IgnoreNotFound(err) != nil {
				return nil, fmt.Errorf("delete storage cleanup Job %s: %w", job.Name, err)
			}
		}
	}

	// Background propagation leaves the pods to the garbage collector; the instance is released
	// only once they are gone too, so no rm can still run.
	var pods corev1.PodList
	if err := r.List(ctx, &pods, sel...); err != nil {
		return nil, fmt.Errorf("list storage cleanup pods: %w", err)
	}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if current(pod) {
			continue
		}
		left = append(left, "pod "+pod.Name)
		if pod.DeletionTimestamp.IsZero() {
			if err := r.Delete(ctx, pod); client.IgnoreNotFound(err) != nil {
				return nil, fmt.Errorf("delete storage cleanup pod %s: %w", pod.Name, err)
			}
		}
	}
	return left, nil
}

// cleanStorage removes the instance's default storageRoot from the node with a Job that mounts
// --storage-root-base and runs rm -rf of exactly <namespace>/<name>. It returns done once this
// incarnation's Job has succeeded. Jobs and pods of other incarnations are deleted first, and
// nothing new starts until they are gone. A failed Job is deleted and counted on the instance;
// the next one starts after an exponential backoff, which retry reports. The operator runs on
// one node (v1alpha1), so the Job lands on the node that holds the data.
func (r *Reconciler) cleanStorage(ctx context.Context, inst *v1alpha1.PlatformInstance) (done bool, retry time.Duration, err error) {
	p, err := newStoragePath(r.StorageRootBase, inst.Namespace, inst.Name)
	if err != nil {
		return false, 0, err
	}
	if r.CleanupNamespace == "" {
		return false, 0, errors.New("no namespace for the storage cleanup Job (set --cleanup-namespace)")
	}
	if inst.UID == "" {
		return false, 0, errors.New("instance has no UID")
	}

	if left, err := r.sweepCleanup(ctx, inst, true); err != nil || len(left) > 0 {
		return false, 0, err
	}

	key := types.NamespacedName{Namespace: r.CleanupNamespace, Name: cleanupJobName(inst)}
	var job batchv1.Job
	err = r.Get(ctx, key, &job)
	if apierrors.IsNotFound(err) {
		failures, _ := strconv.Atoi(inst.Annotations[AnnotationCleanupFailures])
		if failedAt, perr := time.Parse(time.RFC3339, inst.Annotations[AnnotationCleanupFailedAt]); perr == nil {
			if wait := failedAt.Add(cleanupBackoff(failures)).Sub(r.now()); wait > 0 {
				return false, wait, nil
			}
		}
		if err := r.Create(ctx, cleanupJob(key, inst, p, inst.Status.InstalledVersion != "")); client.IgnoreAlreadyExists(err) != nil {
			return false, 0, fmt.Errorf("create storage cleanup Job: %w", err)
		}
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	succeeded, failed, msg := jobOutcome(&job)
	if !succeeded && !failed {
		return false, 0, nil
	}
	if err := r.Delete(ctx, &job, client.PropagationPolicy(metav1.DeletePropagationBackground)); client.IgnoreNotFound(err) != nil {
		return false, 0, fmt.Errorf("delete storage cleanup Job: %w", err)
	}
	if inst.Annotations == nil {
		inst.Annotations = map[string]string{}
	}
	if succeeded {
		// Recorded, so the release that waits for the Job's pod never starts a second Job.
		inst.Annotations[AnnotationStorageCleaned] = string(inst.UID)
		return true, 0, r.Update(ctx, inst)
	}
	failures, _ := strconv.Atoi(inst.Annotations[AnnotationCleanupFailures])
	failures++
	inst.Annotations[AnnotationCleanupFailures] = strconv.Itoa(failures)
	inst.Annotations[AnnotationCleanupFailedAt] = r.now().UTC().Format(time.RFC3339)
	if err := r.Update(ctx, inst); err != nil {
		return false, 0, err
	}
	wait := cleanupBackoff(failures)
	return false, wait, fmt.Errorf("%w (attempt %d, next in %s): Job %s removing %s: %s",
		ErrStorageCleanupFailed, failures, wait, key, p, msg)
}

// jobOutcome reads a Job's Complete or Failed condition.
func jobOutcome(job *batchv1.Job) (succeeded, failed bool, msg string) {
	for _, c := range job.Status.Conditions {
		if c.Status != corev1.ConditionTrue {
			continue
		}
		switch c.Type {
		case batchv1.JobComplete:
			return true, false, ""
		case batchv1.JobFailed:
			return false, true, strings.TrimSpace(c.Reason + ": " + c.Message)
		}
	}
	return false, false, ""
}

// cleanupScript runs in the cleanup pod with the base, the path to remove and the install state
// as positional arguments, never interpolated into the script. The pod mounts the base's parent
// (hostPath Directory), so a missing base reaches the script instead of failing the mount:
//   - base present: rm -rf of exactly the validated path; an absent path is already clean.
//   - base missing and the instance never installed: nothing can have been written, so it is
//     clean (the first instance on a fresh node, deleted before it installed).
//   - base missing after an install: the data may sit elsewhere (a changed flag, another node),
//     so the Job fails instead of reporting cleaned.
//   - base a symlink: refused, since it would resolve inside the container, not on the node.
const cleanupScript = `if [ -L "$1" ]; then echo "storage root base $1 is a symlink" >&2; exit 1; fi
if [ -d "$1" ]; then exec rm -rf -- "$2"; fi
if [ "$3" = never-installed ]; then exit 0; fi
echo "storage root base $1 is missing on this node, but the instance was installed" >&2
exit 1`

// cleanupJob builds the Job that removes p on the node.
//
// The pod runs as root, since tenant data is owned by other UIDs, with every capability dropped
// but the two unlink needs there: DAC_OVERRIDE to enter and write directories root doesn't own,
// and FOWNER to unlink other users' files in sticky directories. Checked with podman against
// busybox rm -rf: without both, such a tree fails with EPERM and stays.
func cleanupJob(key types.NamespacedName, inst *v1alpha1.PlatformInstance, p storagePath, installed bool) *batchv1.Job {
	podBase := path.Join(cleanupMount, path.Base(p.base))
	state := "never-installed"
	if installed {
		state = "installed"
	}
	labels := map[string]string{
		"app.kubernetes.io/component": "storage-cleanup",
		LabelInstanceKey:              instanceKey(inst),
		LabelInstanceUID:              string(inst.UID),
	}
	for k, v := range ManagedLabels {
		labels[k] = v
	}
	requests := corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m"), corev1.ResourceMemory: resource.MustParse("16Mi")}
	limits := corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("200m"), corev1.ResourceMemory: resource.MustParse("64Mi")}
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: key.Namespace, Name: key.Name, Labels: labels,
			Annotations: map[string]string{OwnerAnnotation: owner(inst), LabelInstanceUID: string(inst.UID)},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:          ptr.To[int32](0),
			ActiveDeadlineSeconds: ptr.To(cleanupDeadline),
			// The operator deletes the Job once it has read the outcome; this only catches a Job
			// left behind by an instance that went away some other way.
			TTLSecondsAfterFinished: ptr.To(cleanupTTL),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: ptr.To(false),
					SecurityContext: &corev1.PodSecurityContext{
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Containers: []corev1.Container{{
						Name:            "rm",
						Image:           CleanupImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Command:         []string{"sh", "-c", cleanupScript, "cleanup", podBase, path.Join(podBase, p.rel), state},
						VolumeMounts:    []corev1.VolumeMount{{Name: "storage-root-base", MountPath: cleanupMount}},
						Resources:       corev1.ResourceRequirements{Requests: requests, Limits: limits},
						SecurityContext: &corev1.SecurityContext{
							RunAsUser:                ptr.To[int64](0),
							AllowPrivilegeEscalation: ptr.To(false),
							ReadOnlyRootFilesystem:   ptr.To(true),
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
								Add:  []corev1.Capability{"DAC_OVERRIDE", "FOWNER"},
							},
						},
					}},
					Volumes: []corev1.Volume{{
						Name: "storage-root-base",
						// The base's parent, as Directory, never DirectoryOrCreate: kubelet creates
						// nothing, and cleanupScript decides what a missing base means.
						VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{
							Path: path.Dir(p.base), Type: ptr.To(corev1.HostPathDirectory),
						}},
					}},
				},
			},
		},
	}
}
