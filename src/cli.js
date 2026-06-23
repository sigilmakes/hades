#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HadesRuntime, loadManifest } from "./core/controllers.js";
import { dataDirFromEnv } from "./core/state.js";
import { createServer } from "./api/server.js";

const [command = "help", ...args] = process.argv.slice(2);
const dataDir = dataDirFromEnv();
const runtime = await new HadesRuntime(dataDir).init();

try {
    if (command === "help") help();
    else if (command === "init") await initExample();
    else if (command === "apply") await apply(args[0]);
    else if (command === "reconcile") await reconcile();
    else if (command === "message") await message(args);
    else if (command === "events") await events(args[0]);
    else if (command === "state") console.log(JSON.stringify(await runtime.snapshot(), null, 4));
    else if (command === "serve") await serve(args);
    else if (command === "demo") await demo();
    else throw new Error(`Unknown command ${command}`);
} catch (error) {
    console.error(`hades: ${error.message}`);
    process.exitCode = 1;
}

function help() {
    console.log(`hades <command>

Commands:
  init                  create the Wren alpha resources in HADES_DATA_DIR
  apply <file>          apply JSON/YAML-subset resource documents
  reconcile             run controllers once
  message <agent> <txt> send a prompt to an agent
  events [session]      print durable events
  state                 print resource state
  serve [port]          start the Hades API server
  demo                  run a full local Wren loop

Environment:
  HADES_DATA_DIR        state directory (default ./.hades)
  HADES_USE_PI_SDK=1    run brain through pi SDK instead of deterministic mode
`);
}

async function initExample() {
    for (const resource of wrenResources()) await runtime.apply(resource);
    await runtime.reconcile();
    console.log(`initialized Wren alpha in ${dataDir}`);
}

async function apply(file) {
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

async function message(args) {
    const [agent, ...textParts] = args;
    if (!agent || textParts.length === 0) throw new Error("message requires <agent> <text>");
    await runtime.reconcile();
    const { reply } = await runtime.messageAgent(agent, textParts.join(" "));
    process.stdout.write(reply.endsWith("\n") ? reply : `${reply}\n`);
}

async function events(session) {
    const rows = await runtime.events.list(session);
    for (const event of rows) console.log(JSON.stringify(event));
}

async function serve(args) {
    await runtime.reconcile();
    const port = Number(args[0] ?? process.env.PORT ?? 7347);
    const server = createServer(runtime);
    server.listen(port, () => console.log(`hades-api listening on :${port}, data=${dataDir}`));
}

async function demo() {
    await initExample();
    console.log(await runtime.messageAgent("wren", "!write vault/demo.md <<<hello from Hades").then((r) => r.reply));
    console.log(await runtime.messageAgent("wren", "!read vault/demo.md").then((r) => r.reply));
    console.log(await runtime.messageAgent("wren", "!schedule check once 1970-01-01T00:00:00Z :: scheduled hello").then((r) => r.reply));
    await runtime.reconcile();
    console.log("demo complete");
}

function wrenResources() {
    return [
        {
            apiVersion: "hades.dev/v1alpha1",
            kind: "AgentClass",
            metadata: { namespace: "agent-wren", name: "resident-pi" },
            spec: { brainImage: "ghcr.io/sigilmakes/hades-brain-pi:dev", allowedTools: "read,write,bash,os.createSchedule" },
        },
        {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Home",
            metadata: { namespace: "agent-wren", name: "wren-home" },
            spec: { layout: { create: ["vault", "bin", "cron.d", "projects", "skills", "inbox", "outbox"] } },
        },
        {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Agent",
            metadata: { namespace: "agent-wren", name: "wren" },
            spec: { displayName: "Wren", classRef: "resident-pi", homeRef: "wren-home", defaultSession: "wren-default", desiredState: "active" },
        },
        {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Listener",
            metadata: { namespace: "agent-wren", name: "wren-cli" },
            spec: { agentRef: "wren", platform: "cli", routes: "default" },
        },
        {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Listener",
            metadata: { namespace: "agent-wren", name: "wren-discord" },
            spec: { agentRef: "wren", platform: "discord", secretRef: "wren-discord-token", routes: "default" },
        },
        {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Schedule",
            metadata: { namespace: "agent-wren", name: "morning-ritual" },
            spec: { agentRef: "wren", type: "manual", schedule: "0 7 * * *", session: "wren-default", prompt: "Good morning. Orient, check the vault, and say hello." },
            status: { phase: "pending" },
        },
        {
            apiVersion: "hades.dev/v1alpha1",
            kind: "CapabilityGrant",
            metadata: { namespace: "agent-wren", name: "wren-self-management" },
            spec: { subject: { kind: "Agent", name: "wren" }, capabilities: ["updateOwnHome", "createOwnTool", "createOwnSchedule", "spawnChildAgent"], constraints: { namespace: "own" } },
        },
    ];
}
