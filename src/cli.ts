#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./adapters/api/server.js";
import { loadManifest } from "./adapters/manifest.js";
import { dataDirFromEnv } from "./adapters/store/JsonStateStore.js";
import { parsePrimitiveDecision } from "./domain/primitives.js";
import { createRuntime, type RuntimeOptions } from "./runtime/HadesRuntime.js";
import type { Runtime } from "./runtime/Runtime.js";
import { PrimitiveService } from "./services/PrimitiveService.js";

/** Plural/singular aliases for resource kinds (used by `hades get`/`delete`). */
const KIND_ALIASES: Record<string, string> = {
    agents: "Agent", agent: "Agent",
    homes: "Home", home: "Home",
    hands: "Hands", hand: "Hands",
    listeners: "Listener", listener: "Listener",
    schedules: "Schedule", schedule: "Schedule",
    runs: "Run", run: "Run",
    approvals: "Approval", approval: "Approval",
    grants: "CapabilityGrant", grant: "CapabilityGrant",
};

const [rawCommand = "help", ...args] = process.argv.slice(2);
const command = rawCommand === "--help" || rawCommand === "-h" ? "help" : rawCommand;
const dataDir = dataDirFromEnv();
/** Long-running commands inject pino + Prometheus; short commands stay quiet. */
const observabilityEnabled = (command === "serve" || command === "controller") && process.env.HADES_OBSERVABILITY !== "off";
/** Resolve the built web UI directory (ui/dist), if present. */
const uiDir = process.env.HADES_UI_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui/dist");
let runtimePromise: Promise<Runtime> | undefined;

try {
    if (command === "help") help();
    else if (command === "init") await initEmpty();
    else if (command === "apply" || command === "up") await apply(args[0]);
    else if (command === "new") { if (args.length === 0) await listTemplates(); else await newFromTemplate(args); }
    else if (command === "delete") await remove(args);
    else if (command === "reconcile") await reconcile();
    else if (command === "message" || command === "say") await message(args);
    else if (command === "events" || command === "tail") await events(args[0]);
    else if (command === "logs") await logs(args);
    else if (command === "state") console.log(JSON.stringify(await (await runtime()).snapshot(), null, 4));
    else if (command === "get") await get(args);
    else if (command === "primitives") await primitives(args[0]);
    else if (command === "serve") await serve(args);
    else if (command === "controller") await controller(args);
    else if (command === "attach") await attach(args);
    else if (command === "demo") await demo();
    else throw new Error(`Unknown command ${command}`);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`hades: ${message}`);
    process.exitCode = 1;
}

function help(): void {
    console.log(`hades <command>

Commands:
  init                         initialize an empty Hades data directory
  apply|up <file>              apply JSON/YAML-subset resource documents
  new <template> <name>        spin up an agent from a template
                              (examples/templates/*.yaml; --set k=v)
  delete <kind> <name>         remove a resource (agents, schedules, ...)
  reconcile                    run controllers once
  say [opts] <agent> <txt>     send a prompt to an agent
  tail [session]               print durable events
  logs <agent> [--tail N]     stream a brain pod's stdout (HADES_KUBE=1)
  state                        print resource state
  get <kind> [name]           list resources (kubectl-style table)
                              kind: agents, homes, hands, listeners,
                              schedules, runs, approvals, grants
  primitives [decision]        list researched AgentOS primitives
                               decision: adopt, defer, or reject
  serve [port]                 start the Hades API server
  controller [intervalMs]      run the reconcile loop
                               (set HADES_KUBE=1 to reconcile a live cluster)
  attach <agent>               attach a CLI console to an agent
  demo [manifest] [agent]      run a local loop using a manifest
                               default uses offline test demo manifest

Message options:
  --namespace <namespace>      namespace for an unqualified agent name
                               agent may also be passed as namespace/name

Environment:
  HADES_DATA_DIR               state directory (default ./.hades)
  HADES_BRAIN_MODE            pi-sdk (default) or test (offline/tests)
  HADES_KUBE                  set to 1 to reconcile against a live cluster
  HADES_RECONCILE_INTERVAL_MS controller loop interval (default 5000)
  HADES_OBSERVABILITY         off to disable pino logging + /metrics
                              (serve/controller only; on by default)
  HADES_LOG_LEVEL             pino level: trace|debug|info|warn|error (info)
  HADES_LOG_PRETTY            1 for pretty stdout (dev); NDJSON by default
`);
}

async function runtime(): Promise<Runtime> {
    runtimePromise ??= buildRuntime();
    return runtimePromise;
}

async function buildRuntime(): Promise<Runtime> {
    const opts: RuntimeOptions = {};
    // Reconcile a live cluster when HADES_KUBE=1; otherwise the controller is
    // absent (the in-process Reconciler still runs for the local state mirror).
    if (process.env.HADES_KUBE === "1") {
        const { KubeClientNode } = await import("./adapters/kube/KubeClientNode.js");
        opts.kubeClient = new KubeClientNode();
    }
    // Structured logging + metrics are opt-in for the long-running control
    // plane. `serve`/`controller` inject pino + Prometheus (set
    // HADES_OBSERVABILITY=off to disable); short-lived commands keep the noop
    // adapters so their output stays quiet.
    if (observabilityEnabled) {
        const { createPinoLogger } = await import("./adapters/logging/PinoLogger.js");
        const { PrometheusMetrics } = await import("./adapters/metrics/PrometheusMetrics.js");
        const logger = await createPinoLogger(process.env.HADES_LOG_LEVEL ?? "info", process.env.HADES_LOG_PRETTY === "1");
        if (logger) opts.logger = logger;
        opts.metrics = new PrometheusMetrics();
    }
    const rt = await createRuntime(dataDir, opts);
    return rt.init();
}

async function initEmpty(): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    await (await runtime()).reconcile();
    console.log(`initialized empty Hades state in ${dataDir}`);
}

async function apply(file: string | undefined): Promise<void> {
    if (!file) throw new Error("apply requires a file");
    const rt = await runtime();
    const resources = await loadManifest(file);
    for (const resource of resources) await rt.apply(resource);
    await rt.reconcile();
    console.log(`applied ${resources.length} resource(s)`);
}

/**
 * Spin up an agent from a template: `hades new discord-bot mybot --set token-secret=...`.
 * Substitutes {{name}}, {{namespace}}, and any --set key=value, then applies.
 */
async function newFromTemplate(args: string[]): Promise<void> {
    const { namespace, rest } = parseNamespace(args);
    const template = rest[0];
    const name = rest[1];
    if (!template || !name) throw new Error("new requires a template and name: hades new <template> <name> [--set k=v]");
    // Collect --set key=value substitutions.
    const vars: Record<string, string> = {};
    for (let i = rest.indexOf(name) + 1; i < args.length; i++) {
        if (args[i] === "--set" && args[i + 1]?.includes("=")) {
            const [k, ...v] = args[i + 1].split("=");
            vars[k] = v.join("=");
            i++;
        }
    }
    const rt = await runtime();
    const resources = await rt.templates.render(template, name, namespace ?? "default", vars);
    for (const resource of resources) await rt.apply(resource);
    await rt.reconcile();
    console.log(`created ${name} from template ${template} (${resources.length} resources in ${namespace ?? "default"})`);
}

/** `hades new` with no args lists available templates. */
async function listTemplates(): Promise<void> {
    const rt = await runtime();
    const templates = await rt.templates.list();
    if (templates.length === 0) { console.log("No templates found."); return; }
    console.log("Available templates (hades new <template> <name>):");
    for (const t of templates) console.log(`  ${t}`);
}

async function remove(args: string[]): Promise<void> {
    const { namespace, rest } = parseNamespace(args);
    const kindArg = rest[0];
    const name = rest[1];
    if (!kindArg || !name) throw new Error("delete requires a kind and name: hades delete <kind> <name> [--namespace ns]");
    const kind = KIND_ALIASES[kindArg.toLowerCase()] ?? kindArg;
    const rt = await runtime();
    const existed = await rt.remove(kind as never, namespace, name);
    if (!existed) { console.error(`hades: ${kind} ${namespace ? namespace + "/" : ""}${name} not found`); process.exitCode = 1; return; }
    await rt.reconcile();
    console.log(`deleted ${kind} ${namespace}/${name}`);
}

async function reconcile(): Promise<void> {
    await (await runtime()).reconcile();
    console.log("reconciled");
}

async function message(args: string[]): Promise<void> {
    const { namespace, rest } = parseNamespace(args);
    const [agent, ...textParts] = rest;
    if (!agent || textParts.length === 0) throw new Error("message requires <agent> <text>");
    const rt = await runtime();
    await rt.reconcile();
    const { reply } = await rt.messageAgent(agent, textParts.join(" "), { namespace });
    process.stdout.write(reply.endsWith("\n") ? reply : `${reply}\n`);
}

async function events(session: string | undefined): Promise<void> {
    const rows = await (await runtime()).events.list(session);
    for (const event of rows) console.log(JSON.stringify(event));
}

async function get(args: string[]): Promise<void> {
    const { namespace, rest } = parseNamespace(args);
    const kindArg = rest[0];
    if (!kindArg) throw new Error("get requires a kind: agents, homes, hands, listeners, schedules, runs, approvals, grants");
    const kind = KIND_ALIASES[kindArg.toLowerCase()];
    if (!kind) throw new Error(`Unknown kind ${kindArg}. Known: ${Object.keys(KIND_ALIASES).join(", ")}`);
    const name = rest[1];
    const rt = await runtime();
    if (name) {
        const resource = rt.state.findByName(kind as never, name, namespace);
        if (!resource) { console.error(`hades: ${kind} ${namespace ? namespace + "/" : ""}${name} not found`); process.exitCode = 1; return; }
        console.log(JSON.stringify(resource, null, 2));
        return;
    }
    const resources = rt.state.list(kind as never, namespace);
    if (resources.length === 0) { console.log("No resources found."); return; }
    printTable(kind, resources);
}

/** Print a kubectl-style table for a resource list. */
function printTable(kind: string, resources: { metadata?: { name?: string; namespace?: string }; status?: Record<string, unknown>; spec?: Record<string, unknown> }[]): void {
    const rows = resources.map((r) => ({
        NAME: r.metadata?.name ?? "",
        NAMESPACE: r.metadata?.namespace ?? "default",
        PHASE: String(r.status?.phase ?? "-"),
        DETAIL: detailFor(kind, r),
    }));
    const headers = ["NAME", "NAMESPACE", "PHASE", "DETAIL"];
    const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => String(r[h as keyof typeof r]).length)));
    const fmt = (cells: string[]) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd();
    console.log(fmt(headers));
    for (const r of rows) console.log(fmt([r.NAME, r.NAMESPACE, r.PHASE, r.DETAIL]));
}

/** A one-line detail column per kind (the most useful single field). */
function detailFor(kind: string, r: { spec?: Record<string, unknown>; status?: Record<string, unknown> }): string {
    switch (kind) {
        case "Agent": return `${r.spec?.lifecycle ?? "resident"}/${r.spec?.desiredState ?? "?"}`;
        case "Home": return String(r.spec?.size ?? "-");
        case "Hands": return String(r.spec?.agentRef ?? "-");
        case "Listener": return String(r.spec?.platform ?? "-");
        case "Schedule": return `${r.spec?.type ?? "?"}: ${r.spec?.schedule ?? ""}`;
        case "Run": return String(r.spec?.agentRef ?? "-");
        case "Approval": return String(r.spec?.action ?? "-");
        case "CapabilityGrant": return String((r.spec?.subject as { name?: string } | undefined)?.name ?? "-");
        default: return "-";
    }
}

async function logs(args: string[]): Promise<void> {
    const { namespace, rest } = parseNamespace(args);
    const agentName = rest[0];
    if (!agentName) throw new Error("logs requires an agent name: hades logs <agent> [--tail N]");
    const rt = await runtime();
    if (!rt.kubeClient) throw new Error("hades logs needs a live cluster — set HADES_KUBE=1");
    const agent = rt.state.findByName("Agent", agentName, namespace);
    if (!agent) throw new Error(`Agent ${namespace ? namespace + "/" : ""}${agentName} not found`);
    const ns = agent.metadata?.namespace ?? "default";
    const tailFlag = args.indexOf("--tail");
    const tail = tailFlag >= 0 && args[tailFlag + 1] ? Number(args[tailFlag + 1]) : undefined;
    const text = await rt.kubeClient.logs(ns, `brain-${agentName}`, "brain", tail !== undefined ? { tail } : {});
    process.stdout.write(text.endsWith("\n") || text === "" ? text : text + "\n");
}

async function primitives(decision: string | undefined): Promise<void> {
    const rows = new PrimitiveService().list(parsePrimitiveDecision(decision));
    console.log(JSON.stringify(rows, null, 4));
}

async function serve(args: string[]): Promise<void> {
    const rt = await runtime();
    await rt.reconcile();
    const port = Number(args[0] ?? process.env.PORT ?? 7347);
    const server = createServer(rt, existsSync(uiDir) ? uiDir : undefined);
    server.listen(port, () => {
        rt.log.info("api listening", { port, data: dataDir, metrics: "/metrics" });
        console.log(`hades-api listening on :${port}, data=${dataDir} (metrics at /metrics)`);
    });
    installShutdown(rt, server);
}

/**
 * Drain on SIGTERM/SIGINT: stop accepting connections, finish in-flight
 * requests, close the runtime (DB handles), then exit. k8s sends SIGTERM
 * with a grace period; a clean drain prevents dropped requests and
 * half-written SQLite state.
 */
function installShutdown(rt: Runtime, server: import("node:http").Server): void {
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        rt.log.info("shutdown signal received", { signal });
        console.log(`\nhades: ${signal} received, draining…`);
        server.close();
        try {
            await rt.shutdown();
        } catch (error) {
            rt.log.error("shutdown error", { error: error instanceof Error ? error.message : String(error) });
            console.error(`hades: shutdown error: ${error instanceof Error ? error.message : error}`);
        }
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function controller(args: string[]): Promise<void> {
    const rt = await runtime();
    const resyncMs = Number(args[0] ?? process.env.HADES_RECONCILE_INTERVAL_MS ?? 30000);
    if (!rt.kubeClient) console.warn("hades controller: HADES_KUBE not set — reconciling local state only (no live cluster)");
    await rt.reconcile();
    // Event-driven: reconcile on state mutation (debounced), with a periodic
    // resync as a safety net for drift the change stream misses.
    if (rt.controller) rt.controller.start(resyncMs);
    rt.log.info("controller started", { resyncMs, data: dataDir, kube: Boolean(rt.kubeClient), metrics: "/metrics" });
    console.log(`hades controller running (event-driven, resync every ${resyncMs}ms, data=${dataDir})`);
    // The control plane also serves the API on PORT (default 7347).
    const port = Number(process.env.PORT ?? 7347);
    const server = createServer(rt, existsSync(uiDir) ? uiDir : undefined);
    server.listen(port, () => {
        rt.log.info("api listening", { port, data: dataDir });
        console.log(`hades-api listening on :${port}, data=${dataDir} (metrics at /metrics)`);
    });
    installShutdown(rt, server);
}

async function demo(): Promise<void> {
    const [manifestArg = "examples/generic/alpha.json", agentRef = "agent-demo/demo"] = args;
    const manifest = path.resolve(manifestArg);
    const rt = await runtime();
    for (const resource of await loadManifest(manifest)) await rt.apply(resource);
    await rt.reconcile();
    console.log(`applied example manifest ${manifestArg} in ${dataDir}`);
    console.log(await rt.messageAgent(agentRef, "!write vault/demo.md <<<hello from Hades").then((r) => r.reply));
    console.log(await rt.messageAgent(agentRef, "!read vault/demo.md").then((r) => r.reply));
    console.log(await rt.messageAgent(agentRef, "!schedule check once 1970-01-01T00:00:00Z :: scheduled hello").then((r) => r.reply));
    await rt.reconcile();
    console.log("demo complete");
}

function parseNamespace(args: string[]): { namespace?: string; rest: string[] } {
    const rest = [...args];
    let namespace: string | undefined;
    for (let index = 0; index < rest.length;) {
        if (rest[index] === "--namespace" || rest[index] === "-n") {
            namespace = rest[index + 1];
            rest.splice(index, 2);
            continue;
        }
        index += 1;
    }
    return { namespace, rest };
}

async function attach(args: string[]): Promise<void> {
    const { namespace, rest } = parseNamespace(args);
    const agentRef = rest[0];
    if (!agentRef) throw new Error("attach requires <agent>");
    const rt = await runtime();
    await rt.reconcile();
    const { CliBridge } = await import("./ports/ListenerBridge.js");
    const agent = rt.agents.resolveAgent(agentRef, namespace);
    const sessionName = agent.status?.session ?? agent.spec?.defaultSession ?? `${agentRef}-default`;
    const bridge = new CliBridge(`cli-${agentRef}`, agentRef, sessionName);
    bridge.onMessage(async (message) => {
        const { reply } = await rt.messageAgent(agentRef, message.content, { namespace });
        return { reply, origin: message.origin };
    });
    await bridge.start();
    console.log(`attached to ${agentRef} (type a message, Ctrl-D to exit)`);
    process.stdin.setEncoding("utf8");
    for await (const line of process.stdin) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const reply = await bridge.receive(trimmed);
            await bridge.send("stdout", reply);
        } catch (error) {
            console.error(`hades attach: ${error instanceof Error ? error.message : error}`);
        }
    }
    await bridge.stop();
}
