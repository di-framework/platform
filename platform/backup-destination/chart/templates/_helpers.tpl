{{- define "backup.tenant" -}}
{{- if not (hasPrefix "di-tenant-" .Release.Namespace) -}}
{{- fail (printf "namespace %s is not a wasmCloud tenant namespace (di-tenant-<name>)" .Release.Namespace) -}}
{{- end -}}
{{- trimPrefix "di-tenant-" .Release.Namespace -}}
{{- end -}}
{{- define "backup.runtime" -}}
{{- printf "di-runtime-%s" (include "backup.tenant" . | trim) -}}
{{- end -}}
