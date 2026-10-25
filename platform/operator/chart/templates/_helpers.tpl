{{- define "platform-operator.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "platform-operator.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "platform-operator.labels" -}}
{{ include "platform-operator.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "platform-operator.serviceAccountName" -}}
{{- default (include "platform-operator.fullname" .) .Values.serviceAccount.name -}}
{{- end -}}

{{- define "platform-operator.stateClaim" -}}
{{- default (printf "%s-state" (include "platform-operator.fullname" .)) .Values.state.existingClaim -}}
{{- end -}}

{{- define "platform-operator.passphraseSecret" -}}
{{- default (printf "%s-passphrase" (include "platform-operator.fullname" .)) .Values.passphrase.existingSecret -}}
{{- end -}}

{{- /* The operator image, always by digest: <repository>@sha256:<...>. */ -}}
{{- define "platform-operator.image" -}}
{{- if not (hasPrefix "sha256:" .Values.image.digest) -}}
{{- fail (printf "image.digest must be a sha256 digest (sha256:<64 hex>), not %q" .Values.image.digest) -}}
{{- end -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- end -}}
