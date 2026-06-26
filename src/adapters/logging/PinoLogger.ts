import type { Logger } from "../../ports/Observability.js";

/** A pino logger instance (the slice we use). */
interface PinoInstance {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
    child(fields: Record<string, unknown>): PinoInstance;
}

/**
 * A {@link Logger} backed by a real pino instance. Construct via the async
 * {@link createPinoLogger} factory (which lazy-loads pino) so the synchronous
 * code paths never pull pino in — the same lazy-adapter pattern the sqlite
 * stores use. Pino is an optional dependency: if absent, the factory returns
 * `undefined` and the runtime falls back to {@link noopLogger}.
 *
 * Pino writes NDJSON to stdout by default; wire a transport in production.
 */
export class PinoLogger implements Logger {
    constructor(private readonly pino: PinoInstance) {}

    debug(msg: string, fields?: Record<string, unknown>): void { this.pino.debug(msg, fields ?? {}); }
    info(msg: string, fields?: Record<string, unknown>): void { this.pino.info(msg, fields ?? {}); }
    warn(msg: string, fields?: Record<string, unknown>): void { this.pino.warn(msg, fields ?? {}); }
    error(msg: string, fields?: Record<string, unknown>): void { this.pino.error(msg, fields ?? {}); }
    child(fields: Record<string, unknown>): Logger { return new PinoLogger(this.pino.child(fields)); }
}

/**
 * Lazy-load pino and construct a {@link PinoLogger}. Returns `undefined` when
 * pino isn't installed so the runtime can fall back to {@link noopLogger}
 * without throwing — structured logging is opt-in, not required.
 *
 * @param level  pino log level (default `info`).
 * @param pretty pretty-print to stdout (dev); off in production.
 */
export async function createPinoLogger(
    level: string = "info",
    pretty: boolean = false,
): Promise<PinoLogger | undefined> {
    try {
        const pinoModule: typeof import("pino") = await import("pino");
        const pino = pinoModule.default ?? (pinoModule as unknown as typeof pinoModule.default);
        const transport = pretty && pino.transport
            ? pino.transport({ target: "pino-pretty", options: { colorize: true } })
            : undefined;
        const instance = typeof pino === "function"
            ? pino({ level, base: { component: "hades" } }, transport)
            : undefined;
        return instance ? new PinoLogger(instance as PinoInstance) : undefined;
    } catch {
        return undefined; // pino absent — caller falls back to noop.
    }
}
