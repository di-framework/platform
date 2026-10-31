import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { PLATFORM_SECRETS } from '../src/tenancy/scheduler-pki';
import { platformHelmValues } from '../src/values';

// #541 m6e: the release createPlatform installs, rendered by Helm from the static values.
const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8');
type Doc = { kind: string; metadata: { name: string } };
const rendered = (
  loadAll(fixture('runtime-operator-2.8.0-platform.yaml')) as (Doc | null)[]
).filter((d): d is Doc => Boolean(d));

it('the fixture was rendered from platformHelmValues', () => {
  expect(platformHelmValues('wasmcloud')).toEqual(
    JSON.parse(fixture('runtime-operator-2.8.0-platform.values.json')),
  );
  expect(platformHelmValues('wasmcloud', {}, true)).toMatchObject({
    runtime: { extraArgs: ['--allow-insecure-registries'] },
  });
});

it('the chart renders no NATS, no CA and no Secret, and mounts the platform Secrets', () => {
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.filter((d) => ['Secret', 'StatefulSet', 'ConfigMap'].includes(d.kind))).toEqual(
    [],
  );
  expect(rendered.some((d) => d.metadata.name.includes('nats'))).toBe(false);
  const text = JSON.stringify(rendered);
  for (const secret of [PLATFORM_SECRETS.operator, PLATFORM_SECRETS.host, PLATFORM_SECRETS.data])
    expect(text).toContain(`"secretName":"${secret}"`);
  expect(text).not.toContain('wasmcloud-ca');
  expect(text).not.toContain('scheduler-tls-sha256');
  expect(text).not.toContain('-host-namespaces');
  expect(text).toContain('-watch-namespaces=wasmcloud');
});
