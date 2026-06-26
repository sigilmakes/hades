import type { Metrics } from "../../ports/Observability.js";

/**
 * A label set, canonicalized to a stable string for map keys. Empty labels
 * -> the empty key (an unlabeled series).
 */
function labelKey(labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return "";
    return Object.keys(labels).sort().map((k) => `${k}="${escape(labels[k])}"`).join(",");
}
function escape(v: string): string {
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

interface CounterSeries {
    value: number;
}
interface GaugeSeries {
    value: number;
}
interface HistogramSeries {
    sum: number;
    count: number;
    /** Cumulative bucket counts keyed by upper bound (le). */
    buckets: Map<number, number>;
}

/** Metadata for a registered metric (name -> type + help). */
interface MetricMeta {
    type: "counter" | "gauge" | "histogram";
    help: string;
    /** Histogram upper bounds (le), shared by every series of this metric. */
    buckets?: number[];
}

/**
 * An in-memory Prometheus metrics adapter. No external dependency — it
 * implements the counter/gauge/histogram primitives and renders the standard
 * Prometheus text exposition format for `/metrics`.
 *
 * Histograms use fixed default buckets (SLO-style) unless overridden at first
 * observation. This is kernel observability: reconcile counts/errors/latency
 * and pod-phase gauges. The kernel never records application metrics.
 *
 * Not safe for high-cardinality labels (each label set is a series); the
 * kernel's label space is fixed and small (kind, result, phase) so this is
 * fine. A production deployment wanting remote-write would swap this adapter
 * for an OpenMetrics client behind the same {@link Metrics} port.
 */
export class PrometheusMetrics implements Metrics {
    private readonly counters = new Map<string, Map<string, CounterSeries>>(); // name -> labelKey -> series
    private readonly gauges = new Map<string, Map<string, GaugeSeries>>();
    private readonly histograms = new Map<string, Map<string, HistogramSeries>>();
    private readonly meta = new Map<string, MetricMeta>();
    private readonly defaultBuckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

    private ensureMeta(name: string, type: MetricMeta["type"], help: string, buckets?: number[]): void {
        if (!this.meta.has(name)) this.meta.set(name, { type, help, buckets: buckets ?? this.defaultBuckets });
    }

    inc(name: string, labels?: Record<string, string>, n: number = 1): void {
        if (n === 0) return;
        this.ensureMeta(name, "counter", `Counter ${name}`);
        const key = labelKey(labels);
        let seriesMap = this.counters.get(name);
        if (!seriesMap) { seriesMap = new Map(); this.counters.set(name, seriesMap); }
        const series = seriesMap.get(key) ?? { value: 0 };
        series.value += n;
        seriesMap.set(key, series);
    }

    observe(name: string, labels: Record<string, string> | undefined, value: number): void {
        this.ensureMeta(name, "histogram", `Histogram ${name}`);
        const meta = this.meta.get(name)!;
        const buckets = meta.buckets ?? this.defaultBuckets;
        const key = labelKey(labels);
        let seriesMap = this.histograms.get(name);
        if (!seriesMap) { seriesMap = new Map(); this.histograms.set(name, seriesMap); }
        let series = seriesMap.get(key);
        if (!series) {
            series = { sum: 0, count: 0, buckets: new Map(buckets.map((b) => [b, 0])) };
            seriesMap.set(key, series);
        }
        series.sum += value;
        series.count += 1;
        for (const b of buckets) if (value <= b) series.buckets.set(b, (series.buckets.get(b) ?? 0) + 1);
    }

    set(name: string, labels: Record<string, string> | undefined, value: number): void {
        this.ensureMeta(name, "gauge", `Gauge ${name}`);
        const key = labelKey(labels);
        let seriesMap = this.gauges.get(name);
        if (!seriesMap) { seriesMap = new Map(); this.gauges.set(name, seriesMap); }
        seriesMap.set(key, { value });
    }

    render(): string {
        const lines: string[] = [];
        const names = new Set([...this.meta.keys()]);
        for (const name of [...names].sort()) {
            const meta = this.meta.get(name)!;
            lines.push(`# HELP ${name} ${meta.help}`);
            lines.push(`# TYPE ${name} ${meta.type}`);
            if (meta.type === "counter") {
                for (const [key, series] of this.counters.get(name) ?? []) {
                    lines.push(formatLine(name, key, series.value));
                }
            } else if (meta.type === "gauge") {
                for (const [key, series] of this.gauges.get(name) ?? []) {
                    lines.push(formatLine(name, key, series.value));
                }
            } else {
                for (const [key, series] of this.histograms.get(name) ?? []) {
                    for (const [le, count] of [...series.buckets.entries()].sort((a, b) => a[0] - b[0])) {
                        lines.push(formatLine(`${name}_bucket`, mergeLabels(key, `le="${le}"`), count));
                    }
                    lines.push(formatLine(`${name}_bucket`, mergeLabels(key, `le="+Inf"`), series.count));
                    lines.push(formatLine(`${name}_sum`, key, series.sum));
                    lines.push(formatLine(`${name}_count`, key, series.count));
                }
            }
        }
        return lines.join("\n") + "\n";
    }
}

/** Format `name{labels} value` (or `name value` when unlabeled). */
function formatLine(name: string, labelKey: string, value: number): string {
    return labelKey ? `${name}{${labelKey}} ${value}` : `${name} ${value}`;
}

/** Merge a series's existing label set with an extra `le=...` fragment. */
function mergeLabels(existing: string, extra: string): string {
    return existing ? `${existing},${extra}` : extra;
}
