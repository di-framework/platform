import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  type CustomColumn,
  phaseColumn,
  platformInstanceColumns,
  type Row,
  readyColumn,
  versionColumn,
} from './columns';
import type { Condition, PlatformInstanceObject } from './types';

function row(spec: Partial<PlatformInstanceObject['spec']>, status?: object): Row {
  return {
    jsonData: {
      spec: { version: '6.0.17', target: { type: 'vcluster' }, ...spec },
      status,
    },
  };
}

function cond(type: string, status: Condition['status']): Condition {
  return { type, status, reason: 'R', message: 'm', lastTransitionTime: '2026-10-25T10:00:00Z' };
}

function renderCell(column: CustomColumn, item: Row) {
  return render(<div>{column.render(item)}</div>);
}

describe('list columns', () => {
  it('are name, namespace, phase, version, Ready and age, in that order', () => {
    const ids = platformInstanceColumns.map((c) => (typeof c === 'string' ? c : c.id));
    expect(ids).toEqual(['name', 'namespace', 'phase', 'version', 'ready', 'age']);
    const labels = platformInstanceColumns.flatMap((c) => (typeof c === 'string' ? [] : [c.label]));
    expect(labels).toEqual(['Phase', 'Version', 'Ready']);
  });

  it('phase shows status.phase, or - before the operator reports one', () => {
    expect(phaseColumn.getValue(row({}, { phase: 'Installing' }))).toBe('Installing');
    renderCell(phaseColumn, row({}, { phase: 'Failed' }));
    expect(screen.getByText('Failed')).toBeTruthy();

    expect(phaseColumn.getValue(row({}))).toBe('');
    const { container } = renderCell(phaseColumn, row({}));
    expect(container.textContent).toBe('-');
  });

  it('version is spec.version, noting the installed version while they differ', () => {
    const upgrading = row({ version: '6.0.18' }, { installedVersion: '6.0.17' });
    expect(versionColumn.getValue(upgrading)).toBe('6.0.18');
    const { container } = renderCell(versionColumn, upgrading);
    expect(container.textContent).toBe('6.0.18 (installed 6.0.17)');

    const settled = row({ version: '6.0.18' }, { installedVersion: '6.0.18' });
    expect(renderCell(versionColumn, settled).container.textContent).toBe('6.0.18');
  });

  it('Ready is the status of the Ready condition', () => {
    const ready = row({}, { conditions: [cond('TargetReady', 'True'), cond('Ready', 'False')] });
    expect(readyColumn.getValue(ready)).toBe('False');
    renderCell(readyColumn, ready);
    expect(screen.getByText('False')).toBeTruthy();

    const noReady = row({}, { conditions: [cond('TargetReady', 'True')] });
    expect(readyColumn.getValue(noReady)).toBe('');
    expect(renderCell(readyColumn, noReady).container.textContent).toBe('-');
  });
});
