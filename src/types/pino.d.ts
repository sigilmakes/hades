/**
 * Ambient type shim for `pino`, which is an optional runtime dependency.
 *
 * Pino is lazy-loaded by {@link ../adapters/logging/PinoLogger.ts} via a
 * dynamic `import("pino")`; if it isn't installed the loader returns
 * `undefined` and the runtime falls back to the noop logger. This declaration
 * lets TypeScript resolve the `import("pino")` type without making pino a
 * hard `dependency` — keeping structured logging opt-in (production control
 * planes install pino; dev/tests do not).
 *
 * The shape mirrors only the slice Hades uses. Install the real `pino` +
 * `@types/pino` for full type safety in production wiring.
 */
declare module "pino" {
    export interface PinoLogger {
        debug(msg: string, fields?: Record<string, unknown>): void;
        info(msg: string, fields?: Record<string, unknown>): void;
        warn(msg: string, fields?: Record<string, unknown>): void;
        error(msg: string, fields?: Record<string, unknown>): void;
        child(fields: Record<string, unknown>): PinoLogger;
    }
    export interface PinoOptions {
        level?: string;
        base?: Record<string, unknown> | null;
    }
    export interface TransportOptions {
        target?: string;
        options?: Record<string, unknown>;
    }
    type PinoFactory = {
        (options?: PinoOptions, transport?: TransportOptions): PinoLogger;
        transport?: (opts: TransportOptions) => unknown;
    };
    // The CommonJS default export is the factory.
    const pino: PinoFactory;
    export default pino;
}
