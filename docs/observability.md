# Observability

Hades reports its **own** state — the kernel observing itself, like `/proc` or
`dmesg`. It never records application metrics: the kernel does not interpret a
capability body, so it has no business metrics to emit. What it does expose is
control-plane health: reconcile counts and latency, reconcile errors, and the
phases of the workloads it supervises.

## Structured logging

The kernel logs through a `Logger` port
(`src/ports/Observability.ts`). The default is `noopLogger` — dev, tests, and
the offline demo produce no log output. A production control plane injects a
pino-backed adapter (`src/adapters/logging/PinoLogger.ts`) for shippable NDJSON
with bound context (reconcile cycle, request id).

`hades serve` and `hades controller` inject pino + Prometheus automatically;
short-lived commands (`get`, `apply`, `say`, …) keep the noop logger so their
output stays quiet. Disable with `HADES_OBSERVABILITY=off`.

```bash
HADES_LOG_LEVEL=debug         # trace|debug|info|warn|error (default info)
HADES_LOG_PRETTY=1            # pretty stdout for dev; NDJSON by default
HADES_OBSERVABILITY=off       # disable both logging and /metrics
```

Pino is an **optional** dependency (`optionalDependencies` in `package.json`):
if it isn't installed the runtime falls back to `noopLogger` without throwing.
Install `pino` in the production image to get structured logs.

## The `/metrics` endpoint

The API exposes `GET /metrics` in Prometheus text exposition format. It is
backed by a `Metrics` port (`src/ports/Observability.ts`) implemented in memory
by `PrometheusMetrics` — no external dependency. Wire a `ServiceMonitor` (or
scrape `/metrics` directly) in production.

### Exposed series

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `hades_reconcile_total` | counter | — | reconcile passes started |
| `hades_reconcile_errors_total` | counter | — | reconcile passes that threw |
| `hades_reconcile_seconds` | histogram | — | reconcile pass latency |
| `hades_resource_reconciled_total` | counter | `kind` | resources reconciled by kind (Agent, Home, Hands, …) |
| `hades_pod_phase` | gauge | `kind`, `phase` | count of agents/hands in each status phase |

The label space is fixed and small (kind, result, phase) — deliberately, so
the series count is bounded. A deployment wanting remote-write would swap the
`PrometheusMetrics` adapter for an OpenMetrics client behind the same `Metrics`
port.

```text
# HELP hades_reconcile_total Counter hades_reconcile_total
# TYPE hades_reconcile_total counter
hades_reconcile_total 142
# HELP hades_reconcile_errors_total Counter hades_reconcile_errors_total
# TYPE hades_reconcile_errors_total counter
hades_reconcile_errors_total 2
# HELP hades_pod_phase Gauge hades_pod_phase
# TYPE hades_pod_phase gauge
hades_pod_phase{kind="Agent",phase="active"} 3
hades_pod_phase{kind="Hands",phase="ready"} 3
```

## Why this is the kernel's job

Observability of the control plane itself — "how many reconciles, how fast,
did any fail, are the pods Running" — is kernel self-report, the same role
`/proc` serves for Linux. Application-level metrics (requests served by a
Skill, tokens consumed by a brain) belong to the **userland** images the kernel
routes to, surfaced through their own endpoints. The kernel governs + discovers
+ routes; it does not interpret capability bodies, so it has no business
metrics to emit.

See also: [Control Plane](control-plane.md), [Security](security.md).
