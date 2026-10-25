import { StatusChip } from './components/StatusChip';
import { conditionSeverity, phaseOf, phaseSeverity, readyStatus } from './status';
import type { PlatformInstanceObject } from './types';

/** What a list row needs: Headlamp's KubeObject exposes the API object as `jsonData`. */
export interface Row {
  jsonData: Pick<PlatformInstanceObject, 'spec' | 'status'>;
}

/** A custom column in Headlamp's ResourceTable shape. */
export interface CustomColumn {
  id: string;
  label: string;
  getValue: (item: Row) => string;
  render: (item: Row) => JSX.Element;
}

export const phaseColumn: CustomColumn = {
  id: 'phase',
  label: 'Phase',
  getValue: (item) => phaseOf(item.jsonData),
  render: (item) => {
    const phase = phaseOf(item.jsonData);
    return <StatusChip label={phase} severity={phaseSeverity(phase)} />;
  },
};

export const versionColumn: CustomColumn = {
  id: 'version',
  label: 'Version',
  getValue: (item) => item.jsonData.spec?.version ?? '',
  render: (item) => {
    const wanted = item.jsonData.spec?.version ?? '';
    const installed = item.jsonData.status?.installedVersion;
    if (installed && installed !== wanted) {
      return (
        <span title={`Installed: ${installed}`}>
          {wanted} (installed {installed})
        </span>
      );
    }
    return <span>{wanted || '-'}</span>;
  },
};

export const readyColumn: CustomColumn = {
  id: 'ready',
  label: 'Ready',
  getValue: (item) => readyStatus(item.jsonData),
  render: (item) => {
    const ready = readyStatus(item.jsonData);
    return <StatusChip label={ready} severity={conditionSeverity(ready)} />;
  },
};

/** The list columns: name, namespace, phase, version, Ready and age. */
export const platformInstanceColumns: Array<'name' | 'namespace' | 'age' | CustomColumn> = [
  'name',
  'namespace',
  phaseColumn,
  versionColumn,
  readyColumn,
  'age',
];
