package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path"
	"strings"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// CleanupImage runs the storageRoot cleanup Job: busybox 1.38.0, pinned to its multi-arch index.
const CleanupImage = "docker.io/library/busybox:1.38.0@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e"

// cleanupMount is where the cleanup Job mounts --storage-root-base.
const cleanupMount = "/storage-root-base"

// cleanupDeadline bounds one cleanup Job, so a pod that can't start (an image that won't pull)
// fails the Job instead of holding the finalizer silently.
const cleanupDeadline int64 = 300

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

// checkStorageBase requires an absolute, clean --storage-root-base that isn't the node's root.
func checkStorageBase(base string) error {
	if !path.IsAbs(base) || path.Clean(base) != base || base == "/" {
		return fmt.Errorf("%w: storage root base %q must be an absolute, clean directory other than /", ErrUnsafeStoragePath, base)
	}
	return nil
}

// cleanupJobName is the instance's cleanup Job: one per instance, named by a hash of
// <namespace>/<name> so it fits and never collides.
func cleanupJobName(inst *v1alpha1.PlatformInstance) string {
	sum := sha256.Sum256([]byte(inst.Namespace + "/" + inst.Name))
	return "pi-storage-cleanup-" + hex.EncodeToString(sum[:])[:16]
}

// cleanStorage removes the instance's default storageRoot from the node with a Job that mounts
// --storage-root-base and runs rm -rf of exactly <namespace>/<name>. It returns done once the Job
// has succeeded and been deleted. A failed Job is deleted, so the next attempt runs a new one,
// and reported as ErrStorageCleanupFailed. The operator runs on one node (v1alpha1), so the Job
// lands on the node that holds the data.
func (r *Reconciler) cleanStorage(ctx context.Context, inst *v1alpha1.PlatformInstance) (bool, error) {
	rel, err := storageRelPath(inst.Namespace, inst.Name)
	if err != nil {
		return false, err
	}
	if err := checkStorageBase(r.StorageRootBase); err != nil {
		return false, err
	}
	if r.CleanupNamespace == "" {
		return false, errors.New("no namespace for the storage cleanup Job (set --cleanup-namespace)")
	}

	key := types.NamespacedName{Namespace: r.CleanupNamespace, Name: cleanupJobName(inst)}
	var job batchv1.Job
	err = r.Get(ctx, key, &job)
	if apierrors.IsNotFound(err) {
		job := cleanupJob(key, owner(inst), r.StorageRootBase, rel)
		if err := r.Create(ctx, job); client.IgnoreAlreadyExists(err) != nil {
			return false, fmt.Errorf("create storage cleanup Job: %w", err)
		}
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if job.Annotations[OwnerAnnotation] != owner(inst) {
		return false, fmt.Errorf("storage cleanup Job %s belongs to %q", key, job.Annotations[OwnerAnnotation])
	}
	succeeded, failed, msg := jobOutcome(&job)
	if !succeeded && !failed {
		return false, nil
	}
	if err := r.Delete(ctx, &job, client.PropagationPolicy(metav1.DeletePropagationBackground)); client.IgnoreNotFound(err) != nil {
		return false, fmt.Errorf("delete storage cleanup Job: %w", err)
	}
	if failed {
		return false, fmt.Errorf("%w: Job %s removing %s: %s", ErrStorageCleanupFailed, key, path.Join(r.StorageRootBase, rel), msg)
	}
	return true, nil
}

// OwnerAnnotation on a cleanup Job names the PlatformInstance ("<namespace>/<name>") it cleans.
const OwnerAnnotation = "platform.di-framework.dev/instance"

func owner(inst *v1alpha1.PlatformInstance) string { return inst.Namespace + "/" + inst.Name }

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

// cleanupJob builds the Job that removes base/rel on the node. The command has no shell, so the
// path is passed as one argument exactly as validated.
func cleanupJob(key types.NamespacedName, ownerRef, base, rel string) *batchv1.Job {
	labels := map[string]string{"app.kubernetes.io/component": "storage-cleanup"}
	for k, v := range ManagedLabels {
		labels[k] = v
	}
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: key.Namespace, Name: key.Name, Labels: labels,
			Annotations: map[string]string{OwnerAnnotation: ownerRef},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:          ptr.To[int32](0),
			ActiveDeadlineSeconds: ptr.To(cleanupDeadline),
			// The operator deletes the Job once it has read the outcome; this only catches a Job
			// left behind by an instance that went away some other way.
			TTLSecondsAfterFinished: ptr.To[int32](3600),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: ptr.To(false),
					Containers: []corev1.Container{{
						Name:            "rm",
						Image:           CleanupImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Command:         []string{"rm", "-rf", "--", path.Join(cleanupMount, rel)},
						VolumeMounts:    []corev1.VolumeMount{{Name: "storage-root-base", MountPath: cleanupMount}},
					}},
					Volumes: []corev1.Volume{{
						Name: "storage-root-base",
						VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{
							Path: base, Type: ptr.To(corev1.HostPathDirectoryOrCreate),
						}},
					}},
				},
			},
		},
	}
}
