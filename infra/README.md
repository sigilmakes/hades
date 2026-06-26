# Hades Deploy

Manifests for the Kubernetes-native Hades operator. The controller reconciles
Hades custom resources into standard Kubernetes objects (Deployments, PVCs,
CronJobs, Services, NetworkPolicies) — no hostPath, no single-node constructs.

## What's here

| File | Purpose |
|------|---------|
| `crds/hades.dev_resources.yaml` | All Hades custom resource definitions (`Agent`, `Home`, `Hands`, `Session`, `BrainBinding`, `Listener`, `Schedule`, `Run`, `Approval`, `CapabilityGrant`, `AgentClass`). |
| `namespace-rbac.yaml` | `hades-system` namespace, controller `ServiceAccount`, `ClusterRole`/`Binding` (CRDs + native objects the controller reconciles), and the `hades-data` PVC. |
| `local.yaml` | Single-pod manifest running the Hades API server (`hades serve`) on a local data volume. The simplest way to run the control plane in a cluster. |

## Node-count-agnostic by construction

The operator uses **only** standard Kubernetes API objects:

- ✅ `Deployment` (brains), `CronJob` (schedules), `PVC` (homes + control-plane data), `Service` (ClusterIP), `NetworkPolicy` + `RBAC` (capability projection).
- ❌ No `hostPath` volumes. No bare host processes. No `localhost:` ports that assume one node. No `nodeSelector` pinning to a single node.

k3s **is** Kubernetes (same API, `kubectl`, operators, CRDs), so single-node →
multi-node is a config change, never a code change:

1. **StorageClass swap.** The `hades-data` PVC and per-home PVCs leave
   `spec.storageClassName` unset so the cluster default applies. On single-node
   k3s that is `local-path`. To go multi-node, point the StorageClass at a
   shared provisioner (`longhorn`, `nfs`, `cephfs`) and recreate the PVCs —
   zero code change.
2. **Networking is unchanged.** `ClusterIP` services and `NetworkPolicy`
   resolve identically on one node or N.
3. **No node pinning.** The controller never assumes which node a brain/hands
   pod lands on.

## What the controller reconciles

| Hades resource | Native objects |
|----------------|----------------|
| `Home` | `PersistentVolumeClaim` (`home-<name>`) |
| `Agent` (active) | brain `Deployment` + `Service` (`brain-<name>`); model credentials mounted from a `Secret` via `envFrom` |
| `Agent` (ephemeral, completed) | cascade-delete brain/hands pods (via `ownerReferences`) |
| `Hands` | hands `Deployment` + `Service` + `NetworkPolicy` (brain→hands only, no egress) |
| `Schedule` (cron/interval) | `CronJob` (`sched-<name>`) |
| `CapabilityGrant` | logical policy (NetworkPolicy projection is a follow-on) |

## Applying

```bash
# 1. Install the CRDs
kubectl apply -f deploy/crds/hades.dev_resources.yaml

# 2. Namespace, RBAC, and the control-plane data PVC
kubectl apply -f deploy/namespace-rbac.yaml

# 3. Run the controller (reconcile loop). Set HADES_KUBE=1 to use the real
#    cluster client; otherwise it runs against an in-memory fake (dev/tests).
HADES_MODE=distributed HADES_KUBE=1 node dist/cli.js controller
```

Brain and hands pods are launched by the controller from the images named in
each resource's `spec.brain.image` / `spec.image` (defaults
`ghcr.io/hades-dev/hades-brain:dev` / `ghcr.io/hades-dev/hades-hands:dev`).
Build them from `src/brain-pod` and `src/hands-pod`.

## Status

The controller logic is fully tested against a `FakeKubeClient`. The live
cluster path (`@kubernetes/client-node`-backed `KubeClientNode`, enabled with
`HADES_KUBE=1`) is wired but not yet exercised against a real cluster — that
smoke test is outstanding work.
