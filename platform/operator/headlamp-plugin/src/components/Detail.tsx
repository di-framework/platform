import {
  DetailsGrid,
  NameValueTable,
  SectionBox,
} from '@kinvolk/headlamp-plugin/lib/components/common';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSecret, submitInstance } from '../api';
import { asObject, PlatformInstance } from '../resource';
import { phaseOf, phaseSeverity } from '../status';
import { ConditionsTable } from './Conditions';
import { KubeconfigSection } from './KubeconfigSection';
import { PlatformInstanceFormDialog } from './PlatformInstanceForm';
import { StatusChip } from './StatusChip';

export function Url(props: { url?: string }) {
  if (!props.url) {
    return <span>-</span>;
  }
  if (/^https?:\/\//.test(props.url)) {
    return (
      <Link href={props.url} target="_blank" rel="noopener noreferrer">
        {props.url}
      </Link>
    );
  }
  return <code>{props.url}</code>;
}

export function EditAction(props: { item: PlatformInstance }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" variant="outlined" onClick={() => setOpen(true)}>
        Edit spec
      </Button>
      {open && (
        <PlatformInstanceFormDialog
          open
          mode="edit"
          existing={asObject(props.item)}
          onClose={() => setOpen(false)}
          submit={submitInstance}
        />
      )}
    </>
  );
}

export function PlatformInstanceDetail() {
  const { namespace, name } = useParams<{ namespace: string; name: string }>();
  return (
    <DetailsGrid
      resourceType={PlatformInstance}
      name={name}
      namespace={namespace}
      withEvents
      actions={(item: PlatformInstance | null) =>
        item ? [<EditAction key="edit-spec" item={item} />] : []
      }
      extraInfo={(item: PlatformInstance | null) => {
        if (!item) {
          return null;
        }
        const spec = item.jsonData.spec;
        const status = item.jsonData.status ?? {};
        const phase = phaseOf(item.jsonData);
        return [
          { name: 'Phase', value: <StatusChip label={phase} severity={phaseSeverity(phase)} /> },
          { name: 'Version', value: spec?.version ?? '-' },
          { name: 'Installed version', value: status.installedVersion ?? '-' },
          { name: 'Target', value: spec?.target?.type ?? '-' },
          { name: 'Deletion policy', value: spec?.deletionPolicy ?? '-' },
          {
            name: 'Network policy engine',
            value: spec?.platform?.networkPolicyEngine ?? '-',
          },
          { name: 'Storage root', value: spec?.platform?.storageRoot || '(operator default)' },
          {
            name: 'Gateway NodePort',
            value: spec?.platform?.gateway?.httpNodePort ?? '-',
          },
          { name: 'Last repair', value: status.lastRepair ?? '-' },
          // What the last successful install applied (status.applied, #442).
          { name: 'Applied tenants', value: status.applied?.tenants ?? '-' },
          { name: 'Applied users', value: status.applied?.users ?? '-' },
          {
            name: 'Applied tenant auth issuer',
            value: status.applied?.tenantAuthIssuer || '-',
          },
          {
            name: 'Applied tenant host image',
            value: status.applied
              ? status.applied.tenantHostImage || "(platform's own default)"
              : '-',
          },
        ];
      }}
      extraSections={(item: PlatformInstance) =>
        item
          ? [
              {
                id: 'platform.di-framework.dev/endpoints',
                section: (
                  <SectionBox title="Endpoints">
                    <NameValueTable
                      rows={[
                        {
                          name: 'Kubernetes',
                          value: <Url url={item.jsonData.status?.endpoints?.kubernetes} />,
                        },
                        {
                          name: 'HTTP',
                          value: <Url url={item.jsonData.status?.endpoints?.http} />,
                        },
                      ]}
                    />
                  </SectionBox>
                ),
              },
              {
                id: 'platform.di-framework.dev/conditions',
                section: (
                  <SectionBox title="Conditions">
                    <ConditionsTable instance={asObject(item)} />
                  </SectionBox>
                ),
              },
              {
                id: 'platform.di-framework.dev/kubeconfig',
                section: (
                  <SectionBox title="Kubeconfig">
                    <KubeconfigSection
                      key={`${item.getNamespace()}/${item.getName()}/${
                        item.jsonData.status?.kubeconfigSecretRef?.name ?? ''
                      }`}
                      instanceName={item.getName()}
                      namespace={item.getNamespace() ?? ''}
                      secretName={item.jsonData.status?.kubeconfigSecretRef?.name}
                      fetchSecret={fetchSecret}
                    />
                  </SectionBox>
                ),
              },
            ]
          : []
      }
    />
  );
}
