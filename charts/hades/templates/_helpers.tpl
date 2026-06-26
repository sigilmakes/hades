{{- define "hades.labels" -}}
app.kubernetes.io/name: hades
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: hades
{{- end -}}
