#!/usr/bin/env bash
# Resolve the tenant host pin set for the wash pin PR (#172): for every variant in $VARIANTS
# (a JSON list of names from the workflow's check-source job), look up
# ghcr.io/di-framework/wash:src-<hash> for this commit's inputs and, when it exists, emit
# "wash-<variant> <digest>". Variants not yet published for this source are left out, so the
# PR keeps their current README rows. Writes a multi-line `pins` output to $GITHUB_OUTPUT.
set -euo pipefail
: "${VARIANTS:?a JSON list of variant names}"
: "${GITHUB_OUTPUT:?}"
pins=''
while read -r name; do
  [[ -n "${name}" ]] || continue
  out="$(bun scripts/source-check.ts --workflow .github/workflows/tenant-host-image.yml \
    --image ghcr.io/di-framework/wash --salt "${name}")"
  printf '%s\n' "${out}"
  digest="$(sed -n 's/^digest=//p' <<<"${out}")"
  if [[ -n "${digest}" ]]; then
    pins+="wash-${name} ${digest}"$'\n'
  else
    echo "::notice::${name} is not published for this source; its pin stays as it is"
  fi
done < <(jq -r '.[]' <<<"${VARIANTS}")
{
  echo 'pins<<EOF'
  printf '%s' "${pins}"
  echo 'EOF'
} >> "${GITHUB_OUTPUT}"
