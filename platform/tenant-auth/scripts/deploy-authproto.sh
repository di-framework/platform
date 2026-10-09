#!/usr/bin/env bash
# Redeploy the acme tenant console and controller on a di-framework-kube instance, pointed at the
# identity-server guest behind the platform gateway. The console's confidential client is the guest's
# bootstrap `access` client; its secret is read from the directory Postgres inside the cluster and
# never printed. Run from platform/tenant-auth.
#
#   scripts/deploy-authproto.sh [instance] [tenant]
set -euo pipefail
cd "$(dirname "$0")/.."
instance="${1:-authproto}"
tenant="${2:-acme}"
kubeconfig="${TENANT_AUTH_KUBECONFIG:-$HOME/Library/Application Support/di-framework-kube/$instance/kubeconfig}"
issuer="${TENANT_AUTH_ISSUER:-http://identity.identity.localhost:28280}"
upstream="${TENANT_AUTH_ISSUER_UPSTREAM:-di-platform-gateway.wasmcloud.svc.cluster.local:80}"
directory_ns="${TENANT_AUTH_DIRECTORY_NAMESPACE:-di-runtime-identity}"

pod="$(kubectl --kubeconfig "$kubeconfig" -n "$directory_ns" get pods -o name | grep di-bs-directory | head -1)"
[ -n "$pod" ] || { echo "no di-bs-directory pod in $directory_ns" >&2; exit 1; }
secret="$(kubectl --kubeconfig "$kubeconfig" -n "$directory_ns" exec -i "$pod" -- \
  psql -U app -d app -Atc "select value from identity_runtime_secret where name = 'AUTH_ACCESS_CLIENT_SECRET'")"
[ -n "$secret" ] || { echo "AUTH_ACCESS_CLIENT_SECRET row not found" >&2; exit 1; }

bun scripts/deploy-local.ts --tenant "$tenant" --kubeconfig "$kubeconfig" \
  --issuer "$issuer" --issuer-upstream "$upstream" \
  --client-id access --client-secret "$secret"

cat >&2 <<MSG
Port-forwards bound to the old pods are now broken; restart them:
  kubectl --kubeconfig '$kubeconfig' -n di-runtime-$tenant port-forward svc/tenant-controller 8788:8788 &
  kubectl --kubeconfig '$kubeconfig' -n di-runtime-$tenant port-forward svc/tenant-console 8787:8787 &
MSG
