# Hades Deploy

Manifests for the deploy (distributed) mode: a Kubernetes-native Hades operator.
This is the substrate for P1–P6 of the distributed roadmap. **P0 ships the
seam only** — the namespace/RBAC + data PVC; no brain/hands pods yet.

## What's here

| File | Purpose |
|------|---------|
| `crds/hades.dev_resources.yaml` | All Hades CRDs (preserved from the simulation). |
| `namespace-rbac.yaml` | `hades-system` namespace, controller `ServiceAccount`, `ClusterRole`/`Binding`, and the `hades-data` PVC. |
| `local.yaml` | Legacy single-pod dev manifest (the simulation, containerized). Kept for the "one process" path. |

## The substrate contract (D3: node-count-agnostic)

The operator uses **only** standard Kubernetes API objects. There is no
single-node-only construct:

- ✅ `Deployment` (brains), `Job`/`CronJob` (hands, schedules), `PVC` (homes),
  `Service` (ClusterIP), `NetworkPolicy` + `RBAC` (capability projection).
- ❌ No `hostPath` volumes. No bare host processes. No `localhost:` ports that
  assume one node. No `nodeSelector` pinning to a single node.

Because k3s **is** k8s (same API, kubectl, operators, CRDs), the
single-node → multi-node path is a config change, not a rewrite:

1. **StorageClass swap.** The `hades-data` PVC (and per-home PVCs, P4) leave
   `spec.storageClassName` unset so the cluster default applies. On single-node
   k3s that is `local-path`. To go multi-node, set the StorageClass to a shared
   provisioner (`longhorn`, `nfs`, `cephfs`) and recreate the PVCs — **zero
   code change**. This is the "dumb as rocks" migration: join nodes + swap the
   StorageClass.
2. **Networking is unchanged.** `ClusterIP` services and `NetworkPolicy`
   resolve identically on one node or N.
3. **No node pinning.** The controller never assumes which node a brain/hands
   pod lands on.

## Applying

```bash
kubectl apply -f deploy/crds/hades.dev_resources.yaml
kubectl apply -f deploy/namespace-rbac.yaml
# (P4) controller Deployment goes here once the controller exists.
```

## Status (P0)

P0 ships **the seam, not the pods**. `hades controller` runs the reconcile loop
in-process (the dev-mode kernel reused), verifying the wiring shape against
real stores. P1–P4 replace stub adapters with pod-backed ones:

- **P1**: brain pod (HTTP `/run` + SSE).
- **P2**: hands pod + MCP Streamable HTTP wire.
- **P3**: durable event store (sqlite-on-PVC → Postgres).
- **P4**: real controller (CRDs → native k8s objects via `@kubernetes/client-node`).
- **P5**: milestone — one agent end-to-end over HTTP on local k3s.
- **P6**: distributed `spawnAgent` (pod-per-spawn).

See `scratchpad/plans/hades-distributed-roadmap/` for the full plan.
