# di-framework-platform Headlamp plugin

A [Headlamp](https://headlamp.dev) plugin for `PlatformInstance` (`platform.di-framework.dev/v1alpha1`),
the resource the [platform operator](../README.md) reconciles. It is a client of the API only: anything
it does, `kubectl apply` of the same YAML does too.

- **Platform Instances** in the sidebar: name, namespace, phase, version (with the installed version
  while an upgrade is in progress), Ready and age.
- **Create** and **Edit spec** forms. Empty fields are left out of the object, so the CRD defaults
  apply exactly as for a manifest. Name, namespace, target and storage root are disabled on edit (the
  CRD makes target and storageRoot immutable). Names over 63 characters are rejected before sending.
  **Show YAML** shows the exact object that will be sent.
- **Edit spec** sends a JSON Patch (RFC 6902, `application/json-patch+json`) computed from the
  form's changes against the object as it was when the dialog opened, never a full PUT. The patch
  touches only the form's spec fields that changed, so spec fields this plugin version doesn't
  know, labels, annotations and the rest of the metadata are left as they are. It starts with a
  `test` of each changed field's old value, and tests that a `platform` or `gateway` it empties is
  still `{}` before removing it. JSON Patch can't test that a key is absent, so a patch that adds a
  missing field or container also tests `metadata.resourceVersion` (captured at open). If one of
  those changed meanwhile, the apiserver rejects the whole patch (a 422 "the server rejected our
  request due to an error in our request", or a 409) and the form says the instance changed and
  must be reopened, instead of overwriting someone else's change. A status write by the operator
  doesn't block an edit of existing fields. A validation error (`… is invalid: …`) is shown as the
  apiserver sent it. **Show patch** shows the operations.
- **Detail view**: spec and status, endpoints, conditions with reasons and messages, recent Events,
  and the instance kubeconfig from `status.kubeconfigSecretRef`. The Secret is read only when you
  click Show or Download, through Headlamp's API proxy with your own credentials, so RBAC on the
  Secret decides. A 403 says which permission is missing. The kubeconfig is never cached: it stays in
  the page only until you hide it or leave.

Pinned to `@kinvolk/headlamp-plugin` 0.14.0, the version in Headlamp v0.46.0's source tree
(Headlamp Helm chart 0.46.0, the current release).

## Develop

The plugin is a standalone Bun package with its own `bun.lock`. It is not one of the repository's
workspaces, and the root `bun test`, `tsc` and lockfile skip it.

```sh
cd platform/operator/headlamp-plugin
bun install --frozen-lockfile
bun run lint      # eslint (Headlamp's config); the root `bun run lint` (Biome) also covers src/
bun run tsc
bun run test      # vitest + Testing Library, Headlamp's test setup (vitest.config.mjs)
bun run test:coverage  # the same with the coverage gate CI runs: 100% lines, statements,
                       # functions and branches over src/ (tests and src/testdata/ excluded)
bun run package   # build + deterministic tarball in dist-package/
bun run start     # watch mode for a local Headlamp (see Headlamp's plugin docs)
```

`src/mapping.ts` is the pure form-to-object mapping. `src/mapping.test.ts` checks it against the YAML
fixtures in `src/testdata/` (minimal, full and partial spec), which are validated against the CRD's
`openAPIV3Schema` (read from `../config/crd`, with Ajv, and closed with `additionalProperties: false`
so a field the apiserver would prune fails) and its CEL rules.

Tests that render the Headlamp glue (`index.tsx`, `resource.ts`, `List.tsx`, `Detail.tsx`) and
`api.ts` replace Headlamp's runtime modules (`ApiProxy`, `components/common`, `k8s/cluster`) with
`vi.mock` stand-ins; `vitest.config.mjs` aliases `@kinvolk/headlamp-plugin/lib/k8s/cluster`, which
exists only as an external in the built plugin, so it can be mocked.

### Dependency advisories

`bun audit` lists advisories only in the build and test tooling that `@kinvolk/headlamp-plugin`
0.14.0 (the latest release) brings in. None of it is in the shipped `main.js`: Headlamp provides
React, MUI and its own libraries at runtime, and the build bundles only `src/` plus `js-yaml`.
`main.js` was checked byte-identical with and without the overrides below.

- `tinypool` (critical, via vitest) and `webpack-dev-middleware` (high, via the Storybook builder)
  are fixed by the `overrides` in `package.json` (`2.1.2` and `7.4.5`); lint, tsc, the tests and
  the package all pass with them.
- `vitest` / `@vitest/mocker` (moderate): the fixes are in vitest 4, which Headlamp's test config
  in 0.14.0 doesn't support. They concern vitest's dev-server mock endpoints; CI runs `vitest run`
  only, with no server exposed.
- `elliptic` (low, via `crypto-browserify` in `vite-plugin-node-polyfills`): no fixed release.
  The build polyfills only `process`, `buffer` and `stream`, so it is not bundled.

Dependabot watches this directory (`.github/dependabot.yml`) and will propose the fixes when
`@kinvolk/headlamp-plugin` moves.

## Package

`bun run package` builds `dist/main.js` and writes
`dist-package/di-framework-platform-<version>.tar.gz` and a `.sha256` next to it. The layout is the
same as `headlamp-plugin package` (one top-level folder with `main.js` and `package.json`), but the
archive is deterministic: fixed mtimes, modes, owner and entry order, and a gzip header with no
timestamp. The same commit packs to the same sha256 on macOS and Linux. The gzip bytes come from
Node's zlib, so CI pins Node (`actions/setup-node`, 22.23.2); package with the same Node to
reproduce the checksum.

## Delivery: Artifact Hub (#435)

Loading the plugin from the Headlamp chart is tracked in
[#435](https://github.com/di-framework/platform/issues/435): the tarball is published as a GitHub
release asset and listed in an **Artifact Hub** repository of kind *Headlamp plugins*.

That is the only route the chart's plugin manager takes. `pluginsManager` runs
`@headlamp-k8s/pluginctl install --config /config/plugin.yml`, and pluginctl 0.1.1 (the only
published version) rejects anything else:

- `source` must be `https://artifacthub.io/packages/headlamp/<repo>/<name>`; GitHub Pages, a plain
  HTTPS URL or any other host fails pluginctl's config schema and `fetchPluginInfo`.
- The archive URL comes from the package's Artifact Hub annotations and must be a GitHub
  (`releases`/`archive`), GitLab or Bitbucket URL. pluginctl checks its sha256 and extracts it with
  `strip: 1`.

The pieces #435 delivers:

1. The tarball attached to the GitHub release:
   `https://github.com/di-framework/platform/releases/download/v<platform-version>/di-framework-platform-<plugin-version>.tar.gz`
2. An Artifact Hub repository with `artifacthub-repo.yml` and one `artifacthub-pkg.yml` per version:

   ```yaml
   version: <plugin-version>
   name: di-framework-platform
   displayName: di-framework Platform Instances
   createdAt: "<RFC 3339 time>"
   description: Manage di-framework PlatformInstances from Headlamp.
   annotations:
     headlamp/plugin/archive-url: https://github.com/di-framework/platform/releases/download/v<platform-version>/di-framework-platform-<plugin-version>.tar.gz
     headlamp/plugin/archive-checksum: sha256:<sha256 from dist-package/*.sha256>
     headlamp/plugin/version-compat: ">=0.46.0"
     headlamp/plugin/distro-compat: in-cluster,web,app
   ```

3. The chart values:

   ```yaml
   pluginsManager:
     enabled: true
     configContent: |
       plugins:
         - name: di-framework-platform
           source: https://artifacthub.io/packages/headlamp/<artifacthub-repo>/di-framework-platform
           version: <plugin-version>
   ```
