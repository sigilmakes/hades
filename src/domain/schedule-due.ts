import { Cron } from "croner";

export type ScheduleType = "once" | "interval" | "cron";

export type ScheduleSpec = {
    readonly type?: ScheduleType;
    readonly schedule?: string;
};

/**
 * Pure due check. No side effects, no clocks beyond the passed `now`.
 *
 * - once: ISO timestamp due when now >= time; `+Ns/m/h` due when now >= createdAt + duration.
 * - interval: due when now >= (lastFiredAt ?? createdAt) + duration.
 * - cron: 5-field expression; due when croner reports an occurrence in (lastFiredAt ?? createdAt, now].
 */
export function isScheduleDue(spec: ScheduleSpec, lastFiredAt: string | undefined, createdAt: string, now: number): boolean {
    const type = (spec.type ?? "once") as ScheduleType;
    const schedule = spec.schedule ?? "";
    if (!schedule) return false;

    if (type === "once") {
        if (schedule.startsWith("+")) {
            const ms = relativeMs(schedule);
            return Number.isFinite(ms) && now >= Date.parse(createdAt) + ms;
        }
        const time = Date.parse(schedule);
        return Number.isFinite(time) && now >= time;
    }

    if (type === "interval") {
        const ms = relativeMs(schedule);
        if (!Number.isFinite(ms)) throw new Error(`Invalid interval schedule: ${schedule}`);
        const base = lastFiredAt ? Date.parse(lastFiredAt) : Date.parse(createdAt);
        return now >= base + ms;
    }

    if (type === "cron") {
        const cron = parseCron(schedule);
        const minuteDate = new Date(now);
        minuteDate.setSeconds(0, 0);
        if (!cron.match(minuteDate)) return false;
        const minuteStart = Math.floor(now / 60_000) * 60_000;
        const lastMs = lastFiredAt ? Date.parse(lastFiredAt) : 0;
        return lastMs < minuteStart;
    }

    return false;
}

export function parseCron(pattern: string): Cron {
    try {
        return new Cron(pattern);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid cron expression ${JSON.stringify(pattern)}: ${message}`);
    }
}

export function relativeMs(value: string): number {
    const body = value.startsWith("+") ? value.slice(1) : value;
    const amount = Number(body.slice(0, -1));
    const unit = body.at(-1);
    if (!Number.isFinite(amount)) return Number.NaN;
    if (unit === "s") return amount * 1000;
    if (unit === "m") return amount * 60_000;
    if (unit === "h") return amount * 3600_000;
    return Number.NaN;
}