import { nameOf, type HadesResource } from "../domain/resources.js";
import type { BrainDriver } from "../ports/BrainDriver.js";
import type { EventStorePort } from "../ports/EventStore.js";

export type BrainDriverFactory = (mode: BrainMode) => BrainDriver;
export type BrainMode = "pi-sdk" | "test";

export class BrainService {
    constructor(
        private readonly events: EventStorePort,
        private readonly driverFactory: BrainDriverFactory,
    ) {}

    resolveMode(agent: HadesResource): BrainMode {
        const configured = process.env.HADES_BRAIN_MODE ?? agent.spec?.brain?.mode;
        if (!configured) return "pi-sdk";
        if (configured === "pi-sdk" || configured === "test") return configured;
        throw new Error(`Unsupported brain mode ${configured}`);
    }

    async run(agent: HadesResource, session: HadesResource, prompt: string, onToken?: (delta: string) => void): Promise<string> {
        const mode = this.resolveMode(agent);
        await this.events.append(nameOf(session), "brain.woke", { agent: nameOf(agent), mode });
        return this.driverFactory(mode).run({ agent, session, prompt, onToken });
    }
}
