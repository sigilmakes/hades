import type { HadesKind } from "../domain/resources.js";

/**
 * Structured logging port. The kernel reports its own lifecycle through this
 * (reconcile cycles, shutdown, controller events) — observability of the
 * kernel itself, like `/proc` or `dmesg`. It is NOT application logging: the
 * kernel never interprets a capability body, so it has no business log lines.
 *
 * Opt-in: the default is a {@link noopLogger} so tests and dev that don't
 * inject a logger keep working unchanged. A production runtime injects a
 * pino-backed adapter ({@link ../adapters/logging/PinoLogger.ts}) for
 * shippable JSON + request ids.
 *
 * `child` derives a logger with bound context (a request id, a reconcile
 * cycle) so downstream logs are correlatable — the structured equivalent of
 * prefixing every console line.
 */
export interface Logger {
    /** Debug detail; off in production unless diagnosing. */
    debug(msg: string, fields?: Record<string, unknown>): void;
    /** Normal operation: startup, shutdown, scheduled events. */
    info(msg: string, fields?: Record<string, unknown>): void;
    /** Something unexpected but non-fatal (caught error, retry). */
    warn(msg: string, fields?: Record<string, unknown>): void;
    /** A failure that broke an operation (logged, not thrown). */
    error(msg: string, fields?: Record<string, unknown>): void;
    /** Derive a logger with bound context fields merged onto every line. */
    child(fields: Record<string, unknown>): Logger;
}

/** A logger that discards everything — the default when none is injected. */
export const noopLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
};

/**
 * Metrics port — the kernel's self-report of reconcile + workload state, in
 * Prometheus exposition format. Like {@link Logger}, this is kernel
 * observability (reconcile counts/errors/latency, pod phases by kind), not
 * application metrics. The kernel never sees agent business metrics.
 *
 * A production runtime injects a real adapter ({@link ../adapters/metrics/PrometheusMetrics.ts});
 * tests inject the default {@link noopMetrics} or read a captured one.
 */
export interface Metrics {
    /** Increment a counter by `n` (default 1). Counters never decrease. */
    inc(name: string, labels?: Record<string, string>, n?: number): void;
    /** Observe a value into a histogram (latency, sizes). */
    observe(name: string, labels: Record<string, string> | undefined, value: number): void;
    /** Set a gauge to an absolute value (pod phases, queue depth). */
    set(name: string, labels: Record<string, string> | undefined, value: number): void;
    /** Render the current metrics in Prometheus text exposition format. */
    render(): string;
}

/** A metrics sink that records nothing — the default when none is injected. */
export const noopMetrics: Metrics = {
    inc: () => {},
    observe: () => {},
    set: () => {},
    render: () => "# hades metrics disabled (no metrics adapter injected)\n",
};

/**
 * The metric names the kernel reports. Centralized so the controller + adapter
 * agree and a typo can't silently drop a series.
 */
export const METRIC = {
    reconcileTotal: "hades_reconcile_total",
    reconcileErrors: "hades_reconcile_errors_total",
    reconcileSeconds: "hades_reconcile_seconds",
    resourceReconciled: "hades_resource_reconciled_total",
    podPhase: "hades_pod_phase",
} as const;

/** Label keys for consistency across call sites. */
export const LABEL = {
    kind: "kind",
    result: "result",
    phase: "phase",
} as const;

/** Convenience: the set of kinds the controller reaps metrics for. */
export const METRIC_KINDS: readonly HadesKind[] = [
    "Agent", "Home", "Hands", "Listener", "Schedule", "Connector", "HandsImage", "Skill",
];
