import { ResourceListView } from '@kinvolk/headlamp-plugin/lib/components/common';
import Button from '@mui/material/Button';
import { useState } from 'react';
import { submitInstance } from '../api';
import { platformInstanceColumns } from '../columns';
import { PlatformInstance } from '../resource';
import { PlatformInstanceFormDialog } from './PlatformInstanceForm';

export function PlatformInstanceList() {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <ResourceListView
        title="Platform Instances"
        resourceClass={PlatformInstance}
        columns={platformInstanceColumns}
        headerProps={{
          titleSideActions: [
            <Button key="create" variant="contained" size="small" onClick={() => setCreating(true)}>
              Create
            </Button>,
          ],
        }}
      />
      {creating && (
        <PlatformInstanceFormDialog
          open
          mode="create"
          onClose={() => setCreating(false)}
          submit={submitInstance}
        />
      )}
    </>
  );
}
