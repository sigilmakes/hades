# Hades Infra

Manifests, images, and the dev loop for the Kubernetes-native Hades operator.
The controller reconciles Hades custom resources into standard Kubernetes
objects (Deployments, PVCs, CronJobs, NetworkPolicies) — no hostPath, no
single-node constructs.

## Layout

| Path | Purpose |
|------|---------|
| `k8s/crds/hades.dev_resources.yaml` | All Hades custom resource definitions (`Agent`, `Home`, `Hands`, `Session`, `BrainBinding`, `Listener`, `Schedule`, `Run`, `Approval`, `CapabilityGrant`, `AgentClass`). |
| `k8s/namespace-rbac.yaml` | `hades-system` namespace, controller `ServiceAccount`, `ClusterRole`/`Binding`, and the `hades-data` PVC. |
| `k8s/api.yaml` | The control-plane `Deployment` + `Service` (runs `hades controller` with `HADES_KUBE=1`). |
| `docker/Dockerfile.api` | Control-plane image (API server + controller). |
| `docker/Dockerfile.brain` | Brain pod image (pi SDK model loop). |
| `docker/Dockerfile.hands` | Hands pod image (`sleep infinity` sandbox — the brain execs into it). |
| `kind/kind-config.template.yaml` | kind cluster config template (used by `scripts/dev-setup.sh`). |

## Dev loop

Dev is a kind cluster via Tilt — there is no in-process production path.

```bash
nix develop                  # node 24, kind, kubectl, tilt
npm install
bash scripts/dev-setup.sh    # creates the kind cluster
tilt up                       # builds images, applies manifests, live-updates
```

- API: http://localhost:7347
- Tilt dashboard: http://localhost:10350

`tilt down` stops services; `kind delete cluster --name hades` tears down the
cluster.

## What the controller reconciles

| Hades resource | Native objects |
|----------------|----------------|
| `Home` | `PersistentVolumeClaim` (`home-<name>`) |
| `Agent` (active) | brain `Deployment` + `Service` (`brain-<name>`); model credentials mounted from a `Secret` via `envFrom` |
| `Agent` (ephemeral, completed) | cascade-delete brain/hands pods (via `ownerReferences`) |
| `Hands` | hands `Deployment` + `NetworkPolicy` (no Service — the brain execs into the pod via the k8s API; no egress) |
| `Schedule` (cron/interval) | `CronJob` (`sched-<name>`) |
| `CapabilityGrant` | logical policy (NetworkPolicy projection is follow-on work) |

Brain and hands pods are launched by the controller from the images named in
each resource's `spec.brain.image` / `spec.image` (defaults
`hades-brain:latest` / `hades-hands:latest`, loaded into kind by Tilt).

## Node-count-agnostic by construction

The operator uses only standard Kubernetes API objects:

- ✅ `Deployment` (brains), `CronJob` (schedules), `PVC` (homes + control-plane data), `Service` (ClusterIP), `NetworkPolicy` + `RBAC`.
- ❌ No `hostPath` volumes. No bare host processes. No `localhost:` ports that assume one node. No `nodeSelector` pinning to a single node.

k3s **is** Kubernetes (same API, `kubectl`, operators, CRDs), so single-node →
multi-node is a config change, never a code change:

1. **StorageClass swap.** The `hades-data` PVC and per-home PVCs leave
   `spec.storageClassName` unset so the cluster default applies. To go
   multi-node, point the StorageClass at a shared provisioner (`longhorn`,
   `nfs`, `cephfs`) and recreate the PVCs — zero code change.
2. **Networking is unchanged.** `ClusterIP` services and `NetworkPolicy`
   resolve identically on one node or N.
3. **No node pinning.** The controller never assumes which node a pod lands on.
