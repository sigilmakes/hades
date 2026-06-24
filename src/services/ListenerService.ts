import { nameOf } from "../domain/resources.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { StateStorePort } from "../ports/StateStore.js";

export class ListenerService {
    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
    ) {}

    async reconcileListeners(): Promise<void> {
        for (const listener of this.state.list("Listener")) {
            const platform = listener.spec?.platform ?? "cli";
            listener.status = {
                ...(listener.status ?? {}),
                phase: platform === "discord" && !listener.spec?.secretRef ? "waitingForSecret" : "connected",
            };
            await this.events.append("system", "listener.connected", { listener: nameOf(listener), platform, phase: listener.status.phase });
        }
    }
}
