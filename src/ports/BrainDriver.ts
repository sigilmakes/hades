import type { HadesResource } from "../domain/resources.js";

export type BrainRunInput = {
    agent: HadesResource;
    session: HadesResource;
    prompt: string;
    /** Optional token streaming callback. When provided, the driver emits
     * incremental reply text as it's produced (for SSE / WebSocket attach). */
    onToken?: (delta: string) => void;
};

export interface BrainDriver {
    readonly mode: string;
    run(input: BrainRunInput): Promise<string>;
}
