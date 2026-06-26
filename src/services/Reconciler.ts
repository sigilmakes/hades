import type { StateStorePort } from "../ports/StateStore.js";
import { AgentService } from "./AgentService.js";
import { HomeService } from "./HomeService.js";
import { ListenerService } from "./ListenerService.js";
import { MessageService } from "./MessageService.js";
import { ScheduleService } from "./ScheduleService.js";
import { SystemAgents } from "./SystemAgents.js";

export class Reconciler {
    constructor(
        private readonly state: StateStorePort,
        private readonly homes: HomeService,
        private readonly agents: AgentService,
        private readonly listeners: ListenerService,
        private readonly schedules: ScheduleService,
        private readonly messages: MessageService,
        private readonly systemAgents?: SystemAgents,
    ) {}

    async reconcile(): Promise<void> {
        if (this.systemAgents) await this.systemAgents.reconcile();
        await this.homes.reconcileHomes();
        await this.agents.reconcileAgents();
        await this.listeners.reconcileListeners();
        await this.schedules.reconcileSchedules((agentName, text, options) => this.messages.messageAgent(agentName, text, options));
        await this.state.save();
    }
}
