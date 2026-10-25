import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { type ConditionRow, conditionRows, conditionSeverity } from '../status';
import type { PlatformInstanceObject } from '../types';
import { StatusChip } from './StatusChip';

/** The instance's conditions with their reasons and messages, operator conditions first. */
export function ConditionsTable(props: {
  instance: Pick<PlatformInstanceObject, 'status' | 'metadata'>;
}) {
  const rows: ConditionRow[] = conditionRows(props.instance);
  if (rows.length === 0) {
    return (
      <Typography variant="body2">The operator hasn't reported any conditions yet.</Typography>
    );
  }
  return (
    <Table size="small" aria-label="Conditions">
      <TableHead>
        <TableRow>
          <TableCell>Type</TableCell>
          <TableCell>Status</TableCell>
          <TableCell>Reason</TableCell>
          <TableCell>Message</TableCell>
          <TableCell>Last transition</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.type} data-testid={`condition-${row.type}`}>
            <TableCell>
              {row.type}
              {row.stale ? ' (stale)' : ''}
            </TableCell>
            <TableCell>
              <StatusChip label={row.status} severity={conditionSeverity(row.status)} />
            </TableCell>
            <TableCell>{row.reason || '-'}</TableCell>
            <TableCell sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {row.message || '-'}
            </TableCell>
            <TableCell>{row.lastTransitionTime || '-'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
