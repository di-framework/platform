// Package controller reconciles PlatformInstances: target cluster, then platform install, then
// periodic repair, with a finalizer that applies the deletion policy.
package controller

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/recorder"

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
	// APIReader reads the instance past the cache before a resync reinstall (#472) and while the
	// cache lags a status write the next round must see (#481, #487); nil skips those checks.
	APIReader APIReader
	Target    targets.Target
	Installer installer.Installer
	// Recorder emits Events on PlatformInstances; nil emits none.
	Recorder recorder.EventRecorder
	Plan     plan.Config
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

	// writes are the status writes the next rounds must see (see fresh).
	writes expectedWrites
}

// APIReader reads objects from the API server; client.Reader satisfies it.
type APIReader interface {
	Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error
}

// +kubebuilder:rbac:groups=platform.di-framework.dev,resources=platforminstances,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=platform.di-framework.dev,resources=platforminstances/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=platform.di-framework.dev,resources=platforminstances/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch;create;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=events.k8s.io,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;create;update
// +kubebuilder:rbac:groups=admissionregistration.k8s.io,resources=validatingadmissionpolicies;validatingadmissionpolicybindings,verbs=get;create;update
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;create;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=list;delete
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
		if apierrors.IsNotFound(err) {
			r.writes.forget(req.NamespacedName)
		}
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if err := r.fresh(ctx, &inst); err != nil {
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
	if root := inst.Spec.Platform.StorageRoot; root != "" && inst.Status.InstalledVersion == "" &&
		customRootOverlapsCleanup(root, r.StorageRootBase) {
		// Deleting an instance removes <storage-root-base>/<namespace>/<name>, so a custom root
		// whose data could sit there could lose it to another instance's cleanup. Checked only
		// before the first install: an installed instance never flips to Failed from this.
		return r.fail(ctx, &inst, v1alpha1.ConditionInstalled, v1alpha1.ReasonInvalidStorageRoot,
			fmt.Sprintf("spec.platform.storageRoot %q overlaps --storage-root-base %q, where the operator removes deleted instances' data; choose a path outside it",
				root, r.StorageRootBase), nil)
	}
	if !obs.HasFinalizer {
		// The patch is a watch event, so the next step runs without a requeue. A merge patch
		// carries only the finalizer: an Update would send the whole object and write the
		// zero-valued spec fields (platform: {gateway: {}}) the user never set.
		return ctrl.Result{}, r.patchFinalizers(ctx, &inst, controllerutil.AddFinalizer)
	}

	st, err := r.Target.Ensure(ctx, &inst)
	if err != nil {
		// A target that reports what it did with its error (a rolled-back repair) keeps that
		// reason in the condition; the error makes controller-runtime back off.
		reason, msg := "TargetError", err.Error()
		if st.Reason != "" {
			reason, msg = st.Reason, st.Message
		}
		return r.fail(ctx, &inst, v1alpha1.ConditionTargetReady, reason, msg, err)
	}
	if err := r.reportProtection(ctx, &inst, st.Unprotected); err != nil {
		return ctrl.Result{}, err
	}
	obs.TargetReady = st.Ready
	if st.Ready {
		if err := r.writeKubeconfig(ctx, &inst, st.Kubeconfig); err != nil {
			return ctrl.Result{}, err
		}
	}

	if st.Ready && st.Resynced {
		live, err := r.resyncDone(ctx, &inst, st.ServiceUID)
		if err != nil {
			return ctrl.Result{}, err
		}
		if live != nil {
			// The cache still had the resync marker the reinstall cleared (#472): the resync is
			// done, so this round follows the live instance without reinstalling again.
			inst, st.Resynced = *live, false
			obs = r.observe(&inst)
			obs.TargetReady = st.Ready
		}
	}
	d := plan.Next(obs, r.Plan)
	if st.Ready && st.Resynced && (d.Action == plan.Wait || d.Action == plan.Repair) {
		// The target was resynced after its synced objects were lost (#466): run the install
		// now instead of at the next repair, so the platform's Secrets and ConfigMaps come back.
		// The reason is Resync whatever the plan said, a due repair included (#472).
		d = plan.Decision{Action: plan.Repair, Reason: ReasonResync}
	}
	log.FromContext(ctx).V(1).Info("decision", "action", d.Action, "reason", d.Reason)
	switch d.Action {
	case plan.EnsureTarget:
		// The reference stays while the Secret exists: it still holds the instance's kubeconfig.
		var secret corev1.Secret
		err := r.Get(ctx, client.ObjectKey{Namespace: inst.Namespace, Name: kubeconfigSecretName(&inst)}, &secret)
		if client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, err
		}
		keepRef := err == nil
		err = r.patchStatus(ctx, &inst, func(s *v1alpha1.PlatformInstanceStatus) {
			s.Phase = v1alpha1.PhaseProvisioning
			if !keepRef {
				s.KubeconfigSecretRef = nil
			}
			if st.ResyncStarted != "" {
				now := metav1.NewTime(r.now())
				s.Target.ResyncServiceUID = st.ResyncStarted
				s.Target.ResyncStarted = &now
			}
			setCondition(s, inst.Generation, v1alpha1.ConditionTargetReady, metav1.ConditionFalse, st.Reason, st.Message)
			setCondition(s, inst.Generation, v1alpha1.ConditionReady, metav1.ConditionFalse, "TargetPending", "waiting for the target cluster")
		})
		if err == nil && st.ResyncStarted != "" {
			// The target restarted its control plane for this uid. A round that read the
			// instance without this marker would restart it again (#481).
			r.expectWrite(&inst)
		}
		return ctrl.Result{RequeueAfter: d.RequeueAfter}, err
	case plan.Install, plan.Repair:
		return r.install(ctx, &inst, st, d)
	default: // plan.Wait
		return ctrl.Result{RequeueAfter: d.RequeueAfter}, r.markReady(ctx, &inst, st)
	}
}

// resyncDone re-reads the instance past the cache and returns it when its resync marker for uid
// is gone, which a finished reinstall clears; nil means the resync is still pending or there is
// no APIReader. A cache that lags the reinstall's status patch would otherwise run the reinstall
// a second time (#472).
func (r *Reconciler) resyncDone(ctx context.Context, inst *v1alpha1.PlatformInstance, uid string) (*v1alpha1.PlatformInstance, error) {
	if r.APIReader == nil {
		return nil, nil
	}
	var live v1alpha1.PlatformInstance
	if err := r.APIReader.Get(ctx, client.ObjectKeyFromObject(inst), &live); err != nil {
		return nil, err
	}
	if live.Status.Target.ResyncServiceUID == uid {
		return nil, nil
	}
	return &live, nil
}

// markReady puts back the Ready status when the instance is installed and its target answers
// again after a transient failure, which leaves phase and conditions behind until the next
// repair otherwise.
func (r *Reconciler) markReady(ctx context.Context, inst *v1alpha1.PlatformInstance, st targets.State) error {
	s := inst.Status
	if s.Phase == v1alpha1.PhaseReady && s.KubeconfigSecretRef != nil && s.Target.ServiceUID == st.ServiceUID &&
		meta.IsStatusConditionTrue(s.Conditions, v1alpha1.ConditionTargetReady) &&
		meta.IsStatusConditionTrue(s.Conditions, v1alpha1.ConditionReady) {
		return nil
	}
	return r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
		s.Phase = v1alpha1.PhaseReady
		s.KubeconfigSecretRef = &v1alpha1.SecretReference{Name: kubeconfigSecretName(inst)}
		// An instance installed before the uid was recorded gets it here.
		s.Target.ServiceUID = st.ServiceUID
		setCondition(s, inst.Generation, v1alpha1.ConditionTargetReady, metav1.ConditionTrue, "Ready", "target cluster answers")
		setCondition(s, inst.Generation, v1alpha1.ConditionReady, metav1.ConditionTrue, "Ready", "instance is ready")
	})
}

// ReasonAdmissionPolicyUnavailable (on OwnerServiceProtected) reports an API server without
// admission policies, so service/vcluster can be deleted (#466).
const ReasonAdmissionPolicyUnavailable = "AdmissionPolicyUnavailable"

// reportProtection sets OwnerServiceProtected when it changes, with a Warning Event when the
// target couldn't protect its owner Service.
func (r *Reconciler) reportProtection(ctx context.Context, inst *v1alpha1.PlatformInstance, unprotected string) error {
	status, reason, msg := metav1.ConditionTrue, "AdmissionPolicyInstalled", "an admission policy denies deleting service/vcluster"
	if unprotected != "" {
		status, reason, msg = metav1.ConditionFalse, ReasonAdmissionPolicyUnavailable, unprotected
	}
	if c := meta.FindStatusCondition(inst.Status.Conditions, v1alpha1.ConditionOwnerServiceProtected); c != nil && c.Status == status && c.Reason == reason {
		return nil
	}
	if unprotected != "" {
		log.FromContext(ctx).Info("owner Service unprotected", "reason", unprotected)
		if r.Recorder != nil {
			r.Recorder.Eventf(inst, nil, corev1.EventTypeWarning, ReasonAdmissionPolicyUnavailable, "Protect", "%s", unprotected)
		}
	}
	return r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
		setCondition(s, inst.Generation, v1alpha1.ConditionOwnerServiceProtected, status, reason, msg)
	})
}

// ReasonResync is the Installed reason of the install that follows a target resync (#466).
const ReasonResync = "Resync"

func (r *Reconciler) install(ctx context.Context, inst *v1alpha1.PlatformInstance, st targets.State, d plan.Decision) (ctrl.Result, error) {
	req := r.request(inst, st)
	image, err := r.tenancy(ctx, inst, &req)
	if err != nil {
		return r.failConfig(ctx, inst, v1alpha1.ReasonTenantAuthSecret, err.Error(), err)
	}
	if err := r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
		if d.Action == plan.Install {
			s.Phase = v1alpha1.PhaseInstalling
		}
		s.KubeconfigSecretRef = &v1alpha1.SecretReference{Name: kubeconfigSecretName(inst)}
		if st.Resynced {
			// Ready again only once the platform is reinstalled on the resynced target.
			setCondition(s, inst.Generation, v1alpha1.ConditionTargetReady, metav1.ConditionFalse, "Resyncing",
				"vcluster resynced; reinstalling the platform to recreate the objects it lost")
		} else {
			setCondition(s, inst.Generation, v1alpha1.ConditionTargetReady, metav1.ConditionTrue, "Ready", "target cluster answers")
		}
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
	refresh := d.Action == plan.Repair || d.Reason == plan.ReasonRetry || st.Resynced
	res, err := r.Installer.Install(installCtx, req, installer.Options{Refresh: refresh, ReinstallRelease: st.Resynced})
	if errors.Is(err, installer.ErrHostImageNotApproved) {
		return r.failConfig(ctx, inst, v1alpha1.ReasonTenantHostImageUnsupported,
			fmt.Sprintf("%v. spec.platform.tenantHostImage is empty, so the operator's default would be used: set spec.platform.tenantHostImage, or a spec.version that approves it", err), err)
	}
	if err != nil {
		return r.fail(ctx, inst, v1alpha1.ConditionInstalled, "InstallFailed",
			fmt.Sprintf("%s of %s failed: %v", d.Reason, inst.Spec.Version, err), err)
	}
	now := metav1.NewTime(r.now())
	err = r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
		s.Phase = v1alpha1.PhaseReady
		s.ObservedGeneration = inst.Generation
		s.InstalledVersion = inst.Spec.Version
		s.LastRepair = &now
		s.Endpoints = v1alpha1.Endpoints{Kubernetes: res.KubernetesEndpoint, HTTP: res.HTTPEndpoint}
		s.Applied = applied(inst, image)
		s.Target = v1alpha1.TargetStatus{ServiceUID: st.ServiceUID}
		setCondition(s, inst.Generation, v1alpha1.ConditionTargetReady, metav1.ConditionTrue, "Ready", "target cluster answers")
		setCondition(s, inst.Generation, v1alpha1.ConditionInstalled, metav1.ConditionTrue, d.Reason, "platform "+inst.Spec.Version+" installed")
		setCondition(s, inst.Generation, v1alpha1.ConditionConfigApplied, metav1.ConditionTrue, "Applied",
			fmt.Sprintf("generation %d: %d tenant(s), %d user(s), tenantAuth issuer %q", s.Applied.Generation, s.Applied.Tenants, s.Applied.Users, s.Applied.TenantAuthIssuer))
		setCondition(s, inst.Generation, v1alpha1.ConditionReady, metav1.ConditionTrue, "Ready", "instance is ready")
	})
	if err == nil {
		// The status patches at the start of the install queued another round, which runs as
		// soon as this one returns and can read the instance from before this patch: no
		// Installed condition or the old lastRepair, so it would install or repair again at
		// once (#487).
		r.expectWrite(inst)
	}
	return ctrl.Result{RequeueAfter: r.Plan.RepairInterval}, err
}

// failConfig reports a config the install can't apply: ConfigApplied and Installed False with
// reason, then fails like fail.
func (r *Reconciler) failConfig(ctx context.Context, inst *v1alpha1.PlatformInstance, reason, msg string, cause error) (ctrl.Result, error) {
	if err := r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
		setCondition(s, inst.Generation, v1alpha1.ConditionConfigApplied, metav1.ConditionFalse, reason, msg)
	}); err != nil {
		return ctrl.Result{}, err
	}
	return r.fail(ctx, inst, v1alpha1.ConditionInstalled, reason, msg, cause)
}

// reconcileDelete applies the deletion policy, then releases the finalizer. Delete removes the
// target, then the install state, then the default storageRoot on the node.
func (r *Reconciler) reconcileDelete(ctx context.Context, inst *v1alpha1.PlatformInstance, obs plan.Observation) (ctrl.Result, error) {
	d := plan.Next(obs, r.Plan)
	switch d.Action {
	case plan.Release:
		// Every way out (Retain, skip, a custom root, a finished cleanup) first removes any
		// cleanup Job and pod of this name, so no rm -rf outlives the instance and reaches a
		// recreated one.
		left, err := r.sweepCleanup(ctx, inst, false)
		if err != nil {
			return ctrl.Result{}, err
		}
		if len(left) > 0 {
			return ctrl.Result{RequeueAfter: r.Plan.TargetPoll}, r.patchStatus(ctx, inst, func(s *v1alpha1.PlatformInstanceStatus) {
				setCondition(s, inst.Generation, v1alpha1.ConditionReady, metav1.ConditionFalse, "WaitingForStorageCleanup",
					fmt.Sprintf("waiting for storage cleanup %s to terminate before releasing (see the README to force it)", strings.Join(left, ", ")))
			})
		}
		return ctrl.Result{}, r.patchFinalizers(ctx, inst, controllerutil.RemoveFinalizer)
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
		done, retry, err := r.cleanStorage(ctx, inst)
		if err != nil {
			res, ferr := r.fail(ctx, inst, v1alpha1.ConditionInstalled, v1alpha1.ReasonStorageCleanupFailed,
				fmt.Sprintf("removing storageRoot %s failed (annotate %s=true to skip): %v",
					r.storageRoot(inst), v1alpha1.AnnotationSkipStorageCleanup, err), err)
			if errors.Is(ferr, ErrStorageCleanupFailed) {
				// A failed Job is counted on the instance and retried after its own exponential
				// backoff; controller-runtime's resets on every RequeueAfter.
				return ctrl.Result{RequeueAfter: retry}, nil
			}
			return res, ferr
		}
		if !done {
			if retry == 0 {
				retry = d.RequeueAfter
			}
			return ctrl.Result{RequeueAfter: retry}, nil
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
		StorageCleaned:     inst.UID != "" && inst.Annotations[AnnotationStorageCleaned] == string(inst.UID),
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

// patchFinalizers adds or removes the finalizer with a merge patch that carries only the
// finalizers (and the resourceVersion, so a concurrent change conflicts).
func (r *Reconciler) patchFinalizers(ctx context.Context, inst *v1alpha1.PlatformInstance, change func(client.Object, string) bool) error {
	base := inst.DeepCopy()
	change(inst, Finalizer)
	if err := r.Patch(ctx, inst, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{})); err != nil {
		return err
	}
	r.writes.wrote(inst)
	return nil
}

func (r *Reconciler) patchStatus(ctx context.Context, inst *v1alpha1.PlatformInstance, mutate func(*v1alpha1.PlatformInstanceStatus)) error {
	base := inst.DeepCopy()
	mutate(&inst.Status)
	if err := r.Status().Patch(ctx, inst, client.MergeFrom(base)); err != nil {
		return err
	}
	r.writes.wrote(inst)
	return nil
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
