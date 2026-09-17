{{- define "wayscribe.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "wayscribe.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "wayscribe.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "wayscribe.labels" -}}
app.kubernetes.io/name: {{ include "wayscribe.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "wayscribe.image" -}}
{{- /* Release tags are v-prefixed (scripts/publish-image.sh is given the git tag), so the default is too. */ -}}
{{- $tag := .Values.image.tag | default (printf "v%s" .Chart.AppVersion) -}}
{{- printf "%s/%s:%s" .Values.image.registry .component $tag -}}
{{- end -}}

{{/*
The secret holding DATABASE_URL, ENCRYPTION_KEY and ADMIN_TOKEN — either one the
operator manages, or the one this chart creates.
*/}}
{{- define "wayscribe.secretName" -}}
{{- .Values.secrets.existingSecret | default (printf "%s-secrets" (include "wayscribe.fullname" .)) -}}
{{- end -}}

{{/*
Where the API talks to PostgreSQL.

The in-cluster database wins when it is enabled, because leaving `databaseUrl`
pointing somewhere else while running one here is a configuration that looks
like it works and writes to the wrong place.
*/}}
{{- define "wayscribe.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- printf "postgresql://%s:%s@%s-postgresql:5432/%s" .Values.postgresql.user .Values.postgresql.password (include "wayscribe.fullname" .) .Values.postgresql.database -}}
{{- else -}}
{{- .Values.databaseUrl -}}
{{- end -}}
{{- end -}}

{{/*
Environment shared by everything that talks to the database.
*/}}
{{- define "wayscribe.databaseEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "wayscribe.secretName" . }}
      key: DATABASE_URL
{{- end -}}

{{/*
NetworkPolicy egress rules shared by the API and migrate pods.
*/}}
{{- define "wayscribe.dnsEgress" -}}
- ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
{{- end }}
{{- define "wayscribe.databaseEgress" -}}
{{- if .Values.postgresql.enabled -}}
- to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: {{ include "wayscribe.name" . }}
          app.kubernetes.io/instance: {{ .Release.Name }}
          app.kubernetes.io/component: postgresql
  ports:
    - port: 5432
      protocol: TCP
{{- else -}}
- ports:
    - port: {{ .Values.networkPolicy.database.port }}
      protocol: TCP
  {{- with .Values.networkPolicy.database.to }}
  to:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- end }}
