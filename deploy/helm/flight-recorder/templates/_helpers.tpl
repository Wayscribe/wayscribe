{{- define "flight-recorder.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "flight-recorder.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "flight-recorder.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "flight-recorder.labels" -}}
app.kubernetes.io/name: {{ include "flight-recorder.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "flight-recorder.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/%s:%s" .Values.image.registry .component $tag -}}
{{- end -}}

{{/*
The secret holding DATABASE_URL, ENCRYPTION_KEY and ADMIN_TOKEN — either one the
operator manages, or the one this chart creates.
*/}}
{{- define "flight-recorder.secretName" -}}
{{- .Values.secrets.existingSecret | default (printf "%s-secrets" (include "flight-recorder.fullname" .)) -}}
{{- end -}}

{{/*
Where the API talks to PostgreSQL.

The in-cluster database wins when it is enabled, because leaving `databaseUrl`
pointing somewhere else while running one here is a configuration that looks
like it works and writes to the wrong place.
*/}}
{{- define "flight-recorder.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- printf "postgresql://%s:%s@%s-postgresql:5432/%s" .Values.postgresql.user .Values.postgresql.password (include "flight-recorder.fullname" .) .Values.postgresql.database -}}
{{- else -}}
{{- .Values.databaseUrl -}}
{{- end -}}
{{- end -}}

{{/*
Environment shared by everything that talks to the database.
*/}}
{{- define "flight-recorder.databaseEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "flight-recorder.secretName" . }}
      key: DATABASE_URL
{{- end -}}
