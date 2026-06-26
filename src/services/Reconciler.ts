import type { StateStorePort } from "../ports/StateStore.js";
import { type AgentService } from "./AgentService.js";
import { type HomeService } from "./HomeService.js";
import { type ListenerService } from "./ListenerService.js";
import { type MessageService } from "./MessageService.js";
import { type ScheduleService } from "./ScheduleService.js";
import { type SystemAgents } from "./SystemAgents.js";

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
