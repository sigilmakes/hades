#!/usr/bin/env bash
# Hades end-to-end test against a kind cluster.
#
# Brings up kind, builds + loads the API image, installs the Helm chart, creates
# an agent via the API, and asserts:
#   1. the brain pod reaches Running
#   2. a home write lands on the PVC (kubectl exec into the hands pod)
#
# This proves the whole distributed stack, not just the FakeKubeClient unit
# tests. It's the acceptance path for issue #43.
#
# Usage:
#   scripts/e2e-kind.sh           # create a fresh kind cluster, run, tear down
#   KEEP_CLUSTER=1 scripts/e2e-kind.sh   # keep the cluster for debugging
#
# Requires: docker, kind, kubectl, helm. On NixOS run inside `nix develop` or:
#   nix shell nixpkgs#kind nixpkgs#kubernetes-helm nixpkgs#kubectl -c scripts/e2e-kind.sh
set -euo pipefail

CLUSTER_NAME="${HADES_E2E_CLUSTER:-hades-e2e}"
NAMESPACE="hades-system"
AGENT_NS="agent-e2e"
AGENT_NAME="e2e"
KEEP_CLUSTER="${KEEP_CLUSTER:-0}"

log() { printf '\033[1m\e[34m[e2e]\033[0m %s\n' "$*"; }
fail() { printf '\033[1m\e[31m[e2e FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"; }

need docker; need kind; need kubectl; need helm

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1. kind cluster: reuse one if it exists (CI may pre-create via
#    helm/kind-action), otherwise create a fresh one.
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    log "reusing existing kind cluster ${CLUSTER_NAME}"
else
    log "creating kind cluster ${CLUSTER_NAME}"
    kind create cluster --name "$CLUSTER_NAME"
fi
# Point kubectl at it.
kubectl config use-context "kind-${CLUSTER_NAME}"

# 2. Build + load the API image (control plane: API + controller + web UI).
log "building hades-api image"
docker build -t hades-api:latest -f infra/docker/Dockerfile.api "$ROOT"
log "loading hades-api into kind"
kind load docker-image hades-api:latest --name "$CLUSTER_NAME"

# 3. Build + load the brain image (one per agent; the controller provisions it).
log "building hades-brain image"
docker build -t hades-brain:latest -f infra/docker/Dockerfile.brain "$ROOT"
log "loading hades-brain into kind"
kind load docker-image hades-brain:latest --name "$CLUSTER_NAME"

# 4. Install the Helm chart (CRDs + RBAC + control plane).
log "installing hades helm chart"
helm upgrade --install hades ./charts/hades --namespace "$NAMESPACE" --create-namespace \
    --set image.pullPolicy=Never --set image.repository=hades-api --set image.tag=latest

# 5. Wait for the control plane to be ready.
log "waiting for hades-api to be ready"
kubectl -n "$NAMESPACE" rollout status deployment/hades-api --timeout=180s || fail "hades-api did not become ready"
kubectl -n "$NAMESPACE" wait --for=condition=ready pod -l app=hades-api --timeout=120s || fail "hades-api pod not ready"

# 6. Port-forward the API (used to create the agent + force a reconcile).
#    Use a high port to avoid conflicts with stale forwards from prior runs.
log "port-forwarding the API"
API_PORT=27347
kubectl -n "$NAMESPACE" port-forward svc/hades-api ${API_PORT}:7347 >/tmp/hades-e2e-pf.log 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT
# Wait for the port-forward to be ready (curl healthz until it responds).
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:${API_PORT}/healthz >/dev/null 2>&1; then break; fi
    sleep 1
done
curl -sf http://127.0.0.1:${API_PORT}/healthz >/dev/null || { cat /tmp/hades-e2e-pf.log; fail "could not reach the API on :${API_PORT}"; }

# 7. Apply an agent via the API (the control plane is the source of truth —
#    state flows local→cluster, so apply through the API, not kubectl, so the
#    controller's state mirror sees it and reconciles). Test brain = no model.
log "creating e2e namespace + agent via the API"
kubectl create namespace "$AGENT_NS" --dry-run=client -o yaml | kubectl apply -f -
# The brain pod uses serviceAccountName: hades-brain, which is namespaced —
# create it (+ a RoleBinding to the pods/exec ClusterRole) in the agent's
# namespace BEFORE the agent is reconciled, so the brain Deployment's
# ReplicaSet doesn't get stuck in FailedCreate waiting on a missing SA. This
# is operator setup for any namespace that runs agents; the Helm chart
# creates it only in hades-system (the control-plane namespace).
kubectl -n "$AGENT_NS" create serviceaccount hades-brain --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$AGENT_NS" create rolebinding hades-brain --clusterrole=hades-brain --serviceaccount="$AGENT_NS":hades-brain --dry-run=client -o yaml | kubectl apply -f -
# Remove any brain/hands Deployments from a prior run so a stale ReplicaSet
# (stuck FailedCreate from a missing SA) doesn't block the fresh reconcile.
kubectl -n "$AGENT_NS" delete deploy brain-e2e hands-e2e --ignore-not-found 2>/dev/null || true
curl -sf -X POST http://127.0.0.1:${API_PORT}/hades/v1/resources \
    -H 'content-type: application/json' \
    -d '{"apiVersion":"hades.dev/v1alpha1","kind":"Home","metadata":{"namespace":"'"$AGENT_NS"'","name":"'"$AGENT_NAME"'-home"},"spec":{"size":"1Gi"}}' >/dev/null
curl -sf -X POST http://127.0.0.1:${API_PORT}/hades/v1/resources \
    -H 'content-type: application/json' \
    -d '{"apiVersion":"hades.dev/v1alpha1","kind":"Agent","metadata":{"namespace":"'"$AGENT_NS"'","name":"'"$AGENT_NAME"'"},"spec":{"homeRef":"'"$AGENT_NAME"'-home","defaultSession":"'"$AGENT_NAME"'-default","desiredState":"active","brain":{"mode":"test"}}}' >/dev/null

# 8. Trigger a reconcile (the controller is event-driven on state mutations,
#    but force one to be deterministic in CI).
log "POSTing a reconcile"
curl -sf -X POST http://127.0.0.1:${API_PORT}/hades/v1/reconcile >/dev/null || true

# 8. Assert the brain pod reaches Running.
log "waiting for brain-${AGENT_NAME} pod to reach Running"
kubectl -n "$AGENT_NS" wait --for=jsonpath='{.status.phase}=Running' pod -l "hades.dev/agent=${AGENT_NAME},hades.dev/role=brain" --timeout=180s \
    || { kubectl -n "$AGENT_NS" describe pod -l "hades.dev/role=brain"; fail "brain pod did not reach Running"; }
log "brain pod is Running"

# 9. Assert a home write lands on the PVC: exec into the hands pod and write.
log "waiting for hands-${AGENT_NAME} pod"
kubectl -n "$AGENT_NS" wait --for=jsonpath='{.status.phase}=Running' pod -l "hades.dev/agent=${AGENT_NAME},hades.dev/role=hands" --timeout=180s \
    || fail "hands pod did not reach Running"

log "writing a file to the home PVC via the hands pod"
HANDS_POD=$(kubectl -n "$AGENT_NS" get pod -l "hades.dev/agent=${AGENT_NAME},hades.dev/role=hands" -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$AGENT_NS" exec "$HANDS_POD" -- sh -c 'echo hello-from-hades > /home/agent/e2e-marker.txt' \
    || fail "could not exec into the hands pod to write the home"
log "marker written to /home/agent/e2e-marker.txt"

# Read it back to confirm it persisted on the PVC.
CONTENT=$(kubectl -n "$AGENT_NS" exec "$HANDS_POD" -- cat /home/agent/e2e-marker.txt 2>/dev/null || true)
[ "$CONTENT" = "hello-from-hades" ] || fail "home write did not persist (got: '$CONTENT')"
log "home write persisted on the PVC: '$CONTENT'"

log ""
log "✅ e2e passed: brain pod Running + home write landed on the PVC"

if [ "$KEEP_CLUSTER" = "1" ]; then
    log "KEEP_CLUSTER=1 — leaving kind cluster ${CLUSTER_NAME} running for debugging"
    log "  kubectl config use-context kind-${CLUSTER_NAME}"
else
    log "tearing down kind cluster ${CLUSTER_NAME}"
    kind delete cluster --name "$CLUSTER_NAME"
fi
