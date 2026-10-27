import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConditionsTable } from './components/Conditions';
import { conditionRows, conditionSeverity, phaseSeverity } from './status';
import type { Condition, PlatformInstanceObject } from './types';

const T = '2026-10-25T10:00:00Z';

function instance(conditions: Condition[], generation?: number) {
  return {
    metadata: { name: 'one', namespace: 'team-a', generation },
    status: { conditions },
  } satisfies Pick<PlatformInstanceObject, 'metadata' | 'status'>;
}

const conditions: Condition[] = [
  {
    type: 'Ready',
    status: 'False',
    reason: 'InstallFailed',
    message: 'pulumi up: exit status 1\nresource gateway failed',
    lastTransitionTime: T,
    observedGeneration: 2,
  },
  { type: 'Custom', status: 'Unknown', reason: 'Waiting', message: '', lastTransitionTime: T },
  {
    type: 'ConfigApplied',
    status: 'False',
    reason: 'TenantAuthSecretUnavailable',
    message: 'Secret team-a/tenant-auth-oauth has no key clientSecret',
    lastTransitionTime: T,
    observedGeneration: 3,
  },
  {
    type: 'Installed',
    status: 'False',
    reason: 'Installing',
    message: 'installing 6.0.18',
    lastTransitionTime: T,
    observedGeneration: 3,
  },
  {
    type: 'TargetReady',
    status: 'True',
    reason: 'KubeconfigReady',
    message: 'vCluster answers',
    lastTransitionTime: T,
    observedGeneration: 3,
  },
];

describe('conditionRows', () => {
  it('orders TargetReady, Installed, ConfigApplied, Ready first, then the rest by type', () => {
    expect(conditionRows(instance(conditions)).map((r) => r.type)).toEqual([
      'TargetReady',
      'Installed',
      'ConfigApplied',
      'Ready',
      'Custom',
    ]);
  });

  it('keeps each reason and message', () => {
    const ready = conditionRows(instance(conditions)).find((r) => r.type === 'Ready');
    expect(ready).toMatchObject({
      status: 'False',
      reason: 'InstallFailed',
      message: 'pulumi up: exit status 1\nresource gateway failed',
      lastTransitionTime: T,
    });
  });

  it('marks a condition stale when it describes an older generation', () => {
    const rows = conditionRows(instance(conditions, 3));
    expect(rows.filter((r) => r.stale).map((r) => r.type)).toEqual(['Ready']);
    expect(conditionRows(instance(conditions)).some((r) => r.stale)).toBe(false);
  });

  it('is empty without status', () => {
    expect(conditionRows({ status: undefined })).toEqual([]);
  });
});

describe('ConditionsTable', () => {
  it('renders one row per condition with status, reason and message', () => {
    render(<ConditionsTable instance={instance(conditions, 3)} />);
    const ready = screen.getByTestId('condition-Ready');
    expect(within(ready).getByText('Ready (stale)')).toBeTruthy();
    expect(within(ready).getByText('False')).toBeTruthy();
    expect(within(ready).getByText('InstallFailed')).toBeTruthy();
    expect(ready.textContent).toContain('pulumi up: exit status 1\nresource gateway failed');

    const target = screen.getByTestId('condition-TargetReady');
    expect(within(target).getByText('KubeconfigReady')).toBeTruthy();
    expect(within(target).getByText('vCluster answers')).toBeTruthy();

    const custom = screen.getByTestId('condition-Custom');
    expect(within(custom).getAllByText('-')).toHaveLength(1);

    const config = screen.getByTestId('condition-ConfigApplied');
    expect(within(config).getByText('TenantAuthSecretUnavailable')).toBeTruthy();
    expect(config.textContent).toContain('has no key clientSecret');

    const order = screen.getAllByTestId(/^condition-/).map((el) => el.dataset.testid);
    expect(order).toEqual([
      'condition-TargetReady',
      'condition-Installed',
      'condition-ConfigApplied',
      'condition-Ready',
      'condition-Custom',
    ]);
  });

  it('says so when there are no conditions yet', () => {
    render(<ConditionsTable instance={instance([])} />);
    expect(screen.getByText(/hasn't reported any conditions/)).toBeTruthy();
  });
});

describe('severity', () => {
  it('maps condition statuses and phases', () => {
    expect(['True', 'False', 'Unknown', ''].map(conditionSeverity)).toEqual([
      'success',
      'error',
      'warning',
      '',
    ]);
    expect(
      ['Ready', 'Failed', 'Pending', 'Provisioning', 'Installing', 'Deleting', ''].map(
        phaseSeverity,
      ),
    ).toEqual(['success', 'error', 'warning', 'warning', 'warning', 'warning', '']);
  });
});
