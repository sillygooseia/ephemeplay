{{/*
Expand the name of the chart.
*/}}
{{- define "ephemeplay.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "ephemeplay.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- include "ephemeplay.name" . }}
{{- end }}
{{- end }}

{{/*
Redis service name (internal cluster DNS).
*/}}
{{- define "ephemeplay.redisHost" -}}
{{ include "ephemeplay.fullname" . }}-redis
{{- end }}
