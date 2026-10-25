import Chip from '@mui/material/Chip';
import type { Severity } from '../status';

const COLORS: Record<Severity, 'success' | 'warning' | 'error' | 'default'> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  '': 'default',
};

/** A small label for a phase or condition status; '-' when there is nothing to show yet. */
export function StatusChip(props: { label: string; severity: Severity }) {
  const { label, severity } = props;
  if (!label) {
    return <span>-</span>;
  }
  return <Chip size="small" variant="outlined" label={label} color={COLORS[severity]} />;
}
