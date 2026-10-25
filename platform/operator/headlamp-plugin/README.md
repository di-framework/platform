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
bun run test      # vitest + Testing Library, Headlamp's test setup
bun run package   # build + deterministic tarball in dist-package/
bun run start     # watch mode for a local Headlamp (see Headlamp's plugin docs)
```

`src/mapping.ts` is the pure form-to-object mapping. `src/mapping.test.ts` checks it against the YAML
fixtures in `src/testdata/` (minimal, full and partial spec), which are validated against the CRD's
`openAPIV3Schema` (read from `../config/crd`, with Ajv, and closed with `additionalProperties: false`
so a field the apiserver would prune fails) and its CEL rules.

## Package

`bun run package` builds `dist/main.js` and writes
`dist-package/di-framework-platform-<version>.tar.gz` and a `.sha256` next to it. The layout is the
same as `headlamp-plugin package` (one top-level folder with `main.js` and `package.json`), but the
archive is deterministic: fixed mtimes, modes, owner and entry order, and a gzip header with no
timestamp. The same commit packs to the same sha256 on macOS and Linux.

## Load it through Headlamp's plugin manager

The Headlamp chart's plugin manager (`pluginsManager` in the chart values) runs
`@headlamp-k8s/pluginctl install --config /config/plugin.yml`. pluginctl 0.1.1 only installs from
**Artifact Hub**: `source` must be `https://artifacthub.io/packages/headlamp/<repo>/<name>`. It
reads the archive URL and checksum from the package's Artifact Hub annotations, and accepts an
archive URL only on GitHub (`https://github.com/<org>/<repo>/releases/...`), GitLab or Bitbucket.
It downloads the archive, checks its sha256 and extracts it with `strip: 1`.

So publishing takes three pieces:

1. The tarball attached to the GitHub release:
   `https://github.com/di-framework/platform/releases/download/v<platform-version>/di-framework-platform-<plugin-version>.tar.gz`
2. An Artifact Hub repository of kind *Headlamp plugins*, pointing at a directory with
   `artifacthub-repo.yml` and one `artifacthub-pkg.yml` per version:

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

Without Artifact Hub, the alternative is to skip the plugin manager and copy the extracted tarball
into Headlamp's `config.pluginsDir` (for example from an init container); Headlamp loads any folder
there that holds `main.js` and `package.json`.
