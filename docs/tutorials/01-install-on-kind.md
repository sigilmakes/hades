# Tutorial 01 — Install Hades on kind

Goal: a running Hades control plane on a local Kubernetes cluster, verified
end-to-end. ~10 minutes.

This installs the Helm chart (15 CRDs + RBAC + the control plane), creates an
agent, and confirms the brain pod reaches `Running` and a home write lands on
its PVC.

## 1. Prerequisites

You need `nix` (recommended — provides everything) **or** Docker + `kind` +
`kubectl` + `helm` installed directly.

```bash
# With nix (provides kind, helm, kubectl in a shell):
nix shell nixpkgs#kind nixpkgs#kubernetes-helm nixpkgs#kubectl
# Verify:
kind version && helm version && kubectl version --client
```

## 2. Create a kind cluster

```bash
kind create cluster --name hades
kubectl config use-context kind-hades
```

## 3. Build + load the images

The control plane and brain images are built from the repo and loaded into
kind (imagePullPolicy is `Never` for local dev).

```bash
# Control plane (API + controller + web UI):
docker build -t hades-api:latest -f infra/docker/Dockerfile.api .
# Brain (one per agent):
docker build -t hades-brain:latest -f infra/docker/Dockerfile.brain .
# Load into kind:
kind load docker-image hades-api:latest --name hades
kind load docker-image hades-brain:latest --name hades
```

## 4. Install the Helm chart

```bash
helm install hades ./charts/hades --namespace hades-system --create-namespace \
    --set image.pullPolicy=Never --set image.repository=hades-api --set image.tag=latest
```

Expected:

```text
NAME: hades
LAST DEPLOYED: ...
NAMESPACE: hades-system
STATUS: deployed
REVISION: 1
```

Wait for the control plane:

```bash
kubectl -n hades-system rollout status deployment/hades-api
```

Expected: `deployment "hades-api" successfully rolled out`.

The API now serves on port 7347 inside the cluster. Port-forward it:

```bash
kubectl -n hades-system port-forward svc/hades-api 7347:7347 &
```

Check health + metrics:

```bash
curl -s http://127.0.0.1:7347/healthz        # {"ok": true}
curl -s http://127.0.0.1:7347/metrics | head  # hades_reconcile_total ...
```

## 5. Create an agent namespace + the brain SA

The brain pod uses `serviceAccountName: hades-brain`, which is **namespaced**.
The chart creates it in `hades-system`; any other namespace that runs agents
needs it too (plus a RoleBinding to the `hades-brain` ClusterRole for pods/exec):

```bash
kubectl create namespace agent-demo
kubectl -n agent-demo create serviceaccount hades-brain
kubectl -n agent-demo create rolebinding hades-brain \
    --clusterrole=hades-brain --serviceaccount=agent-demo:hades-brain
```

## 6. Create an agent via the API

The control plane is the source of truth — state flows local→cluster, so
create the agent through the API (not `kubectl apply`), so the controller's
state mirror sees it and reconciles.

```bash
curl -s -X POST http://127.0.0.1:7347/hades/v1/resources \
    -H 'content-type: application/json' \
    -d '{"apiVersion":"hades.dev/v1alpha1","kind":"Home","metadata":{"namespace":"agent-demo","name":"demo-home"},"spec":{"size":"1Gi"}}' >/dev/null

curl -s -X POST http://127.0.0.1:7347/hades/v1/resources \
    -H 'content-type: application/json' \
    -d '{"apiVersion":"hades.dev/v1alpha1","kind":"Agent","metadata":{"namespace":"agent-demo","name":"demo"},"spec":{"homeRef":"demo-home","defaultSession":"demo-default","desiredState":"active","brain":{"mode":"test"}}}' >/dev/null

# Force a reconcile (the controller is event-driven, but this is deterministic):
curl -s -X POST http://127.0.0.1:7347/hades/v1/reconcile >/dev/null
```

Wait for the brain pod:

```bash
kubectl -n agent-demo wait --for=jsonpath='{.status.phase}=Running}' \
    pod -l "hades.dev/agent=demo,hades.dev/role=brain" --timeout=180s
```

Expected: `pod/brain-demo-... condition met`.

## 7. Verify a home write lands on the PVC

```bash
HANDS=$(kubectl -n agent-demo get pod -l "hades.dev/agent=demo,hades.dev/role=hands" -o jsonpath='{.items[0].metadata.name}')
kubectl -n agent-demo exec "$HANDS" -- sh -c 'echo hello-from-hades > /home/agent/marker.txt'
kubectl -n agent-demo exec "$HANDS" -- cat /home/agent/marker.txt
```

Expected:

```text
hello-from-hades
```

That file lives on the agent's PVC — it survives a pod restart.

## 8. List resources

```bash
curl -s http://127.0.0.1:7347/hades/v1/agents | jq '.[].metadata.name'
```

Expected: `["demo"]` (plus the system agents in `hades-system`).

## 9. Clean up

```bash
kind delete cluster --name hades
```

## What you've seen

- The Helm chart installs CRDs + RBAC + a control plane that reconciles.
- Agents are created via the API; the controller provisions brain + hands pods.
- The brain execs into the hands pod; the hands pod owns the home PVC.
- `/metrics` exposes the kernel observing itself.

Next: **[02 — A Discord bot agent](02-discord-bot.md)**.

---

*Tip: `scripts/e2e-kind.sh` automates this entire tutorial as a CI-ready
script — run it with `nix shell nixpkgs#kind nixpkgs#kubernetes-helm nixpkgs#kubectl -c scripts/e2e-kind.sh`.*
