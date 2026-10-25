import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, useState } from 'react';
import {
  decodeKubeconfig,
  kubeconfigErrorMessage,
  kubeconfigFileName,
  type SecretLike,
} from '../kubeconfig';

export interface KubeconfigSectionProps {
  instanceName: string;
  namespace: string;
  /** status.kubeconfigSecretRef.name, or undefined before the operator has written it. */
  secretName?: string;
  /** Reads the Secret with the viewer's credentials; rejects with `{ status }` on HTTP errors. */
  fetchSecret: (namespace: string, name: string) => Promise<SecretLike>;
}

/**
 * Shows or downloads the instance's admin kubeconfig. Each action reads the Secret again; the text
 * lives only in this component's state and is dropped on Hide or unmount.
 */
export function KubeconfigSection(props: KubeconfigSectionProps) {
  const { instanceName, namespace, secretName, fetchSecret } = props;
  const [kubeconfig, setKubeconfig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!secretName) {
    return (
      <Typography variant="body2">
        The operator hasn't published a kubeconfig yet (status.kubeconfigSecretRef is empty).
      </Typography>
    );
  }

  async function read(): Promise<string | null> {
    setLoading(true);
    setError(null);
    try {
      const text = decodeKubeconfig(await fetchSecret(namespace, secretName as string));
      return mounted.current ? text : null;
    } catch (err) {
      if (mounted.current) {
        setKubeconfig(null);
        setError(kubeconfigErrorMessage(err, namespace, secretName as string));
      }
      return null;
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }

  async function show() {
    const text = await read();
    if (text !== null) {
      setKubeconfig(text);
    }
  }

  async function download() {
    const text = await read();
    if (text === null) {
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = kubeconfigFileName(instanceName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Box>
      <Typography variant="body2" sx={{ mb: 1 }}>
        Secret <code>{secretName}</code>, key <code>kubeconfig</code>. Reading it uses your own
        permissions.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        {kubeconfig === null ? (
          <Button variant="outlined" size="small" onClick={show} disabled={loading}>
            Show kubeconfig
          </Button>
        ) : (
          <Button variant="outlined" size="small" onClick={() => setKubeconfig(null)}>
            Hide kubeconfig
          </Button>
        )}
        <Button variant="outlined" size="small" onClick={download} disabled={loading}>
          Download kubeconfig
        </Button>
      </Box>
      {error && (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      )}
      {kubeconfig !== null && (
        <Box
          component="pre"
          aria-label="kubeconfig"
          sx={{ overflow: 'auto', maxHeight: 400, p: 1, fontSize: '0.8rem' }}
        >
          {kubeconfig}
        </Box>
      )}
    </Box>
  );
}
