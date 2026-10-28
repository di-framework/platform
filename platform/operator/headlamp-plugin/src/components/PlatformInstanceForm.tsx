import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { dump } from 'js-yaml';
import { useMemo, useRef, useState } from 'react';
import type { Submission } from '../api';
import {
  buildPlatformInstance,
  editPatch,
  emptyForm,
  type FormField,
  type FormMode,
  type PlatformInstanceForm as FormState,
  formFromObject,
  isDisabled,
  networkPolicyEngineChoices,
  type TextFormField,
  validateForm,
} from '../mapping';
import {
  DELETION_POLICIES,
  MAX_MEMBERSHIPS,
  MAX_NAME_LENGTH,
  MAX_TENANTS,
  MAX_USERS,
  MEMBERSHIP_ROLES,
  type PlatformInstanceObject,
  PULL_POLICIES,
  TARGET_TYPES,
} from '../types';

export interface PlatformInstanceFormProps {
  open: boolean;
  mode: FormMode;
  /** The object being edited (edit mode); the edit is computed against it as it was at open. */
  existing?: PlatformInstanceObject;
  /** The namespace the create form starts with. */
  defaultNamespace?: string;
  onClose: () => void;
  /** Sends the new object (create) or the JSON Patch (edit); rejects with an Error to show. */
  submit: (submission: Submission) => Promise<unknown>;
}

const API_DEFAULT = '(API default)';

/**
 * The create and edit form. Empty fields are left out of the object, so the CRD's defaults apply
 * exactly as for a manifest; fields that can't change after creation are disabled on edit.
 */
export function PlatformInstanceFormDialog(props: PlatformInstanceFormProps) {
  const { open, mode, defaultNamespace, onClose, submit } = props;
  // Snapshot at open: later watch updates of `existing` must not move the patch's baseline, or a
  // concurrent change would be overwritten instead of detected.
  const [existing] = useState(() => (props.existing ? structuredClone(props.existing) : undefined));
  const [form, setForm] = useState<FormState>(() =>
    existing ? formFromObject(existing) : emptyForm(defaultNamespace ?? 'default'),
  );
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  // Keys for rows added in the dialog; rows read from the object are keyed by their name.
  const nextKey = useRef(0);
  const newKey = () => `new-${nextKey.current++}`;

  const storedEngine = existing?.spec?.platform?.networkPolicyEngine;
  const errors = useMemo(() => validateForm(form, mode, storedEngine), [form, mode, storedEngine]);
  const submission = useMemo<Submission>(
    () =>
      mode === 'edit' && existing
        ? {
            mode: 'edit',
            namespace: existing.metadata.namespace ?? '',
            name: existing.metadata.name,
            patch: editPatch(existing, form),
          }
        : { mode: 'create', object: buildPlatformInstance(form) },
    [form, mode, existing],
  );
  const showLabel = submission.mode === 'edit' ? 'Show patch' : 'Show YAML';

  function set<K extends FormField>(field: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [field]: value }));
    setTouched((t) => ({ ...t, [field]: true }));
  }

  /** The error at `key`, once its field (or, for a list row, its list) was touched. */
  function errorFor(field: FormField, key: string = field): string | undefined {
    return touched[field] || submitted ? errors[key] : undefined;
  }

  function setList<K extends 'tenants' | 'users'>(
    field: K,
    update: (rows: FormState[K]) => FormState[K],
  ) {
    setForm((f) => ({ ...f, [field]: update(f[field]) }));
    setTouched((t) => ({ ...t, [field]: true }));
  }

  function setUser(
    i: number,
    update: (user: FormState['users'][number]) => FormState['users'][number],
  ) {
    setList('users', (users) => users.map((u, k) => (k === i ? update(u) : u)));
  }

  /** The tenant names a membership can choose: the Tenants rows, and its own value if it's gone. */
  function tenantChoices(current: string): string[] {
    const names = [...new Set(form.tenants.map((t) => t.name.trim()).filter(Boolean))];
    return current && !names.includes(current) ? [...names, current] : names;
  }

  async function onSubmit() {
    setSubmitted(true);
    setServerError(null);
    if (Object.keys(errors).length > 0) {
      return;
    }
    setBusy(true);
    try {
      await submit(submission);
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function text(field: TextFormField, label: string, helper: string, extra: object = {}) {
    const error = errorFor(field);
    return (
      <TextField
        id={`pi-${field}`}
        label={label}
        value={form[field]}
        onChange={(e) => set(field, e.target.value as never)}
        onBlur={() => setTouched((t) => ({ ...t, [field]: true }))}
        disabled={isDisabled(field, mode) || busy}
        error={Boolean(error)}
        helperText={error ?? helper}
        fullWidth
        size="small"
        margin="dense"
        {...extra}
      />
    );
  }

  function select(field: TextFormField, label: string, options: readonly string[], helper: string) {
    const optional = field !== 'targetType';
    const error = errorFor(field);
    return (
      <TextField
        id={`pi-${field}`}
        select
        label={label}
        value={form[field]}
        onChange={(e) => set(field, e.target.value as never)}
        disabled={isDisabled(field, mode) || busy}
        error={Boolean(error)}
        helperText={error ?? helper}
        fullWidth
        size="small"
        margin="dense"
        SelectProps={{ displayEmpty: optional }}
        InputLabelProps={optional ? { shrink: true } : undefined}
      >
        {optional && (
          <MenuItem value="">
            <em>{API_DEFAULT}</em>
          </MenuItem>
        )}
        {options.map((o) => (
          <MenuItem key={o} value={o}>
            {o}
          </MenuItem>
        ))}
      </TextField>
    );
  }

  const applied = existing?.status?.applied;
  // What an empty host image field keeps: the last applied image, the platform's own default for an
  // instance installed before the operator recorded one, or the default a first install records.
  const hostImageHelp = applied
    ? applied.tenantHostImage
      ? `Empty keeps the last applied image: ${applied.tenantHostImage}.`
      : "Empty keeps the platform's own default."
    : "Empty: a new instance records the operator's pinned default host image at its first install.";
  const tenantsError = errorFor('tenants');
  const usersError = errorFor('users');

  const title =
    mode === 'create'
      ? 'Create PlatformInstance'
      : `Edit PlatformInstance ${existing?.metadata.namespace}/${existing?.metadata.name}`;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {text(
          'name',
          'Name',
          mode === 'edit'
            ? "Can't change after creation."
            : `At most ${MAX_NAME_LENGTH} characters.`,
          { required: true },
        )}
        {text(
          'namespace',
          'Namespace',
          mode === 'edit' ? "Can't change after creation." : 'Namespace of the PlatformInstance.',
          { required: true },
        )}
        {text('version', 'Platform version', 'Exact @di-framework/platform version, e.g. 6.0.17.', {
          required: true,
        })}
        {select(
          'targetType',
          'Target type',
          TARGET_TYPES,
          mode === 'edit' ? "Can't change after creation." : 'Where the instance runs.',
        )}
        <Typography variant="subtitle2" sx={{ mt: 2 }}>
          Platform (optional)
        </Typography>
        {select(
          'networkPolicyEngine',
          'Network policy engine',
          networkPolicyEngineChoices(storedEngine),
          storedEngine === 'kube-router'
            ? 'Left empty, the API default (existing) applies. kube-router is offered only because this instance already uses it; once changed, it is refused on vcluster.'
            : "Left empty, the API default (existing) applies. kube-router isn't offered on vcluster: the host cluster enforces NetworkPolicy.",
        )}
        {text(
          'storageRoot',
          'Storage root',
          mode === 'edit'
            ? "Can't change after creation."
            : "Node path for tenant data. Empty uses the operator's per-instance default.",
        )}
        {text(
          'httpNodePort',
          'Gateway HTTP NodePort',
          '0 to 32767. Empty keeps the gateway ClusterIP.',
          {
            inputProps: { inputMode: 'numeric' },
          },
        )}
        {text(
          'httpEndpoint',
          'Gateway HTTP endpoint',
          'Public base URL, e.g. http://apps.example:30080. Reported in status.endpoints.http.',
        )}
        {select(
          'deletionPolicy',
          'Deletion policy',
          DELETION_POLICIES,
          'Delete (API default) removes the cluster; Retain keeps it.',
        )}
        <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
          Tenants (optional)
        </Typography>
        <Typography variant="caption" component="p">
          Up to {MAX_TENANTS}. A tenant's other settings (deletion policy, resources, runtime,
          suspended) are kept as they are; set them in YAML. An existing tenant can't be renamed:
          the platform would remove it and create a new one, so remove it and add another instead.
        </Typography>
        {tenantsError && (
          <Typography variant="caption" color="error" component="p">
            {tenantsError}
          </Typography>
        )}
        {form.tenants.map((tenant, i) => {
          const error = errorFor('tenants', `tenants.${i}.name`);
          return (
            <Box key={tenant.key} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              <TextField
                id={`pi-tenants-${i}-name`}
                label={`Tenant ${i + 1} name`}
                value={tenant.name}
                onChange={(e) =>
                  setList('tenants', (rows) =>
                    rows.map((t, k) => (k === i ? { ...t, name: e.target.value } : t)),
                  )
                }
                disabled={busy}
                InputProps={{ readOnly: tenant.existing }}
                error={Boolean(error)}
                helperText={
                  error ??
                  (tenant.existing
                    ? "Can't be renamed: removing it removes the tenant on the platform."
                    : '1-40 lowercase letters, digits and "-".')
                }
                fullWidth
                size="small"
                margin="dense"
              />
              <Button
                size="small"
                sx={{ mt: 1.5 }}
                aria-label={`Remove tenant ${i + 1}`}
                onClick={() => setList('tenants', (rows) => rows.filter((_, k) => k !== i))}
                disabled={busy}
              >
                Remove
              </Button>
            </Box>
          );
        })}
        <Button
          size="small"
          onClick={() =>
            setList('tenants', (rows) => [...rows, { name: '', rest: {}, key: newKey() }])
          }
          disabled={busy || form.tenants.length >= MAX_TENANTS}
        >
          Add tenant
        </Button>
        <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
          Users (optional)
        </Typography>
        <Typography variant="caption" component="p">
          Up to {MAX_USERS}, each in up to {MAX_MEMBERSHIPS} tenants. Every membership must name one
          of the Tenants above.
        </Typography>
        {usersError && (
          <Typography variant="caption" color="error" component="p">
            {usersError}
          </Typography>
        )}
        {form.users.map((user, i) => {
          const nameError = errorFor('users', `users.${i}.name`);
          const membershipsError = errorFor('users', `users.${i}.memberships`);
          return (
            <Box key={user.key} sx={{ pl: 1, borderLeft: 2, borderColor: 'divider', my: 1 }}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <TextField
                  id={`pi-users-${i}-name`}
                  label={`User ${i + 1} name`}
                  value={user.name}
                  onChange={(e) => setUser(i, (u) => ({ ...u, name: e.target.value }))}
                  disabled={busy}
                  error={Boolean(nameError)}
                  helperText={nameError ?? '1-40 lowercase letters, digits and "-".'}
                  fullWidth
                  size="small"
                  margin="dense"
                />
                <Button
                  size="small"
                  sx={{ mt: 1.5 }}
                  aria-label={`Remove user ${i + 1}`}
                  onClick={() => setList('users', (rows) => rows.filter((_, k) => k !== i))}
                  disabled={busy}
                >
                  Remove
                </Button>
              </Box>
              {membershipsError && (
                <Typography variant="caption" color="error" component="p">
                  {membershipsError}
                </Typography>
              )}
              {user.memberships.map((m, j) => {
                // Shown on a change of either list: removing a tenant can orphan a membership.
                const key = `users.${i}.memberships.${j}.tenant`;
                const tenantError = errorFor('users', key) ?? errorFor('tenants', key);
                return (
                  <Box key={m.key} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                    <TextField
                      id={`pi-users-${i}-memberships-${j}-tenant`}
                      select
                      label={`Tenant, membership ${j + 1} of user ${i + 1}`}
                      value={m.tenant}
                      onChange={(e) =>
                        setUser(i, (u) => ({
                          ...u,
                          memberships: u.memberships.map((x, k) =>
                            k === j ? { ...x, tenant: e.target.value } : x,
                          ),
                        }))
                      }
                      disabled={busy}
                      error={Boolean(tenantError)}
                      helperText={tenantError ?? ' '}
                      size="small"
                      margin="dense"
                      sx={{ flex: 2 }}
                    >
                      {tenantChoices(m.tenant).map((name) => (
                        <MenuItem key={name} value={name}>
                          {name}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      id={`pi-users-${i}-memberships-${j}-role`}
                      select
                      label={`Role, membership ${j + 1} of user ${i + 1}`}
                      value={m.role}
                      onChange={(e) =>
                        setUser(i, (u) => ({
                          ...u,
                          memberships: u.memberships.map((x, k) =>
                            k === j ? { ...x, role: e.target.value as typeof x.role } : x,
                          ),
                        }))
                      }
                      disabled={busy}
                      helperText=" "
                      size="small"
                      margin="dense"
                      sx={{ flex: 1 }}
                    >
                      {MEMBERSHIP_ROLES.map((role) => (
                        <MenuItem key={role} value={role}>
                          {role}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Button
                      size="small"
                      sx={{ mt: 1.5 }}
                      aria-label={`Remove membership ${j + 1} of user ${i + 1}`}
                      onClick={() =>
                        setUser(i, (u) => ({
                          ...u,
                          memberships: u.memberships.filter((_, k) => k !== j),
                        }))
                      }
                      disabled={busy}
                    >
                      Remove
                    </Button>
                  </Box>
                );
              })}
              <Button
                size="small"
                aria-label={`Add membership to user ${i + 1}`}
                onClick={() =>
                  setUser(i, (u) => ({
                    ...u,
                    memberships: [
                      ...u.memberships,
                      {
                        tenant:
                          tenantChoices('').find(
                            (name) => !u.memberships.some((x) => x.tenant === name),
                          ) ?? '',
                        role: 'viewer',
                        key: newKey(),
                      },
                    ],
                  }))
                }
                disabled={busy || user.memberships.length >= MAX_MEMBERSHIPS}
              >
                Add membership
              </Button>
            </Box>
          );
        })}
        <Button
          size="small"
          onClick={() =>
            setList('users', (rows) => [
              ...rows,
              { name: '', memberships: [], rest: {}, key: newKey() },
            ])
          }
          disabled={busy || form.users.length >= MAX_USERS}
        >
          Add user
        </Button>
        <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
          Tenant auth (optional)
        </Typography>
        <Typography variant="caption" component="p">
          The per-tenant console and /v1 API against an OIDC issuer. Issuer, client ID, client
          secret and image go together; all empty leaves tenant auth off.
        </Typography>
        {text('tenantAuthIssuer', 'Issuer', 'OIDC issuer URL, as both pods and browsers name it.')}
        {text('tenantAuthClientId', 'Client ID', "The console's confidential OAuth client.")}
        {text(
          'tenantAuthSecretName',
          'Client secret: Secret name',
          "A Secret in this instance's namespace. The form never reads or sends the secret value.",
        )}
        {text('tenantAuthSecretKey', 'Client secret: key', 'The key in that Secret.')}
        {text(
          'tenantAuthImage',
          'Tenant-auth image',
          'Pinned by digest: <repository>@sha256:<digest>.',
        )}
        {text(
          'tenantAuthIssuerUpstream',
          'Issuer upstream (advanced)',
          'In-cluster <service>.<namespace>[.svc...]:<port> a sidecar forwards a loopback issuer to.',
        )}
        {text(
          'tenantAuthIssuerUpstreamPodPort',
          'Issuer upstream pod port (advanced)',
          'The pod port behind the issuer upstream, 1 to 65535.',
          { inputProps: { inputMode: 'numeric' } },
        )}
        {text(
          'tenantAuthIssuerIp',
          'Issuer IP (advanced)',
          "The issuer's IPv4 when pods can't resolve its hostname.",
        )}
        {text(
          'tenantAuthConsolePublicUrl',
          'Console public URL (advanced)',
          'Browser-visible console URL; {tenant} is replaced.',
        )}
        {text(
          'tenantAuthControllerPublicUrl',
          'Controller public URL (advanced)',
          'Controller URL shown to users and CLIs; {tenant} is replaced.',
        )}
        {text(
          'tenantAuthRegistryComponent',
          'Registry component (advanced)',
          "Deploys each tenant's own OCI registry: the oci-registry component pinned by digest.",
        )}
        {text(
          'tenantAuthRegistryPublicUrl',
          'Registry public URL (advanced)',
          'The registry origin users log in to; {tenant} is replaced.',
        )}
        {text(
          'tenantAuthRegistryMaxBodyBytes',
          'Registry max body bytes (advanced)',
          'At least 1.',
          {
            inputProps: { inputMode: 'numeric' },
          },
        )}
        {text(
          'tenantAuthRegistryMaxConcurrent',
          'Registry max concurrent (advanced)',
          'At least 1.',
          {
            inputProps: { inputMode: 'numeric' },
          },
        )}
        {text(
          'tenantAuthRegistryUploadIdleTimeoutMs',
          'Registry upload idle timeout ms (advanced)',
          'At least 1.',
          { inputProps: { inputMode: 'numeric' } },
        )}
        {text(
          'tenantAuthRegistryUpstreamTimeoutMs',
          'Registry upstream timeout ms (advanced)',
          'At least 1.',
          { inputProps: { inputMode: 'numeric' } },
        )}
        <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
          Tenant hosts (optional)
        </Typography>
        {text(
          'tenantHostImage',
          'Tenant host image',
          `${hostImageHelp} A change restarts the tenant hosts.`,
        )}
        {select(
          'tenantHostImagePullPolicy',
          'Tenant host image pull policy',
          PULL_POLICIES,
          'Left empty, the platform default (IfNotPresent) applies.',
        )}
        <Box sx={{ mt: 2 }}>
          <Button size="small" onClick={() => setShowPreview((s) => !s)}>
            {showPreview ? 'Hide YAML' : showLabel}
          </Button>
          {showPreview && (
            <Box component="pre" aria-label="Object preview" sx={{ fontSize: '0.8rem', p: 1 }}>
              {dump(submission.mode === 'edit' ? submission.patch : submission.object, {
                noRefs: true,
              })}
            </Box>
          )}
        </Box>
        {serverError && (
          <Alert severity="error" role="alert" sx={{ mt: 2 }}>
            {serverError}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={onSubmit} disabled={busy}>
          {mode === 'create' ? 'Create' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
