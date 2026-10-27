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
- **Tenancy sections** of both forms, for the `spec.platform` tenancy settings (see the
  [operator README](../README.md)):
  - **Tenants**: a list of names (up to 32). A tenant's other fields (`deletionPolicy`,
    `resources`, `runtime`, `suspended`) aren't shown and are kept as they are; set them in YAML.
    On Edit, existing tenant names are read-only: the platform has no rename, so a changed name
    would remove the old tenant (its namespaces deleted or kept per its `deletionPolicy`) and
    create a new one. Remove the tenant and add another to do that explicitly; new rows are
    editable.
  - **Users**: name and memberships (up to 128 users, 16 memberships each), each membership a
    tenant chosen from the Tenants rows and a role (`developer` or `viewer`). `suspended` is kept.
  - **Tenant auth**: issuer, client ID, the client secret as a reference to a Secret name and key
    in the instance's namespace (the form never reads or sends the secret value), the tenant-auth
    image, and the advanced fields (issuer upstream, its pod port, issuer IP, console and
    controller public URLs, registry component, public URL and limits). All empty leaves
    `tenantAuth` out.
  - **Tenant hosts**: the host image (editable) and its pull policy. On Edit the help text says
    what an empty field keeps: the last applied image (`status.applied.tenantHostImage`), or the
    platform's own default for an instance installed before the operator recorded one.

  Before sending, the form checks what the CRD would: the name pattern and 40-character limit,
  unique names, the list limits, the URL and digest patterns and lengths, that issuer, client ID,
  client secret and image go together (the `tenantAuth` CEL rule plus the required image), that
  the registry has its component, and that every membership names a tenant in the list (the
  memberships CEL rule), so removing a tenant a user is still in is rejected until those
  memberships go too. On Edit, `tenants` and `users` are each patched as a whole list (`test` of
  the old list, then `replace`): a row's index isn't a stable identity. So a concurrent change to
  any tenant or user, even an unrelated row, makes Save fail with the "changed since you opened
  it" message; reopen the form to retry. An empty list (`tenants: []`) saved unchanged stays as it
  is. The `tenantAuth` fields are
  patched one by one like the other fields, removing `clientSecretRef`, `registry` and
  `tenantAuth` when they end up empty.
- **Detail view**: spec and status, what the last install applied (`status.applied`: tenant and
  user counts, tenant auth issuer, tenant host image), endpoints, conditions with reasons and
  messages (`ConfigApplied` among them), recent Events,
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
fixtures in `src/testdata/` (minimal, full and partial spec, and minimal, full and #442 tenancy settings), which are validated against the CRD's
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

The plugin is released with the platform and installed by the operator chart's Headlamp plugin
manager from **Artifact Hub**:
<https://artifacthub.io/packages/headlamp/di-framework-platform/di-framework-platform>.

That is the only route the chart's plugin manager takes. `pluginsManager` runs
`@headlamp-k8s/pluginctl install --config /config/plugin.yml`, and pluginctl 0.1.1 (the only
published version) rejects anything else:

- `source` must be `https://artifacthub.io/packages/headlamp/<repo>/<name>`; GitHub Pages, a plain
  HTTPS URL or any other host fails pluginctl's config schema and `fetchPluginInfo`.
- The archive URL comes from the package's Artifact Hub annotations and must be a GitHub
  (`releases`/`archive`), GitLab or Bitbucket URL. pluginctl checks its sha256 and extracts it with
  `strip: 1`.

How a release delivers it:

1. **Version.** The plugin's version is the platform release version. The release PR (Auto Tag)
   runs `bun scripts/artifacthub-plugin.ts set-version <X>`, which sets `version` in this
   `package.json` and the plugin's `version:` line in the chart's
   `headlamp.pluginsManager.configContent`.
2. **Artifact Hub entry.** The same PR packs the plugin (`bun run package`, with the Node version CI
   pins) and runs `bun scripts/artifacthub-plugin.ts write <X>`, which writes
   [`artifacthub/<X>/artifacthub-pkg.yml`](artifacthub/README.md) and a README. The entry records
   the tarball's sha256 and the release asset
   `https://github.com/di-framework/platform/releases/download/v<X>/di-framework-platform-<X>.tar.gz`,
   with `version-compat: ">=0.46.0"` and `distro-compat: in-cluster,web,app`. An existing entry is
   never rewritten with a different checksum. Artifact Hub reads `artifacthub/` from `main`
   (repository `di-framework-platform`, `artifacthub/artifacthub-repo.yml`).
3. **Release asset.** On the tag, the release workflow's `build` job packs the plugin again (same
   pinned Node, `bun install --frozen-lockfile --ignore-scripts`) and fails if its sha256 differs
   from the entry or the entry is missing. It hands the tarball and its `.sha256` on as a workflow
   artifact with the sha256 as a job output. `github-release` downloads them, checks the sha256
   against that output and uploads each file to the GitHub release only if the release lacks it;
   it rebuilds nothing, and an uploaded asset is never replaced.
4. **Chart.** `headlamp.pluginsManager` is enabled with:

   ```yaml
   pluginsManager:
     enabled: true
     configContent: |
       plugins:
         - name: di-framework-platform
           source: https://artifacthub.io/packages/headlamp/di-framework-platform/di-framework-platform
           version: <X>
   ```

On the pull request that adds an entry (the release PR), the plugin's CI job also checks that the
plugin packs to the recorded sha256 (`bun scripts/artifacthub-plugin.ts verify <version> --required`
from the repository root). Later plugin changes before the next release pack to other bytes under
the same version, so other PRs and pushes do not re-check a released entry.

Two windows to expect:

- **Between the release PR merging and the release uploading the asset**, Artifact Hub may already
  list the new version while its `archive-url` still returns 404. pluginctl fails to install it
  until the `github-release` job has run (the Release workflow follows the tag, which Auto Tag
  makes within about 30 minutes of the merge).
- **Before the first release that ships the plugin (v6.0.18)**, the chart on `main` names plugin
  version `0.1.0`, which has no Artifact Hub entry. Enabling Headlamp from a source checkout of
  the chart installs Headlamp, but the plugin manager cannot install the plugin until that release.
