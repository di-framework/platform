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
import { useMemo, useState } from 'react';
import {
  buildPlatformInstance,
  emptyForm,
  type FormField,
  type FormMode,
  type PlatformInstanceForm as FormState,
  formFromObject,
  isDisabled,
  validateForm,
} from '../mapping';
import {
  DELETION_POLICIES,
  MAX_NAME_LENGTH,
  NETWORK_POLICY_ENGINES,
  type PlatformInstanceObject,
  TARGET_TYPES,
} from '../types';

export interface PlatformInstanceFormProps {
  open: boolean;
  mode: FormMode;
  /** The object being edited (edit mode). */
  existing?: PlatformInstanceObject;
  /** The namespace the create form starts with. */
  defaultNamespace?: string;
  onClose: () => void;
  /** Sends the object; rejects with an Error whose message is shown. */
  submit: (obj: PlatformInstanceObject, mode: FormMode) => Promise<unknown>;
  onDone?: (obj: PlatformInstanceObject) => void;
}

const API_DEFAULT = '(API default)';

/**
 * The create and edit form. Empty fields are left out of the object, so the CRD's defaults apply
 * exactly as for a manifest; fields that can't change after creation are disabled on edit.
 */
export function PlatformInstanceFormDialog(props: PlatformInstanceFormProps) {
  const { open, mode, existing, defaultNamespace, onClose, submit, onDone } = props;
  const [form, setForm] = useState<FormState>(() =>
    existing ? formFromObject(existing) : emptyForm(defaultNamespace ?? 'default'),
  );
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const errors = useMemo(() => validateForm(form, mode), [form, mode]);
  const object = useMemo(() => buildPlatformInstance(form, existing), [form, existing]);

  function set<K extends FormField>(field: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [field]: value }));
    setTouched((t) => ({ ...t, [field]: true }));
  }

  function errorFor(field: FormField): string | undefined {
    return touched[field] || submitted ? errors[field] : undefined;
  }

  async function onSubmit() {
    setSubmitted(true);
    setServerError(null);
    if (Object.keys(errors).length > 0) {
      return;
    }
    setBusy(true);
    try {
      await submit(object, mode);
      onDone?.(object);
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function text(field: FormField, label: string, helper: string, extra: object = {}) {
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

  function select(field: FormField, label: string, options: readonly string[], helper: string) {
    const optional = field !== 'targetType';
    return (
      <TextField
        id={`pi-${field}`}
        select
        label={label}
        value={form[field]}
        onChange={(e) => set(field, e.target.value as never)}
        disabled={isDisabled(field, mode) || busy}
        helperText={helper}
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
          NETWORK_POLICY_ENGINES,
          'Left empty, the API default applies.',
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
        <Box sx={{ mt: 2 }}>
          <Button size="small" onClick={() => setShowPreview((s) => !s)}>
            {showPreview ? 'Hide YAML' : 'Show YAML'}
          </Button>
          {showPreview && (
            <Box component="pre" aria-label="Object preview" sx={{ fontSize: '0.8rem', p: 1 }}>
              {dump(object, { noRefs: true })}
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
