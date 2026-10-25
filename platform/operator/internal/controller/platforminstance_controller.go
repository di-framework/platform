// Package controller reconciles PlatformInstances: target cluster, then platform install, then
// periodic repair, with a finalizer that applies the deletion policy.
package controller

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/installer"
	"github.com/di-framework/platform/operator/internal/plan"
	"github.com/di-framework/platform/operator/internal/targets"
)

// Finalizer holds a PlatformInstance until its deletion policy has been applied.
const Finalizer = "platform.di-framework.dev/instance"

// KubeconfigKey is the key of the instance kubeconfig in its Secret.
const KubeconfigKey = "kubeconfig"

// ManagedLabels mark the objects the operator creates. The operator's cache watches only Secrets
// that carry them.
var ManagedLabels = map[string]string{"app.kubernetes.io/managed-by": "platform-operator"}

// PlatformNamespace is the namespace the platform is installed into, inside the target.
const PlatformNamespace = "wasmcloud"

// Reconciler reconciles PlatformInstances.
//
// One install per instance at a time follows from controller-runtime, which never reconciles a
// key twice at once, and leader election, which runs one operator. The installer's stale-lock
// recovery relies on both.
type Reconciler struct {
	client.Client
	Target    targets.Target
	Installer installer.Installer
	Plan      plan.Config
	// StorageRootBase is the node directory under which each instance gets its own storageRoot
	// when spec.platform.storageRoot is empty.
	StorageRootBase string
	// CleanupNamespace is where the Job that removes a deleted instance's default storageRoot
	// runs: the operator's own namespace, since the Job mounts the node's storage root base.
	CleanupNamespace string
	// MaxConcurrent caps parallel reconciles across instances (installs are long-running).
	MaxConcurrent int
	// InstallTimeout bounds one install or repair, so a hung npm or Pulumi run frees its worker.
	// Zero means no bound.
	InstallTimeout time.Duration
	// Now is injectable for tests; nil uses time.Now.
	Now func() time.Time
}

// +kubebuilder:rbac:groups=platform.di-framework.dev,resources=platforminstances,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=platform.di-framework.dev,resources=platforminstances/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=platform.di-framework.dev,resources=platforminstances/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch;create;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;create;delete
// +kubebuilder:rbac:groups=coordination.k8s.io,resources=leases,verbs=get;list;watch;create;update;patch;delete
// The vCluster chart creates RBAC, workloads and Services in each instance namespace; Helm needs
// every permission it grants. v1alpha1 binds the operator to cluster-admin for that (see README).

// SetupWithManager registers the reconciler.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	n := r.MaxConcurrent
	if n < 1 {
		n = 1
	}
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.PlatformInstance{}).
		Owns(&corev1.Secret{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: n}).
		Complete(r)
}

// Reconcile moves one PlatformInstance a step towards its spec.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var inst v1alpha1.PlatformInstance
	if err := r.Get(ctx, req.NamespacedName, &inst); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if inst.Spec.Target.Type != v1alpha1.TargetVCluster {
		return r.fail(ctx, &inst, v1alpha1.ConditionTargetReady, "UnsupportedTarget",
			fmt.Sprintf("target type %q is not supported; use vcluster", inst.Spec.Target.Type), nil)
	}

	obs := r.observe(&inst)
	if obs.Deleting {
		return r.reconcileDelete(ctx, &inst, obs)
	}
	if !obs.HasFinalizer {
		// The update is a watch event, so the next step runs without a requeue.
		controllerutil.AddFinalizer(&inst, Finalizer)
		return ctrl.Result{}, r.Update(ctx, &inst)
	}

	st, err := r.Target.Ensure(ctx, &inst)
	if err != nil {
		return r.fail(ctx, &inst, v1alpha1.ConditionTargetReady, "TargetError", err.Error(), err)
	}
	obs.TargetReady = st.Ready
	if st.Ready {
		if err := r.writeKubeconfig(ctx, &inst, st.Kubeconfig); err != nil {
			return ctrl.Result{}, err
		}
	}

	d := plan.Next(obs, r.Plan)
	log.FromContext(ctx).V(1).Info("decision", "action", d.Action, "reason", d.Reason)
	switch d.Action {
	case plan.EnsureTarget:
		return ctrl.Result{RequeueAfter: d.RequeueAfter}, r.patchStatus(ctx, &inst, func(s *v1alpha1.PlatformInstanceStatus) {
			s.Phase = v1alpha1.PhaseProvisioning
			s.KubeconfigSecretRef = nil
			setCondition(s, inst.Generation, v1alpha1.ConditionTargetReady, metav1.ConditionFalse, st.Reason, st.Message)
			setCondition(s, inst.Generation, v1alpha1.ConditionReady, metav1.ConditionFalse, "TargetPending", "waiting for the target cluster")
		})
	case plan.Install, plan.Repair:
		return r.install(ctx, &inst, st, d)
	default: // plan.Wait
		return ctrl.Result{RequeueAfter: d.RequeueAfter}, r.markReady(ctx, &inst)
	}
}

// markReady puts back the Ready status when the instance is installed and its target answers
// again after a transient failure, which leaves phase and conditions behind until the next
// repair otherwise.
func (r *Reconciler) markReady(ctx context.Context, inst *v1alpha1.PlatformInstance) error {
	s := inst.Status
	if s.Phase == v1alpha1.PhaseReady && s.KubeconfigSecretRef != nil &&
		meta.IsStatusConditionTrue(s.Conditions, v1alpha1.ConditionTargetReady) &&
		meta.IsStatusConditionTrue(s.Conditions, v1alpha1.ConditionReady) {
		return nil
	}
	return r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
		s.Phase = v1alpha1.PhaseReady
		s.KubeconfigSecretRef = &v1alpha1.SecretReference{Name: kubeconfigSecretName(inst)}
		setCondition(s, inst.Generation, v1alpha1.ConditionTargetReady, metav1.ConditionTrue, "Ready", "target cluster answers")
		setCondition(s, inst.Generation, v1alpha1.ConditionReady, metav1.ConditionTrue, "Ready", "instance is ready")
	})
}

func (r *Reconciler) install(ctx context.Context, inst *v1alpha1.PlatformInstance, st targets.State, d plan.Decision) (ctrl.Result, error) {
	if err := r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
		if d.Action == plan.Install {
			s.Phase = v1alpha1.PhaseInstalling
		}
		s.KubeconfigSecretRef = &v1alpha1.SecretReference{Name: kubeconfigSecretName(inst)}
		setCondition(s, inst.Generation, v1alpha1.ConditionTargetReady, metav1.ConditionTrue, "Ready", "target cluster answers")
	}); err != nil {
		return ctrl.Result{}, err
	}

	installCtx := ctx
	if r.InstallTimeout > 0 {
		var cancel context.CancelFunc
		installCtx, cancel = context.WithTimeout(ctx, r.InstallTimeout)
		defer cancel()
	}
	// A repair, and a retry after a failed install, refresh first: the failed run may have left
	// resources Pulumi hasn't recorded.
	refresh := d.Action == plan.Repair || d.Reason == plan.ReasonRetry
	res, err := r.Installer.Install(installCtx, r.request(inst, st), installer.Options{Refresh: refresh})
	if err != nil {
		return r.fail(ctx, inst, v1alpha1.ConditionInstalled, "InstallFailed",
			fmt.Sprintf("%s of %s failed: %v", d.Reason, inst.Spec.Version, err), err)
	}
	now := metav1.NewTime(r.now())
	return ctrl.Result{RequeueAfter: r.Plan.RepairInterval}, r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
		s.Phase = v1alpha1.PhaseReady
		s.ObservedGeneration = inst.Generation
		s.InstalledVersion = inst.Spec.Version
		s.LastRepair = &now
		s.Endpoints = v1alpha1.Endpoints{Kubernetes: res.KubernetesEndpoint, HTTP: res.HTTPEndpoint}
		setCondition(s, inst.Generation, v1alpha1.ConditionInstalled, metav1.ConditionTrue, d.Reason, "platform "+inst.Spec.Version+" installed")
		setCondition(s, inst.Generation, v1alpha1.ConditionReady, metav1.ConditionTrue, "Ready", "instance is ready")
	})
}

// reconcileDelete applies the deletion policy, then releases the finalizer. Delete removes the
// target, then the install state, then the default storageRoot on the node.
func (r *Reconciler) reconcileDelete(ctx context.Context, inst *v1alpha1.PlatformInstance, obs plan.Observation) (ctrl.Result, error) {
	d := plan.Next(obs, r.Plan)
	switch d.Action {
	case plan.Release:
		controllerutil.RemoveFinalizer(inst, Finalizer)
		return ctrl.Result{}, r.Update(ctx, inst)
	case plan.Uninstall:
		// The vCluster target is deleted wholesale (its host namespace and data volume), which
		// removes everything the platform installed. So the target goes first and the install
		// state is dropped without a destroy: a broken or unreachable instance still deletes.
		if err := r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) { s.Phase = v1alpha1.PhaseDeleting }); err != nil {
			return ctrl.Result{}, err
		}
		done, err := r.Target.Delete(ctx, inst)
		if err != nil {
			return r.fail(ctx, inst, v1alpha1.ConditionTargetReady, "TargetDeleteFailed", err.Error(), err)
		}
		if !done {
			return ctrl.Result{RequeueAfter: r.Plan.TargetPoll}, nil
		}
		if err := r.Installer.Uninstall(ctx, r.request(inst, targets.State{}), installer.UninstallOptions{}); err != nil {
			return r.fail(ctx, inst, v1alpha1.ConditionInstalled, "UninstallFailed", err.Error(), err)
		}
		obs.UninstallDone = true
		return r.reconcileDelete(ctx, inst, obs)
	case plan.CleanStorage:
		// The target is gone, so nothing writes to the storageRoot any more.
		done, err := r.cleanStorage(ctx, inst)
		if err != nil {
			return r.fail(ctx, inst, v1alpha1.ConditionInstalled, v1alpha1.ReasonStorageCleanupFailed,
				fmt.Sprintf("removing storageRoot %s failed (annotate %s=true to skip): %v",
					r.storageRoot(inst), v1alpha1.AnnotationSkipStorageCleanup, err), err)
		}
		if !done {
			return ctrl.Result{RequeueAfter: d.RequeueAfter}, nil
		}
		obs.StorageCleaned = true
		return r.reconcileDelete(ctx, inst, obs)
	default:
		return ctrl.Result{}, nil
	}
}

func (r *Reconciler) observe(inst *v1alpha1.PlatformInstance) plan.Observation {
	installed := meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionInstalled)
	o := plan.Observation{
		Deleting:           !inst.DeletionTimestamp.IsZero(),
		HasFinalizer:       controllerutil.ContainsFinalizer(inst, Finalizer),
		Policy:             inst.Spec.DeletionPolicy,
		CustomStorageRoot:  inst.Spec.Platform.StorageRoot != "",
		SkipStorageCleanup: inst.Annotations[v1alpha1.AnnotationSkipStorageCleanup] == "true",
		Generation:         inst.Generation,
		DesiredVersion:     inst.Spec.Version,
		InstalledVersion:   inst.Status.InstalledVersion,
		Installed:          installed,
		InstallAttempted:   meta.FindStatusCondition(inst.Status.Conditions, v1alpha1.ConditionInstalled) != nil,
		Now:                r.now(),
	}
	if installed {
		o.InstalledGeneration = inst.Status.ObservedGeneration
	}
	if inst.Status.LastRepair != nil {
		o.LastRepair = inst.Status.LastRepair.Time
	}
	return o
}

// request builds the installer input. Settings are the platform's existing-entrypoint keys.
func (r *Reconciler) request(inst *v1alpha1.PlatformInstance, st targets.State) installer.Request {
	engine := inst.Spec.Platform.NetworkPolicyEngine
	if engine == "" {
		engine = "existing"
	}
	settings := map[string]any{
		"namespace":           PlatformNamespace,
		"networkPolicyEngine": string(engine),
		"storageRoot":         r.storageRoot(inst),
		"httpNodePort":        int(inst.Spec.Platform.Gateway.HTTPNodePort),
	}
	if st.Server != "" {
		settings["kubernetesEndpoint"] = st.Server
	}
	if ep := inst.Spec.Platform.Gateway.HTTPEndpoint; ep != "" {
		settings["httpEndpoint"] = ep
	}
	return installer.Request{
		ID:         inst.Namespace + "." + inst.Name,
		Version:    inst.Spec.Version,
		Kubeconfig: st.Kubeconfig,
		Settings:   settings,
	}
}

func kubeconfigSecretName(inst *v1alpha1.PlatformInstance) string { return inst.Name + "-kubeconfig" }

// writeKubeconfig stores the instance's admin kubeconfig in a Secret the PlatformInstance owns.
func (r *Reconciler) writeKubeconfig(ctx context.Context, inst *v1alpha1.PlatformInstance, kubeconfig []byte) error {
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: inst.Namespace, Name: kubeconfigSecretName(inst)}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, secret, func() error {
		if secret.Labels == nil {
			secret.Labels = map[string]string{}
		}
		for k, v := range ManagedLabels {
			secret.Labels[k] = v
		}
		secret.Type = corev1.SecretTypeOpaque
		secret.Data = map[string][]byte{KubeconfigKey: kubeconfig}
		return controllerutil.SetControllerReference(inst, secret, r.Scheme())
	})
	return err
}

// fail records a False condition with a readable reason and sets phase Failed. A non-nil cause
// is returned so controller-runtime retries with backoff.
func (r *Reconciler) fail(ctx context.Context, inst *v1alpha1.PlatformInstance, cond, reason, msg string, cause error) (ctrl.Result, error) {
	if err := r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
		if inst.DeletionTimestamp.IsZero() {
			s.Phase = v1alpha1.PhaseFailed
		}
		setCondition(s, inst.Generation, cond, metav1.ConditionFalse, reason, msg)
		setCondition(s, inst.Generation, v1alpha1.ConditionReady, metav1.ConditionFalse, reason, msg)
	}); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, cause
}

func (r *Reconciler) patchStatus(ctx context.Context, inst *v1alpha1.PlatformInstance, mutate func(*v1alpha1.PlatformInstanceStatus)) error {
	base := inst.DeepCopy()
	mutate(&inst.Status)
	return r.Status().Patch(ctx, inst, client.MergeFrom(base))
}

func setCondition(s *v1alpha1.PlatformInstanceStatus, gen int64, typ string, status metav1.ConditionStatus, reason, msg string) {
	if reason == "" {
		reason = "Unknown"
	}
	meta.SetStatusCondition(&s.Conditions, metav1.Condition{Type: typ, Status: status, Reason: reason, Message: readable(msg), ObservedGeneration: gen})
}

// MaxMessage bounds a condition message. Install errors carry the whole Pulumi output; the
// operator log keeps it, the condition keeps the start and the end, where the cause is.
const MaxMessage = 2000

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// readable strips terminal colour codes and keeps the head and tail of a long message.
func readable(msg string) string {
	msg = ansi.ReplaceAllString(msg, "")
	if len(msg) <= MaxMessage {
		return msg
	}
	const cut = " … "
	half := (MaxMessage - len(cut)) / 2
	return strings.ToValidUTF8(msg[:half], "") + cut + strings.ToValidUTF8(msg[len(msg)-half:], "")
}

func (r *Reconciler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}
