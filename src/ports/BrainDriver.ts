import type { HadesResource } from "../domain/resources.js";

export type BrainRunInput = {
    agent: HadesResource;
    session: HadesResource;
    prompt: string;
};

export interface BrainDriver {
    readonly mode: string;
    run(input: BrainRunInput): Promise<string>;
}
