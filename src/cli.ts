#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer } from "./adapters/api/server.js";
import { loadManifest } from "./adapters/manifest.js";
import { dataDirFromEnv } from "./adapters/store/JsonStateStore.js";
import { parsePrimitiveDecision } from "./domain/primitives.js";
import { createDistributedRuntime } from "./runtime/DistributedRuntime.js";
import { createRuntime } from "./runtime/LocalRuntime.js";
import type { Runtime } from "./runtime/Runtime.js";
import { PrimitiveService } from "./services/PrimitiveService.js";

const [rawCommand = "help", ...args] = process.argv.slice(2);
const command = rawCommand === "--help" || rawCommand === "-h" ? "help" : rawCommand;
const dataDir = dataDirFromEnv();
const distributed = process.env.HADES_MODE === "distributed";
let runtimePromise: Promise<Runtime> | undefined;

try {
    if (command === "help") help();
    else if (command === "init") await initEmpty();
    else if (command === "apply" || command === "up") await apply(args[0]);
    else if (command === "reconcile") await reconcile();
    else if (command === "message" || command === "say") await message(args);
    else if (command === "events" || command === "tail") await events(args[0]);
    else if (command === "state") console.log(JSON.stringify(await (await runtime()).snapshot(), null, 4));
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
  reconcile                    run controllers once
  say [opts] <agent> <txt>     send a prompt to an agent
  tail [session]               print durable events
  state                        print resource state
  primitives [decision]        list researched AgentOS primitives
                               decision: adopt, defer, or reject
  serve [port]                 start the Hades API server
  controller [intervalMs]      run the distributed reconcile loop
                               (deploy mode; set HADES_MODE=distributed)
  attach <agent>               attach a CLI console to an agent
  demo [manifest] [agent]      run a local loop using a manifest
                               default uses offline test demo manifest

Message options:
  --namespace <namespace>      namespace for an unqualified agent name
                               agent may also be passed as namespace/name

Environment:
  HADES_DATA_DIR               state directory (default ./.hades)
  HADES_BRAIN_MODE             pi-sdk (default) or test (offline/tests)
  HADES_MODE                   distributed (deploy mode) or unset (dev)
  HADES_RECONCILE_INTERVAL_MS  controller loop interval (default 5000)
`);
}

async function runtime(): Promise<Runtime> {
    runtimePromise ??= (distributed ? buildDistributedRuntime() : createRuntime(dataDir).init());
    return runtimePromise;
}

async function buildDistributedRuntime(): Promise<Runtime> {
    const opts: Record<string, unknown> = {};
    // Use the real k8s client when HADES_KUBE=1 (deploy to a live cluster);
    // otherwise the FakeKubeClient stands in (tests/dev without a cluster).
    if (process.env.HADES_KUBE === "1") {
        const { KubeClientNode } = await import("./adapters/kube/KubeClientNode.js");
        opts.kubeClient = new KubeClientNode();
    }
    const rt = await createDistributedRuntime(dataDir, opts);
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

async function primitives(decision: string | undefined): Promise<void> {
    const rows = new PrimitiveService().list(parsePrimitiveDecision(decision));
    console.log(JSON.stringify(rows, null, 4));
}

async function serve(args: string[]): Promise<void> {
    const rt = await runtime();
    await rt.reconcile();
    const port = Number(args[0] ?? process.env.PORT ?? 7347);
    const server = createServer(rt);
    server.listen(port, () => console.log(`hades-api listening on :${port}, mode=${rt.mode}, data=${dataDir}`));
}

async function controller(args: string[]): Promise<void> {
    const rt = await runtime();
    const intervalMs = Number(args[0] ?? process.env.HADES_RECONCILE_INTERVAL_MS ?? 5000);
    if (rt.mode !== "distributed") console.warn(`hades controller: running in '${rt.mode}' mode; set HADES_MODE=distributed for deploy mode`);
    await rt.reconcile();
    console.log(`hades controller reconciling every ${intervalMs}ms (mode=${rt.mode}, data=${dataDir})`);
    setInterval(() => {
        rt.reconcile().catch((error) => console.error(`reconcile failed: ${error instanceof Error ? error.message : error}`));
    }, intervalMs);
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
