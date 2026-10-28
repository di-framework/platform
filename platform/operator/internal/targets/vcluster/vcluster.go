// Package vcluster is the vCluster target: one vCluster per PlatformInstance, in its own host
// namespace, installed from the operator's embedded, digest-pinned chart.
package vcluster

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/targets"
)

// ChartVersion is the embedded vCluster chart's version.
const ChartVersion = "0.37.3"

// chartSHA256 is the embedded archive's digest, as published in charts.loft.sh's index.yaml.
const chartSHA256 = "96ac5c5fb841c8708991b04382b81971405788378f7dbc413ec2fdb67f1d95dc"

//go:embed chart/vcluster-0.37.3.tgz
var chartArchive []byte

// ReleaseName is the Helm release in each instance's host namespace. vCluster names its
// StatefulSet and Service after it and its kubeconfig Secret "vc-<release>".
const ReleaseName = "vcluster"

// Chart returns the embedded chart archive after checking its digest.
func Chart() ([]byte, error) {
	sum := sha256.Sum256(chartArchive)
	if got := hex.EncodeToString(sum[:]); got != chartSHA256 {
		return nil, fmt.Errorf("embedded vcluster chart digest %s, want %s", got, chartSHA256)
	}
	return chartArchive, nil
}

// OwnerAnnotation on a host namespace names the PlatformInstance ("<namespace>/<name>") it
// belongs to. The target never installs into or deletes a namespace another instance owns.
const OwnerAnnotation = "platform.di-framework.dev/instance"

// ErrReinstalling reports that Ensure removed a failed or interrupted vCluster release, which the
// next round installs again.
var ErrReinstalling = errors.New("reinstalling vcluster")

// ErrRolledBack reports that Ensure rolled back a failed or interrupted repair. It comes with a
// RolledBack State, so a repair that fails every time backs off instead of cycling every poll.
var ErrRolledBack = errors.New("rolled back vcluster release")

// Release is what the target needs to know about an installed Helm release.
type Release struct {
	// Status is Helm's release status: deployed, failed, pending-install and so on.
	Status string
	// Description is Helm's note on the last operation, which carries the failure.
	Description string
	// Revision is the release's latest revision; 1 is the install.
	Revision int
}

// Releaser is the Helm surface the target uses.
type Releaser interface {
	// Get returns the release, or nil when there is none.
	Get(ctx context.Context, namespace, name string) (*Release, error)
	// Install installs the chart archive as name in the existing namespace.
	Install(ctx context.Context, namespace, name string, chart []byte, values map[string]any) error
	// Repair re-applies the release with the chart and values it was installed with, which
	// recreates any of its objects that are missing and leaves the rest unchanged.
	Repair(ctx context.Context, namespace, name string) error
	// Rollback rolls the release back to its last deployed revision and returns it.
	Rollback(ctx context.Context, namespace, name string) (int, error)
	// Uninstall removes the release; a missing release is not an error.
	Uninstall(ctx context.Context, namespace, name string) error
}

// Target provisions vClusters on the operator's own cluster.
type Target struct {
	// Client reads and deletes objects in the host cluster.
	Client client.Client
	Helm   Releaser
	// HostDNS is the host cluster's DNS Service, which instance CoreDNS forwards to. Empty uses
	// kube-system/kube-dns.
	HostDNS types.NamespacedName
	// Values renders the chart values for an instance; nil uses InstanceValues with the host
	// DNS Service's ClusterIP.
	Values func(ctx context.Context, inst *v1alpha1.PlatformInstance) (map[string]any, error)
	// OperatorNamespace is the operator's own namespace, which the host-namespace
	// NetworkPolicies admit to the vCluster API.
	OperatorNamespace string
	// OperatorUsername is the operator's own user (system:serviceaccount:<ns>:<name>), which the
	// admission policy lets delete service/vcluster.
	OperatorUsername string
	// Dial checks that the vCluster API answers at address (host:port); nil opens a TCP
	// connection with a 5 second timeout.
	Dial func(ctx context.Context, address string) error

	// ResyncTimeout bounds a resync: one waiting longer at the same stage is reported
	// TargetUnreachable. Zero means no bound.
	ResyncTimeout time.Duration
	// Now is injectable for tests; nil uses time.Now.
	Now func() time.Time

	mu sync.Mutex
	// failures counts consecutive failed API checks per host namespace.
	failures map[string]int
}

// releaseObjects are the vCluster release's host-namespace objects Ensure checks on every round.
// Helm creates them all before the install returns, so a missing one was deleted.
func releaseObjects(ns string) []client.Object {
	return []client.Object{
		&appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName + "-headless"}},
	}
}

var _ targets.Target = (*Target)(nil)

// Ensure puts the host-namespace NetworkPolicies in place (every round, so a deleted or edited
// one comes back), installs the vCluster once and reports it ready when its control plane is
// ready, its kubeconfig Secret exists and its API answers. Values are applied at creation only
// (see InstanceValues). A release left failed or pending by the install (revision 1) is removed
// so the next round installs it again. That is reported as an error, so an install that fails
// the same way every time backs off instead of cycling every poll. A later revision left failed
// or pending (a repair that errored or was interrupted) is rolled back to the last deployed one
// instead, so a working control plane is never uninstalled. When one of the release's
// host-namespace objects is missing, the stored release is re-applied (#453). The API is reported
// unreachable only after UnreachableAfter consecutive failed checks, so one slow dial doesn't
// flip a ready instance.
func (t *Target) Ensure(ctx context.Context, inst *v1alpha1.PlatformInstance) (targets.State, error) {
	unprotected, err := t.applyAdmissionPolicy(ctx)
	if err != nil {
		return targets.State{}, err
	}
	st, err := t.ensure(ctx, inst)
	st.Unprotected = unprotected
	return st, err
}

func (t *Target) ensure(ctx context.Context, inst *v1alpha1.PlatformInstance) (targets.State, error) {
	ns := HostNamespace(inst)
	// The unreachable count is of consecutive checks: a round that stops before the check
	// (repairing, control plane or Secret pending, an error) starts it over.
	checked := false
	defer func() {
		if !checked {
			t.resetFailures(ns)
		}
	}()
	namespace, st, stop, err := t.claimNamespace(ctx, inst, ns)
	if stop || err != nil {
		return st, err
	}
	// A resync after the host namespace was deleted (#490) runs on the vCluster installed in the
	// namespace created again; it reports Resyncing until that vCluster answers.
	hostResync := inst.Status.Target.ResyncServiceUID == ResyncHostNamespace
	if err := t.applyNetworkPolicies(ctx, ns); err != nil {
		return targets.State{}, err
	}
	rel, err := t.Helm.Get(ctx, ns, ReleaseName)
	if err != nil {
		return targets.State{}, fmt.Errorf("look up vcluster release: %w", err)
	}
	if rel == nil {
		chart, err := Chart()
		if err != nil {
			return targets.State{}, err
		}
		values, err := t.values(ctx, inst)
		if err != nil {
			return targets.State{}, err
		}
		if err := t.Helm.Install(ctx, ns, ReleaseName, chart, values); err != nil {
			return targets.State{}, fmt.Errorf("install vcluster %s: %w", ChartVersion, err)
		}
		msg := fmt.Sprintf("installed vcluster %s in namespace %s", ChartVersion, ns)
		if hostResync {
			return targets.State{Reason: ReasonResyncing, Message: "resyncing: host namespace was deleted; " + msg}, nil
		}
		return targets.State{Reason: "Creating", Message: msg}, nil
	}
	if rel.Status != "deployed" && rel.Status != "pending-install" && rel.Revision > 1 {
		// A repair (or rollback) that failed or was interrupted: the instance had a working
		// control plane, so go back to it instead of uninstalling.
		rev, err := t.Helm.Rollback(ctx, ns, ReleaseName)
		if err != nil {
			return targets.State{}, fmt.Errorf("roll back %s vcluster release revision %d: %w", rel.Status, rel.Revision, err)
		}
		msg := fmt.Sprintf("vcluster release revision %d was %s (%s); rolled back to revision %d", rel.Revision, rel.Status, rel.Description, rev)
		return targets.State{Reason: "RolledBack", Message: msg}, fmt.Errorf("%w: %s", ErrRolledBack, msg)
	}
	if rel.Status != "deployed" {
		if err := t.Helm.Uninstall(ctx, ns, ReleaseName); err != nil {
			return targets.State{}, fmt.Errorf("remove %s vcluster release: %w", rel.Status, err)
		}
		return targets.State{}, fmt.Errorf("%w: vcluster release was %s (%s); removed it to install again", ErrReinstalling, rel.Status, rel.Description)
	}

	objs := releaseObjects(ns)
	var missing []string
	for _, obj := range objs {
		if err := t.Client.Get(ctx, client.ObjectKeyFromObject(obj), obj); apierrors.IsNotFound(err) {
			kind := "service"
			if _, ok := obj.(*appsv1.StatefulSet); ok {
				kind = "statefulset"
			}
			missing = append(missing, kind+"/"+obj.GetName())
		} else if err != nil {
			return targets.State{}, err
		}
	}
	if len(missing) > 0 {
		if err := t.Helm.Repair(ctx, ns, ReleaseName); err != nil {
			return targets.State{}, fmt.Errorf("re-apply vcluster release to recreate %s: %w", strings.Join(missing, ", "), err)
		}
		msg := fmt.Sprintf("re-applied the vcluster release in namespace %s to recreate %s", ns, strings.Join(missing, ", "))
		if inst.Status.Target.ServiceUID != "" && slices.Contains(missing, "service/"+ReleaseName) {
			// The owner Service is new: start the resync in the same round (#466).
			svc := objs[1]
			if err := t.Client.Get(ctx, client.ObjectKeyFromObject(svc), svc); err != nil {
				return targets.State{}, err
			}
			return t.resync(ctx, namespace, string(svc.GetUID()), ReasonResyncing, msg+"; restarted the vcluster control plane to resync")
		}
		return targets.State{Reason: "Repairing", Message: msg}, nil
	}
	sts := objs[0].(*appsv1.StatefulSet)
	uid := string(objs[1].GetUID())
	if hostResync && uid != "" {
		// The vCluster is new, so there is nothing to restart: its syncer writes the kubeconfig
		// Secret when it first starts. The resync goes on under its Service's uid, like one
		// after an owner-Service delete.
		return targets.State{Reason: ReasonResyncing, ResyncStarted: uid,
			Message: fmt.Sprintf("resyncing: vcluster created again in host namespace %s (service uid %s); the platform is installed again once it answers", ns, uid)}, nil
	}
	// vCluster owns every object it syncs into the host namespace through service/vcluster
	// (#466). A replaced Service means they were garbage-collected, and the syncer only
	// regenerates its kubeconfig Secret when it starts: restart it, then reinstall the platform.
	recorded := inst.Status.Target.ServiceUID
	resyncing := uid != "" && inst.Status.Target.ResyncServiceUID == uid
	if markUID, _, ok := restartMark(namespace); ok && markUID == inst.Status.Target.ResyncServiceUID {
		// The status records the resync the mark answers, and guards it from here (#503).
		if err := t.clearRestartMark(ctx, namespace); err != nil {
			return targets.State{}, err
		}
	}
	if recorded != "" && uid != recorded && !resyncing {
		return t.resync(ctx, namespace, uid, ReasonResyncing,
			fmt.Sprintf("service %s/%s was replaced (uid %s, was %s), which garbage-collected the objects vcluster synced; restarted the vcluster control plane to resync", ns, ReleaseName, uid, recorded))
	}
	if sts.Status.ReadyReplicas < 1 {
		if resyncing {
			return t.resyncWaiting(inst, "vcluster control plane not ready"), nil
		}
		return targets.State{Reason: "ControlPlanePending", Message: "vcluster control plane not ready"}, nil
	}

	var secret corev1.Secret
	if err := t.Client.Get(ctx, types.NamespacedName{Namespace: ns, Name: "vc-" + ReleaseName}, &secret); apierrors.IsNotFound(err) {
		switch {
		case resyncing:
			return t.resyncWaiting(inst, fmt.Sprintf("waiting for vcluster to recreate its kubeconfig Secret %s/vc-%s", ns, ReleaseName)), nil
		case recorded != "" || inst.Status.InstalledVersion != "":
			// It existed once: the syncer won't create it again without a restart.
			return t.resync(ctx, namespace, uid, ReasonKubeconfigMissing,
				fmt.Sprintf("vcluster kubeconfig Secret %s/vc-%s is missing; resync pending", ns, ReleaseName))
		default:
			return targets.State{Reason: "KubeconfigPending", Message: "vcluster kubeconfig Secret not created yet"}, nil
		}
	} else if err != nil {
		return targets.State{}, err
	}
	// The restarted syncer wrote its Secret: whatever restart the mark records has taken effect,
	// and a later loss is a new one (#503). Clear only once the pod running is not the one the mark
	// names, for this Service, so a Secret that predates the restart never drops the guard.
	if markUID, markPod, ok := restartMark(namespace); ok && markUID == uid {
		var pod corev1.Pod
		err := t.Client.Get(ctx, types.NamespacedName{Namespace: ns, Name: ReleaseName + "-0"}, &pod)
		if client.IgnoreNotFound(err) != nil {
			return targets.State{}, fmt.Errorf("look up %s/%s-0: %w", ns, ReleaseName, err)
		}
		if err == nil && string(pod.UID) != markPod {
			if err := t.clearRestartMark(ctx, namespace); err != nil {
				return targets.State{}, err
			}
		}
	} else if ok {
		// A mark for a Service that is gone: it guards nothing.
		if err := t.clearRestartMark(ctx, namespace); err != nil {
			return targets.State{}, err
		}
	}
	raw := secret.Data["config"]
	if len(raw) == 0 {
		return targets.State{Reason: "KubeconfigPending", Message: "vcluster kubeconfig Secret has no config key"}, nil
	}
	address := fmt.Sprintf("%s.%s.svc:443", ReleaseName, ns)
	server := "https://" + address
	kubeconfig, err := withServer(raw, server)
	if err != nil {
		return targets.State{}, fmt.Errorf("vcluster kubeconfig: %w", err)
	}
	ready := targets.State{Ready: true, Kubeconfig: kubeconfig, Server: server, ServiceUID: uid, Resynced: resyncing}
	checked = true
	if err := t.dial(ctx, address); err != nil {
		if resyncing {
			return t.resyncWaiting(inst, fmt.Sprintf("waiting for the vcluster API %s: %v", server, err)), nil
		}
		n := t.countFailure(ns)
		if n < UnreachableAfter {
			log.FromContext(ctx).Info("vcluster API check failed", "endpoint", server, "failures", n, "error", err.Error())
			return ready, nil
		}
		return targets.State{Reason: "TargetUnreachable", Message: fmt.Sprintf("vcluster API %s (service %s/%s) is unreachable (%d consecutive checks): %v", server, ns, ReleaseName, n, err)}, nil
	}
	t.resetFailures(ns)
	return ready, nil
}

// Reasons the target reports while it resyncs an instance whose synced objects were lost (#466).
const (
	// ReasonResyncing: the control plane was restarted and the platform is reinstalled once it
	// answers.
	ReasonResyncing = "Resyncing"
	// ReasonKubeconfigMissing: the kubeconfig Secret existed and was deleted; a restart
	// recreates it.
	ReasonKubeconfigMissing = "KubeconfigMissing"
	// ReasonHostNamespaceDeleted: the host namespace of an instance that had a vCluster is
	// terminating or gone, and with it the vCluster and its data (#490). The resync creates the
	// namespace and the vCluster again once it is gone, and the platform is installed again.
	ReasonHostNamespaceDeleted = "HostNamespaceDeleted"
	// ReasonHostNamespaceTerminating: the host namespace of an instance that never had a
	// vCluster is terminating; it is created again once it is gone.
	ReasonHostNamespaceTerminating = "HostNamespaceTerminating"
)

// ResyncHostNamespace is the status.target.resyncServiceUID a resync after a host-namespace
// delete starts with (#490). The vCluster that replaces the lost one has no Service yet; once it
// has, the resync goes on under that Service's uid.
const ResyncHostNamespace = "host-namespace-deleted"

// hadTarget reports whether the instance had a vCluster: one that answered, or a platform
// installed on one.
func hadTarget(inst *v1alpha1.PlatformInstance) bool {
	s := inst.Status
	return s.Target.ServiceUID != "" || s.InstalledVersion != "" || s.KubeconfigSecretRef != nil
}

// resyncWaiting reports a resync waiting at stage; past ResyncTimeout it is TargetUnreachable.
func (t *Target) resyncWaiting(inst *v1alpha1.PlatformInstance, stage string) targets.State {
	started := inst.Status.Target.ResyncStarted
	if t.ResyncTimeout > 0 && started != nil {
		now := time.Now
		if t.Now != nil {
			now = t.Now
		}
		if since := now().Sub(started.Time); since > t.ResyncTimeout {
			return targets.State{Reason: "TargetUnreachable", Message: fmt.Sprintf("resync started %s ago is stuck: %s", since.Round(time.Second), stage)}
		}
	}
	return targets.State{Reason: ReasonResyncing, Message: "resyncing: " + stage}
}

// RestartAnnotation on a host namespace records the vCluster pod restart a resync started:
// "<service uid>/<uid of the pod deleted>" (#503). The controller records the resync in the
// instance status after Ensure returns; when that write fails, the next round sees no resync,
// and the mark keeps it from deleting the restarted pod a second time. It lives on the host
// namespace, which the operator owns: the pod it describes is replaced by the restart, and a
// namespace created again after a delete (#490) starts without it.
const RestartAnnotation = "platform.di-framework.dev/resync-restart"

// restartMark returns the owner Service uid and deleted pod uid the namespace's RestartAnnotation
// records.
func restartMark(namespace *corev1.Namespace) (serviceUID, podUID string, ok bool) {
	v, ok := namespace.Annotations[RestartAnnotation]
	if !ok {
		return "", "", false
	}
	serviceUID, podUID, _ = strings.Cut(v, "/")
	return serviceUID, podUID, true
}

// setRestartMark records on the host namespace that the pod podUID is restarted for the resync
// of serviceUID.
func (t *Target) setRestartMark(ctx context.Context, namespace *corev1.Namespace, serviceUID, podUID string) error {
	base := namespace.DeepCopy()
	if namespace.Annotations == nil {
		namespace.Annotations = map[string]string{}
	}
	namespace.Annotations[RestartAnnotation] = serviceUID + "/" + podUID
	if err := t.Client.Patch(ctx, namespace, client.MergeFrom(base)); err != nil {
		return fmt.Errorf("record the vcluster restart on namespace %s: %w", namespace.Name, err)
	}
	return nil
}

// clearRestartMark removes the namespace's RestartAnnotation, if it has one.
func (t *Target) clearRestartMark(ctx context.Context, namespace *corev1.Namespace) error {
	if _, _, ok := restartMark(namespace); !ok {
		return nil
	}
	base := namespace.DeepCopy()
	delete(namespace.Annotations, RestartAnnotation)
	if err := t.Client.Patch(ctx, namespace, client.MergeFrom(base)); err != nil {
		return fmt.Errorf("clear the vcluster restart mark on namespace %s: %w", namespace.Name, err)
	}
	return nil
}

// resync deletes the vCluster pod, which its StatefulSet recreates. The restarted syncer
// writes its kubeconfig Secret again and syncs the virtual objects that still exist back to the
// host namespace. The restart is recorded on the host namespace first (RestartAnnotation), so a
// resync the controller failed to record restarts the pod once: a later round that finds the
// mark for uid and a pod other than the one it deleted (or none yet) reports the resync again
// without a second delete (#503).
func (t *Target) resync(ctx context.Context, namespace *corev1.Namespace, uid, reason, msg string) (targets.State, error) {
	ns := namespace.Name
	state := targets.State{Reason: reason, Message: msg, ResyncStarted: uid}
	pod := &corev1.Pod{}
	key := types.NamespacedName{Namespace: ns, Name: ReleaseName + "-0"}
	err := t.Client.Get(ctx, key, pod)
	if client.IgnoreNotFound(err) != nil {
		return targets.State{}, fmt.Errorf("look up %s to resync: %w", key, err)
	}
	podGone := err != nil
	if markUID, markPod, ok := restartMark(namespace); ok && markUID == uid && (podGone || string(pod.UID) != markPod) {
		log.FromContext(ctx).Info("vcluster already restarted for this resync", "namespace", ns, "reason", reason, "serviceUID", uid)
		return state, nil
	}
	if podGone {
		// Nothing to delete: the StatefulSet is creating the pod, which starts a new syncer.
		if err := t.setRestartMark(ctx, namespace, uid, ""); err != nil {
			return targets.State{}, err
		}
		log.FromContext(ctx).Info("resyncing vcluster", "namespace", ns, "reason", reason)
		return state, nil
	}
	if err := t.setRestartMark(ctx, namespace, uid, string(pod.UID)); err != nil {
		return targets.State{}, err
	}
	// Delete only the pod the mark names: a newer one is already the restart.
	err = t.Client.Delete(ctx, pod, client.Preconditions{UID: &pod.UID})
	if client.IgnoreNotFound(err) != nil && !apierrors.IsConflict(err) {
		return targets.State{}, fmt.Errorf("restart %s/%s to resync: %w", ns, pod.Name, err)
	}
	log.FromContext(ctx).Info("resyncing vcluster", "namespace", ns, "reason", reason)
	return state, nil
}

// UnreachableAfter is how many consecutive failed API checks report the target unreachable.
const UnreachableAfter = 3

func (t *Target) countFailure(ns string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.failures == nil {
		t.failures = map[string]int{}
	}
	t.failures[ns]++
	return t.failures[ns]
}

func (t *Target) resetFailures(ns string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.failures, ns)
}

func (t *Target) dial(ctx context.Context, address string) error {
	if t.Dial != nil {
		return t.Dial(ctx, address)
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", address)
	if err != nil {
		return err
	}
	return conn.Close()
}

func (t *Target) values(ctx context.Context, inst *v1alpha1.PlatformInstance) (map[string]any, error) {
	if t.Values != nil {
		return t.Values(ctx, inst)
	}
	key := t.HostDNS
	if key.Name == "" {
		key = types.NamespacedName{Namespace: "kube-system", Name: "kube-dns"}
	}
	var svc corev1.Service
	if err := t.Client.Get(ctx, key, &svc); err != nil {
		return nil, fmt.Errorf("host DNS Service %s: %w", key, err)
	}
	return InstanceValues(svc.Spec.ClusterIP, HostNamespace(inst))
}

// claimNamespace creates the host namespace annotated with its owner, or checks that an existing
// one belongs to inst, and returns it. The bool (stop) is set, with the state to report and no
// namespace, while the namespace of an instance that had a vCluster is terminating or gone
// (#490): nothing is created in a terminating namespace, and a deleted one is created again only
// once the resync is recorded.
func (t *Target) claimNamespace(ctx context.Context, inst *v1alpha1.PlatformInstance, ns string) (*corev1.Namespace, targets.State, bool, error) {
	namespace := &corev1.Namespace{}
	err := t.Client.Get(ctx, types.NamespacedName{Name: ns}, namespace)
	if err != nil && !apierrors.IsNotFound(err) {
		return nil, targets.State{}, false, err
	}
	gone := err != nil
	if !gone {
		if err := checkOwner(inst, namespace); err != nil {
			return nil, targets.State{}, false, err
		}
	}
	if gone || namespace.DeletionTimestamp != nil {
		if st, stop := t.hostNamespaceLost(inst, ns, gone); stop {
			return nil, st, true, nil
		}
	}
	if gone {
		namespace = &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
			Name:        ns,
			Labels:      map[string]string{"app.kubernetes.io/managed-by": "platform-operator", HostNamespaceLabel: "true"},
			Annotations: map[string]string{OwnerAnnotation: owner(inst)},
		}}
		err = t.Client.Create(ctx, namespace)
		if err == nil {
			return namespace, targets.State{}, false, nil
		}
		if !apierrors.IsAlreadyExists(err) {
			return nil, targets.State{}, false, err
		}
		// Someone created it between the read and the create; it must still be ours.
		if err := t.Client.Get(ctx, types.NamespacedName{Name: ns}, namespace); err != nil {
			return nil, targets.State{}, false, err
		}
		if err := checkOwner(inst, namespace); err != nil {
			return nil, targets.State{}, false, err
		}
	}
	if namespace.Labels[HostNamespaceLabel] == "true" {
		return namespace, targets.State{}, false, nil
	}
	// A namespace created before the label existed: the admission policy covers labelled ones.
	base := namespace.DeepCopy()
	if namespace.Labels == nil {
		namespace.Labels = map[string]string{}
	}
	namespace.Labels[HostNamespaceLabel] = "true"
	if err := t.Client.Patch(ctx, namespace, client.MergeFrom(base)); err != nil {
		return nil, targets.State{}, false, err
	}
	return namespace, targets.State{}, false, nil
}

// hostNamespaceLost decides what a terminating (gone false) or deleted (gone true) host namespace
// means. For an instance that had a vCluster it starts a resync, like an owner-Service delete
// (#490): the vCluster, its data and its CA are gone, so the controller drops the install state
// that refers to them (TargetLost) and installs the platform again on the vCluster created in its
// place. stop is false when the namespace is gone and may be created now.
func (t *Target) hostNamespaceLost(inst *v1alpha1.PlatformInstance, ns string, gone bool) (targets.State, bool) {
	what := "is terminating"
	if gone {
		what = "was deleted"
	}
	if hadTarget(inst) && inst.Status.Target.ResyncServiceUID != ResyncHostNamespace {
		return targets.State{Reason: ReasonHostNamespaceDeleted, ResyncStarted: ResyncHostNamespace, TargetLost: true,
			Message: fmt.Sprintf("host namespace %s %s, with the vcluster and its data; resyncing: the namespace and the vcluster are created again once it is gone, then the platform is installed again", ns, what)}, true
	}
	if gone {
		return targets.State{}, false
	}
	stage := fmt.Sprintf("host namespace %s is terminating; it is created again once it is gone", ns)
	if inst.Status.Target.ResyncServiceUID == ResyncHostNamespace {
		return t.resyncWaiting(inst, stage), true
	}
	return targets.State{Reason: ReasonHostNamespaceTerminating, Message: stage}, true
}

func owner(inst *v1alpha1.PlatformInstance) string { return inst.Namespace + "/" + inst.Name }

func checkOwner(inst *v1alpha1.PlatformInstance, namespace *corev1.Namespace) error {
	if got := namespace.Annotations[OwnerAnnotation]; got != owner(inst) {
		return fmt.Errorf("host namespace %s is not this instance's (%s=%q)", namespace.Name, OwnerAnnotation, got)
	}
	return nil
}

// Delete uninstalls the release and deletes the host namespace, which removes the vCluster's
// data volume. Done is true once the namespace is gone. A namespace that isn't this instance's
// (created by hand at the same name) is left alone and counts as done: there is nothing of the
// instance's to delete, and refusing would hold the finalizer forever.
func (t *Target) Delete(ctx context.Context, inst *v1alpha1.PlatformInstance) (bool, error) {
	ns := HostNamespace(inst)
	t.resetFailures(ns)
	var namespace corev1.Namespace
	if err := t.Client.Get(ctx, types.NamespacedName{Name: ns}, &namespace); apierrors.IsNotFound(err) {
		return true, nil
	} else if err != nil {
		return false, err
	}
	if err := checkOwner(inst, &namespace); err != nil {
		log.FromContext(ctx).Info("leaving a host namespace this instance doesn't own", "reason", err.Error())
		return true, nil
	}
	if namespace.DeletionTimestamp == nil {
		if err := t.Helm.Uninstall(ctx, ns, ReleaseName); err != nil {
			return false, fmt.Errorf("uninstall vcluster: %w", err)
		}
		if err := t.Client.Delete(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}); client.IgnoreNotFound(err) != nil {
			return false, err
		}
	}
	return false, nil
}

// HostNamespace is the instance's host namespace: pi-<namespace>-<name>, with dots made dashes
// and cut to fit 63 characters, then a hash of <namespace>/<name>. The hash keeps instances
// apart whose names join to the same string (team-a/one and team/a-one).
func HostNamespace(inst *v1alpha1.PlatformInstance) string {
	sum := sha256.Sum256([]byte(owner(inst)))
	suffix := "-" + hex.EncodeToString(sum[:])[:10]
	name := strings.ReplaceAll("pi-"+inst.Namespace+"-"+inst.Name, ".", "-")
	if max := 63 - len(suffix); len(name) > max {
		name = strings.TrimRight(name[:max], "-")
	}
	return name + suffix
}

// withServer points every cluster in a kubeconfig at server. vCluster's Secret addresses
// localhost:8443, which only works from inside its own pod.
func withServer(raw []byte, server string) ([]byte, error) {
	cfg, err := clientcmd.Load(raw)
	if err != nil {
		return nil, err
	}
	if len(cfg.Clusters) == 0 {
		return nil, fmt.Errorf("no clusters")
	}
	for _, c := range cfg.Clusters {
		c.Server = server
	}
	out, err := clientcmd.Write(*cfg)
	if err != nil {
		return nil, err
	}
	return bytes.TrimSpace(out), nil
}
