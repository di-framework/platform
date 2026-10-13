{{- define "backup.tenant" -}}
{{- if not (hasPrefix "di-tenant-" .Release.Namespace) -}}
{{- fail (printf "namespace %s is not a wasmCloud tenant namespace (di-tenant-<name>)" .Release.Namespace) -}}
{{- end -}}
{{- trimPrefix "di-tenant-" .Release.Namespace -}}
{{- end -}}
{{- /* The S3 credentials Secret the chart's S3 destination names, or empty. */ -}}
{{- define "backup.s3Secret" -}}
{{- if or (eq .Values.type "s3") (eq .Values.type "both") -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else if and .Values.accessKeyId .Values.secretAccessKey -}}
di-backup-s3
{{- end -}}
{{- end -}}
{{- end -}}
{{- define "backup.runtime" -}}
{{- printf "di-runtime-%s" (include "backup.tenant" . | trim) -}}
{{- end -}}
