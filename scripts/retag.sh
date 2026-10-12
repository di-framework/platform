#!/usr/bin/env bash
# Point moving tags back at an already-published digest (#172 review W1). After a revert to a
# source that was published before, check-source finds its src-<hash> tag and skips the build;
# this realigns the moving tags (wash:2.8.0-<variant>, pglite-component:<version>) with that
# digest. A tag that already points there is left alone, so a push that does not change the
# published source does not churn tags. The caller holds packages: write, has logged oras in, and
# has already run the source guard.
#   IMAGE   ghcr.io/<org>/<name>
#   DIGEST  sha256:<64 hex>
#   TAGS    the moving tags, space separated
set -euo pipefail
: "${IMAGE:?}" "${DIGEST:?}" "${TAGS:?}"
if [[ ! "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::not a sha256 digest: ${DIGEST}"
  exit 1
fi
# Validate every tag before moving any, so bad input never leaves a partial retag.
for tag in ${TAGS}; do
  if [[ ! "${tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "::error::not a tag: ${tag}"
    exit 1
  fi
done
for tag in ${TAGS}; do
  current=''
  if out="$(oras manifest fetch --descriptor "${IMAGE}:${tag}" 2>/dev/null)"; then
    current="$(jq -r '.digest // empty' <<<"${out}")"
  fi
  if [[ "${current}" == "${DIGEST}" ]]; then
    echo "${IMAGE}:${tag} already points at ${DIGEST}"
    continue
  fi
  oras tag "${IMAGE}@${DIGEST}" "${tag}"
  echo "::notice::moved ${IMAGE}:${tag} from ${current:-nothing} to ${DIGEST}"
done
