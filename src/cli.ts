#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { HadesRuntime, loadManifest } from "./core/controllers.js";
import { dataDirFromEnv } from "./core/state.js";
import { createServer } from "./api/server.js";

const [command = "help", ...args] = process.argv.slice(2);
const dataDir = dataDirFromEnv();
const runtime = await new HadesRuntime(dataDir).init();

try {
    if (command === "help") help();
    else if (command === "init") await initEmpty();
    else if (command === "apply") await apply(args[0]);
    else if (command === "reconcile") await reconcile();
    else if (command === "message") await message(args);
    else if (command === "events") await events(args[0]);
    else if (command === "state") console.log(JSON.stringify(await runtime.snapshot(), null, 4));
    else if (command === "serve") await serve(args);
    else if (command === "demo") await demo();
    else throw new Error(`Unknown command ${command}`);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`hades: ${message}`);
    process.exitCode = 1;
}

function help() {
    console.log(`hades <command>

Commands:
  init                         initialize an empty Hades data directory
  apply <file>                 apply JSON/YAML-subset resource documents
  reconcile                    run controllers once
  message [opts] <agent> <txt> send a prompt to an agent
  events [session]             print durable events
  state                        print resource state
  serve [port]                 start the Hades API server
  demo [manifest] [agent]      run a local loop using a manifest

Message options:
  --namespace <namespace>      namespace for an unqualified agent name
                               agent may also be passed as namespace/name

Environment:
  HADES_DATA_DIR               state directory (default ./.hades)
  HADES_USE_PI_SDK=1           run brain through pi SDK instead of deterministic mode
`);
}

async function initEmpty() {
    await mkdir(dataDir, { recursive: true });
    await runtime.reconcile();
    console.log(`initialized empty Hades state in ${dataDir}`);
}

async function apply(file: string | undefined) {
    if (!file) throw new Error("apply requires a file");
    const resources = await loadManifest(file);
    for (const resource of resources) await runtime.apply(resource);
    await runtime.reconcile();
    console.log(`applied ${resources.length} resource(s)`);
}

async function reconcile() {
    await runtime.reconcile();
    console.log("reconciled");
}

async function message(args: string[]) {
    const { namespace, rest } = parseNamespace(args);
    const [agent, ...textParts] = rest;
    if (!agent || textParts.length === 0) throw new Error("message requires <agent> <text>");
    await runtime.reconcile();
    const { reply } = await runtime.messageAgent(agent, textParts.join(" "), { namespace });
    process.stdout.write(reply.endsWith("\n") ? reply : `${reply}\n`);
}

async function events(session: string | undefined) {
    const rows = await runtime.events.list(session);
    for (const event of rows) console.log(JSON.stringify(event));
}

async function serve(args: string[]) {
    await runtime.reconcile();
    const port = Number(args[0] ?? process.env.PORT ?? 7347);
    const server = createServer(runtime);
    server.listen(port, () => console.log(`hades-api listening on :${port}, data=${dataDir}`));
}

async function demo() {
    const [manifestArg = "examples/generic/alpha.json", agentRef = "agent-demo/demo"] = args;
    const manifest = path.resolve(manifestArg);
    for (const resource of await loadManifest(manifest)) await runtime.apply(resource);
    await runtime.reconcile();
    console.log(`applied example manifest ${manifestArg} in ${dataDir}`);
    console.log(await runtime.messageAgent(agentRef, "!write vault/demo.md <<<hello from Hades").then((r) => r.reply));
    console.log(await runtime.messageAgent(agentRef, "!read vault/demo.md").then((r) => r.reply));
    console.log(await runtime.messageAgent(agentRef, "!schedule check once 1970-01-01T00:00:00Z :: scheduled hello").then((r) => r.reply));
    await runtime.reconcile();
    console.log("demo complete");
}

function parseNamespace(args: string[]) {
    const rest = [...args];
    let namespace;
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
