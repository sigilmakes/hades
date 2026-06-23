import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { EventStore } from "./events.js";
import { StateStore } from "./state.js";
import { BrainRuntime } from "./brain.js";
import { PolicyEngine } from "./policy.js";

export class HadesRuntime {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.state = new StateStore(dataDir);
        this.events = new EventStore(dataDir);
        this.brain = new BrainRuntime({ state: this.state, events: this.events, dataDir });
    }

    async init() {
        await this.state.init();
        await this.events.init();
        return this;
    }

    async apply(resource) {
        const applied = await this.state.apply(resource);
        await this.events.append("system", "resource.applied", { kind: resource.kind, namespace: applied.metadata.namespace, name: applied.metadata.name });
        return applied;
    }

    async reconcile() {
        await this.reconcileHomes();
        await this.reconcileAgents();
        await this.reconcileListeners();
        await this.reconcileSchedules();
        await this.state.save();
    }

    async reconcileHomes() {
        for (const home of this.state.list("Home")) {
            const namespace = home.metadata.namespace;
            const homePath = home.spec?.path ?? path.join(this.dataDir, "homes", namespace, home.metadata.name);
            for (const dir of home.spec?.layout?.create ?? ["vault", "bin", "cron.d", "projects", "skills", "inbox", "outbox"]) {
                await mkdir(path.join(homePath, dir), { recursive: true });
            }
            home.status = { ...(home.status ?? {}), phase: "ready", path: homePath };
            await this.events.append("system", "home.ready", { home: home.metadata.name, path: homePath });
        }
    }

    async reconcileAgents() {
        for (const agent of this.state.list("Agent")) {
            const namespace = agent.metadata.namespace;
            const sessionName = agent.spec?.defaultSession ?? `${agent.metadata.name}-default`;
            if (!this.state.findByName("Session", sessionName, namespace)) {
                await this.state.apply({
                    apiVersion: "hades.dev/v1alpha1",
                    kind: "Session",
                    metadata: { namespace, name: sessionName },
                    spec: { agentRef: agent.metadata.name, logRef: sessionName },
                    status: { phase: "idle" },
                });
                await this.events.append(sessionName, "session.created", { agent: agent.metadata.name });
            }
            if (agent.spec?.desiredState === "active" && !this.state.findByName("BrainBinding", `${agent.metadata.name}-default`, namespace)) {
                await this.state.apply({
                    apiVersion: "hades.dev/v1alpha1",
                    kind: "BrainBinding",
                    metadata: { namespace, name: `${agent.metadata.name}-default` },
                    spec: { agentRef: agent.metadata.name, sessionRef: sessionName, image: "ghcr.io/sigilmakes/hades-brain-pi:dev" },
                    status: { phase: "ready", podName: `brain-${agent.metadata.name}-local` },
                });
            }
            if (!this.state.findByName("Hands", `${agent.metadata.name}-home-shell`, namespace)) {
                await this.state.apply({
                    apiVersion: "hades.dev/v1alpha1",
                    kind: "Hands",
                    metadata: { namespace, name: `${agent.metadata.name}-home-shell` },
                    spec: { agentRef: agent.metadata.name, type: "home-toolbox", mode: "exclusive-home", homeRef: agent.spec?.homeRef },
                    status: { phase: "ready", podName: `hands-${agent.metadata.name}-local` },
                });
            }
            agent.status = { ...(agent.status ?? {}), phase: agent.spec?.desiredState ?? "active", session: sessionName };
        }
    }

    async reconcileListeners() {
        for (const listener of this.state.list("Listener")) {
            const platform = listener.spec?.platform ?? "cli";
            listener.status = {
                ...(listener.status ?? {}),
                phase: platform === "discord" && !listener.spec?.secretRef ? "waitingForSecret" : "connected",
            };
            await this.events.append("system", "listener.connected", { listener: listener.metadata.name, platform, phase: listener.status.phase });
        }
    }

    async reconcileSchedules() {
        for (const schedule of this.state.list("Schedule")) {
            schedule.status ??= {};
            schedule.status.phase ??= "pending";
            if (schedule.spec?.type === "once" && !schedule.status.firedAt && isDue(schedule.spec.schedule)) {
                await this.fireSchedule(schedule);
            }
        }
    }

    async fireSchedule(schedule) {
        const namespace = schedule.metadata.namespace;
        const agent = this.state.findByName("Agent", schedule.spec.agentRef, namespace);
        if (!agent) throw new Error(`Schedule ${schedule.metadata.name} references missing agent ${schedule.spec.agentRef}`);
        const session = this.state.findByName("Session", schedule.spec.session ?? agent.spec?.defaultSession ?? `${agent.metadata.name}-default`, namespace);
        await this.events.append(session.metadata.name, "schedule.fired", { schedule: schedule.metadata.name });
        schedule.status.firedAt = new Date().toISOString();
        schedule.status.phase = "completed";
        await this.messageAgent(agent.metadata.name, schedule.spec.prompt ?? `Schedule ${schedule.metadata.name} fired`, { namespace, origin: { kind: "Schedule", name: schedule.metadata.name } });
    }

    async messageAgent(agentName, text, options = {}) {
        const namespace = options.namespace ?? "agent-wren";
        const agent = this.state.findByName("Agent", agentName, namespace);
        if (!agent) throw new Error(`Agent ${namespace}/${agentName} not found`);
        const sessionName = agent.status?.session ?? agent.spec?.defaultSession ?? `${agent.metadata.name}-default`;
        let session = this.state.findByName("Session", sessionName, namespace);
        if (!session) {
            await this.reconcileAgents();
            session = this.state.findByName("Session", sessionName, namespace);
        }
        await this.events.append(session.metadata.name, options.origin?.kind === "Schedule" ? "schedule.message" : "listener.message.received", {
            text,
            origin: options.origin ?? { kind: "cli" },
        });
        const run = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Run",
            metadata: { namespace, name: `run-${Date.now()}` },
            spec: { agentRef: agentName, sessionRef: session.metadata.name, input: text },
            status: { phase: "running", startedAt: new Date().toISOString() },
        };
        await this.state.apply(run);
        const reply = await this.brain.run(agent, session, text, options.origin);
        run.status.phase = "completed";
        run.status.completedAt = new Date().toISOString();
        await this.state.save();
        return { run, reply };
    }

    async createSchedule(subject, spec) {
        const policy = new PolicyEngine(this.state);
        policy.assert(subject, "createOwnSchedule", { namespace: subject.namespace });
        const resource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Schedule",
            metadata: { namespace: subject.namespace, name: spec.name },
            spec,
            status: { phase: "pending" },
        };
        await this.state.apply(resource);
        await this.events.append(spec.session ?? `${subject.name}-default`, "schedule.created", { schedule: spec.name, by: subject.name });
        return resource;
    }

    async snapshot() {
        return this.state.state;
    }
}

function isDue(value) {
    if (!value) return false;
    if (value.startsWith("+")) {
        const amount = Number(value.slice(1, -1));
        const unit = value.at(-1);
        const ms = unit === "s" ? amount * 1000 : unit === "m" ? amount * 60_000 : amount * 3600_000;
        return ms <= 0;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) && time <= Date.now();
}

export async function loadManifest(file) {
    const raw = await readFile(file, "utf8");
    return parseDocuments(raw);
}

export function parseDocuments(raw) {
    return raw.split(/^---\s*$/m).map((doc) => doc.trim()).filter(Boolean).map(parseYamlSubset);
}

function parseYamlSubset(raw) {
    if (raw.trim().startsWith("{")) return JSON.parse(raw);
    const lines = raw.split("\n");
    const root = {};
    const stack = [{ indent: -1, value: root }];
    for (const rawLine of lines) {
        if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
        const indent = rawLine.match(/^ */)[0].length;
        const line = rawLine.trim();
        while (stack.at(-1).indent >= indent) stack.pop();
        const parent = stack.at(-1).value;
        const [key, ...rest] = line.split(":");
        const valueText = rest.join(":").trim();
        if (!valueText) {
            parent[key] = {};
            stack.push({ indent, value: parent[key] });
        } else {
            parent[key] = parseScalar(valueText);
        }
    }
    return root;
}

function parseScalar(value) {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+$/.test(value)) return Number(value);
    return value.replace(/^['"]|['"]$/g, "");
}
