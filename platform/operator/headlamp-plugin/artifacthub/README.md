# Artifact Hub repository

This directory is the Artifact Hub repository (kind *Headlamp plugins*) for the
`di-framework-platform` Headlamp plugin:
<https://artifacthub.io/packages/headlamp/di-framework-platform/di-framework-platform>.
Artifact Hub reads it from the `main` branch and re-indexes when the branch moves.

- `artifacthub-repo.yml`: the repository ID and owners.
- `<version>/artifacthub-pkg.yml` and `<version>/README.md`: one package entry per released plugin
  version. The plugin version is the platform release version.

Do not write version entries by hand. The release PR (Auto Tag) packs the plugin and runs
`bun scripts/artifacthub-plugin.ts write <version>`, which records the tarball's sha256 and the
release asset URL
`https://github.com/di-framework/platform/releases/download/v<version>/di-framework-platform-<version>.tar.gz`.
The release workflow packs the plugin again at the tag, checks it against that checksum and only
then uploads the tarball. A published entry is never rewritten.
