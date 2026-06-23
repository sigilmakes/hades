import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventStore } from "./events.js";
import { StateStore, type HadesState } from "./state.js";
import { BrainRuntime } from "./brain.js";
import { PolicyEngine } from "./policy.js";
import type { AgentSubject, HadesResource } from "./types.js";

type MessageOptions = {
    namespace?: string;
    origin?: Record<string, any>;
};

export class HadesRuntime {
    dataDir: string;
    state: StateStore;
    events: EventStore;
    brain: BrainRuntime;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.state = new StateStore(dataDir);
        this.events = new EventStore(dataDir);
        this.brain = new BrainRuntime({ state: this.state, events: this.events, dataDir });
    }

    async init(): Promise<this> {
        await this.state.init();
        await this.events.init();
        return this;
    }

    async apply(resource: HadesResource): Promise<HadesResource> {
        const applied = await this.state.apply(resource);
        await this.events.append("system", "resource.applied", {
            kind: resource.kind,
            namespace: applied.metadata?.namespace,
            name: applied.metadata?.name,
        });
        return applied;
    }

    async reconcile(): Promise<void> {
        await this.reconcileHomes();
        await this.reconcileAgents();
        await this.reconcileListeners();
        await this.reconcileSchedules();
        await this.state.save();
    }

    async reconcileHomes(): Promise<void> {
        for (const home of this.state.list("Home")) {
            const namespace = namespaceOf(home);
            const homePath = home.spec?.path ?? path.join(this.dataDir, "homes", namespace, nameOf(home));
            for (const dir of home.spec?.layout?.create ?? ["vault", "bin", "cron.d", "projects", "skills", "inbox", "outbox"]) {
                await mkdir(path.join(homePath, dir), { recursive: true });
            }
            for (const file of home.spec?.files ?? []) {
                const relativePath = String(file.path ?? "");
                if (!relativePath) throw new Error(`Home ${nameOf(home)} has a bootstrap file without path`);
                const target = safeHomePath(homePath, relativePath);
                await mkdir(path.dirname(target), { recursive: true });
                if (!file.overwrite && await exists(target)) continue;
                await writeFile(target, String(file.content ?? ""), "utf8");
                if (file.mode) await chmod(target, Number.parseInt(String(file.mode), 8));
            }
            home.status = { ...(home.status ?? {}), phase: "ready", path: homePath };
            await this.events.append("system", "home.ready", { home: nameOf(home), path: homePath });
        }
    }

    async reconcileAgents(): Promise<void> {
        for (const agent of this.state.list("Agent")) {
            const namespace = namespaceOf(agent);
            const agentName = nameOf(agent);
            const sessionName = agent.spec?.defaultSession ?? `${agentName}-default`;
            if (!this.state.findByName("Session", sessionName, namespace)) {
                await this.state.apply({
                    apiVersion: "hades.dev/v1alpha1",
                    kind: "Session",
                    metadata: { namespace, name: sessionName },
                    spec: { agentRef: agentName, logRef: sessionName },
                    status: { phase: "idle" },
                });
                await this.events.append(sessionName, "session.created", { agent: agentName });
            }
            if (agent.spec?.desiredState === "active" && !this.state.findByName("BrainBinding", `${agentName}-default`, namespace)) {
                await this.state.apply({
                    apiVersion: "hades.dev/v1alpha1",
                    kind: "BrainBinding",
                    metadata: { namespace, name: `${agentName}-default` },
                    spec: { agentRef: agentName, sessionRef: sessionName, image: "ghcr.io/sigilmakes/hades-brain-pi:dev" },
                    status: { phase: "ready", podName: `brain-${agentName}-local` },
                });
            }
            if (!this.state.findByName("Hands", `${agentName}-home-shell`, namespace)) {
                await this.state.apply({
                    apiVersion: "hades.dev/v1alpha1",
                    kind: "Hands",
                    metadata: { namespace, name: `${agentName}-home-shell` },
                    spec: { agentRef: agentName, type: "home-toolbox", mode: "exclusive-home", homeRef: agent.spec?.homeRef },
                    status: { phase: "ready", podName: `hands-${agentName}-local` },
                });
            }
            agent.status = { ...(agent.status ?? {}), phase: agent.spec?.desiredState ?? "active", session: sessionName };
        }
    }

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

    async reconcileSchedules(): Promise<void> {
        for (const schedule of this.state.list("Schedule")) {
            schedule.status ??= {};
            schedule.status.phase ??= "pending";
            if (schedule.spec?.type === "once" && !schedule.status.firedAt && isDue(schedule.spec.schedule)) {
                await this.fireSchedule(schedule);
            }
        }
    }

    async fireSchedule(schedule: HadesResource): Promise<void> {
        const namespace = namespaceOf(schedule);
        const agent = this.state.findByName("Agent", schedule.spec?.agentRef, namespace);
        if (!agent) throw new Error(`Schedule ${nameOf(schedule)} references missing agent ${schedule.spec?.agentRef}`);
        const session = this.state.findByName("Session", schedule.spec?.session ?? agent.spec?.defaultSession ?? `${nameOf(agent)}-default`, namespace);
        if (!session) throw new Error(`Schedule ${nameOf(schedule)} references missing session`);
        await this.events.append(nameOf(session), "schedule.fired", { schedule: nameOf(schedule) });
        schedule.status ??= {};
        schedule.status.firedAt = new Date().toISOString();
        schedule.status.phase = "completed";
        await this.messageAgent(nameOf(agent), schedule.spec?.prompt ?? `Schedule ${nameOf(schedule)} fired`, {
            namespace,
            origin: { kind: "Schedule", name: nameOf(schedule) },
        });
    }

    resolveAgent(agentRef: string, namespace: string | undefined = undefined): HadesResource {
        if (agentRef.includes("/")) {
            const [refNamespace, refName] = agentRef.split("/", 2);
            const agent = this.state.findByName("Agent", refName, refNamespace);
            if (!agent) throw new Error(`Agent ${refNamespace}/${refName} not found`);
            return agent;
        }
        if (namespace) {
            const agent = this.state.findByName("Agent", agentRef, namespace);
            if (!agent) throw new Error(`Agent ${namespace}/${agentRef} not found`);
            return agent;
        }
        const matches = this.state.list("Agent").filter((agent) => agent.metadata?.name === agentRef);
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) throw new Error(`Agent ${agentRef} is ambiguous; pass namespace or use namespace/name`);
        throw new Error(`Agent ${agentRef} not found`);
    }

    async messageAgent(agentName: string, text: string, options: MessageOptions = {}): Promise<{ run: HadesResource; reply: string }> {
        const agent = this.resolveAgent(agentName, options.namespace);
        const namespace = namespaceOf(agent);
        const sessionName = agent.status?.session ?? agent.spec?.defaultSession ?? `${nameOf(agent)}-default`;
        let session = this.state.findByName("Session", sessionName, namespace);
        if (!session) {
            await this.reconcileAgents();
            session = this.state.findByName("Session", sessionName, namespace);
        }
        if (!session) throw new Error(`Session ${namespace}/${sessionName} not found`);
        await this.events.append(nameOf(session), options.origin?.kind === "Schedule" ? "schedule.message" : "listener.message.received", {
            text,
            origin: options.origin ?? { kind: "cli" },
        });
        const run: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Run",
            metadata: { namespace, name: `run-${Date.now()}` },
            spec: { agentRef: agentName, sessionRef: nameOf(session), input: text },
            status: { phase: "running", startedAt: new Date().toISOString() },
        };
        await this.state.apply(run);
        const reply = await this.brain.run(agent, session, text);
        run.status ??= {};
        run.status.phase = "completed";
        run.status.completedAt = new Date().toISOString();
        await this.state.save();
        return { run, reply };
    }

    async createSchedule(subject: AgentSubject, spec: Record<string, any>): Promise<HadesResource> {
        const policy = new PolicyEngine(this.state);
        policy.assert(subject, "createOwnSchedule", { namespace: subject.namespace });
        const resource: HadesResource = {
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

    async snapshot(): Promise<HadesState> {
        return this.state.state;
    }
}

function isDue(value: string | undefined): boolean {
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

export async function loadManifest(file: string): Promise<HadesResource[]> {
    const raw = await readFile(file, "utf8");
    return parseDocuments(raw);
}

export function parseDocuments(raw: string): HadesResource[] {
    return raw.split(/^---\s*$/m).map((doc) => doc.trim()).filter(Boolean).map(parseYamlSubset);
}

function parseYamlSubset(raw: string): HadesResource {
    if (raw.trim().startsWith("{")) return JSON.parse(raw);
    const lines = raw.split("\n");
    const root: Record<string, any> = {};
    const stack: Array<{ indent: number; value: Record<string, any> }> = [{ indent: -1, value: root }];
    for (const rawLine of lines) {
        if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
        const indent = rawLine.match(/^ */)?.[0].length ?? 0;
        const line = rawLine.trim();
        while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
        const parent = stack.at(-1)?.value ?? root;
        const [key, ...rest] = line.split(":");
        const valueText = rest.join(":").trim();
        if (!valueText) {
            parent[key] = {};
            stack.push({ indent, value: parent[key] });
        } else {
            parent[key] = parseScalar(valueText);
        }
    }
    return root as HadesResource;
}

function parseScalar(value: string): string | number | boolean {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+$/.test(value)) return Number(value);
    return value.replace(/^["']|["']$/g, "");
}

async function exists(file: string): Promise<boolean> {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

function safeHomePath(homePath: string, relativePath: string): string {
    const target = path.resolve(homePath, relativePath);
    if (!target.startsWith(path.resolve(homePath))) throw new Error(`Home bootstrap file escapes home: ${relativePath}`);
    return target;
}

function nameOf(resource: HadesResource): string {
    const name = resource.metadata?.name;
    if (!name) throw new Error(`${resource.kind} is missing metadata.name`);
    return name;
}

function namespaceOf(resource: HadesResource): string {
    return resource.metadata?.namespace ?? "default";
}
