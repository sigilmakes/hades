---
name: hades-conventions
description: Hades is a Kubernetes-native agent OS kernel, not an app. Use when editing src/, adding a resource kind, or wiring a capability. Encodes the kernel/userland boundary, the HTTP capability model, and the branch/test rules.
---

# Hades Conventions

Hades is an **operating system kernel** for agents, modelled on Linux + pi: it
governs + discovers + routes; it does not implement application logic. Maximize
extensibility the way a kernel does — stable interfaces, swappable userland.

## The kernel/userland boundary

The kernel's job, for any capability, is exactly three things:

1. **Govern** — reconcile a resource into k8s RBAC / NetworkPolicy / quotas.
2. **Discover** — inject what an agent needs to find a capability (env, status).
3. **Route** — wire a Service / endpoint so the brain can reach it.

The kernel **never interprets the body** of a capability. If you're tempted to
write a `fetch`, a GitHub client, or a browser into `src/`, stop — that's
userland. It belongs in a deployed image the kernel routes to, exactly as a
Linux device driver sits behind a stable syscall.

## HTTP is the unifying standard

Every capability is an HTTP endpoint. A `Connector` lets an agent *consume* one;
a `Skill` lets an agent *expose* one. Both are plain HTTP the kernel governs —
no bespoke wire protocol, no kernel-side parsing. New capability = new
Connector/Skill + a userland image.

## Adding a resource kind (the checklist)

1. Add the kind to `KINDS` in `src/domain/resources.ts`.
2. Add a CRD block to `infra/k8s/crds/hades.dev_resources.yaml` **and** copy it
   to `charts/hades/templates/crds.yaml` (Helm uses the same file).
3. Add a `buildX` pure function in `src/controller/builders.ts`.
4. Add `reconcileX` to `src/controller/KubeController.ts` + wire it into the
   `reconcile()` loop (order matters — build images before hands pods).
5. Add the kind to `HADES_KINDS` (so it's applied as a CRD with a finalizer)
   and to the `finalizeResource` cleanup if it owns native objects.
6. Add a `system.<kind>` event on reconcile.
7. If agents create it at runtime, add a capability-gated syscall to
   `SyscallService.ts` + the capability to the default surface + an API route.
8. Test it in `test/<kind>.test.js` against `FakeKubeClient`.

## Ports-and-adapters

- `src/ports/` = interfaces (`KubeClient`, `StateStore`, `Policy`, `HandsBackend`…).
- `src/adapters/` = implementations (`KubeClientNode`, `SqliteStateStore`…).
- The controller reasons about Hades resources + ports; only adapters touch k8s.
- In-process adapters are test injections, not a peer runtime. There is one
  runtime (`HadesRuntime`), no "mode".

## Branch + test rules

- **Never merge feature branches to `main`** — exploration only. Stack on
  `feature/integration` (the folded line), not off `main`.
- `npm run build` (tsc, ESM, `.js` imports) + `npm test` must stay green.
- `npm run lint` must stay at 0 errors (warnings for `Record<string, any>` on
  open-ended resource specs are acceptable).
- The brain-side adapters (`HadesToolRegistrar`, `ConnectorToolRegistrar`) are
  userland — swappable, shipped in the brain image, not kernel logic.

## Gotchas learned the hard way

- A `const` referenced by a top-level CLI dispatch must be defined *above* the
  dispatch (TDZ) — or it throws "Cannot access X before initialization".
- Two `Hands` resources targeting the same `hands-<agent>` Deployment
  overwrite each other; the system `home-shell` Hands inherits the agent's
  `handsImageRef`/`security` — set those on the **Agent**, not a duplicate Hands.
- `FakeKubeClient.ensure` stamps a synthetic uid on Hades CRDs; `get` returns
  the stored object (not a synthesized one) so ownerReferences + finalizers
  resolve in tests.

See also: [docs/development.md](../../../docs/development.md), [docs/connectors.md](../../../docs/connectors.md).
