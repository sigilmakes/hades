import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ToolResult } from "../../domain/resources.js";
import type { EventStorePort } from "../../ports/EventStore.js";
import type { ExecRequest, HandsBackend } from "../../ports/HandsBackend.js";
import { deniedShebangInterpreter, parseConfinedExecCommand } from "./ConfinedCommandParser.js";
import { HomePathPolicy } from "./HomePathPolicy.js";

const DENY_ENV = [/KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /AUTH/i];

type LocalConfinedHandsOptions = {
    homeRoot: string;
    events?: EventStorePort;
    sessionId?: string;
    timeoutMs?: number;
};

export class LocalConfinedHands implements HandsBackend {
    private readonly paths: HomePathPolicy;
    private readonly events?: EventStorePort;
    private readonly sessionId?: string;
    private readonly timeoutMs: number;

    constructor({ homeRoot, events, sessionId, timeoutMs = 15000 }: LocalConfinedHandsOptions) {
        this.paths = new HomePathPolicy(homeRoot);
        this.events = events;
        this.sessionId = sessionId;
        this.timeoutMs = timeoutMs;
    }

    async read(userPath: string): Promise<string> {
        await this.emit("tool.requested", { tool: "read", path: userPath });
        const content = await readFile(this.paths.resolveUserPath(userPath), "utf8");
        await this.emit("tool.completed", { tool: "read", path: userPath, bytes: content.length });
        return content;
    }

    async write(userPath: string, content: string): Promise<{ path: string; bytes: number }> {
        await this.emit("tool.requested", { tool: "write", path: userPath });
        const target = this.paths.resolveUserPath(userPath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        await this.emit("home.file.written", { path: userPath, bytes: content.length });
        await this.emit("tool.completed", { tool: "write", path: userPath });
        return { path: userPath, bytes: content.length };
    }

    async exec(request: ExecRequest): Promise<ToolResult> {
        await this.emit("tool.requested", { tool: "exec", command: request.command });
        const argv = parseConfinedExecCommand(request.command);
        const cwd = await this.paths.resolveExecCwd(request.cwd ?? ".");
        const executable = await this.paths.resolveExecutable(argv[0]);
        await rejectDeniedShebang(executable);
        await access(executable);
        const result = await runProcess(executable, argv.slice(1), cwd, this.timeoutMs);
        await this.emit(result.code === 0 ? "tool.completed" : "tool.failed", {
            tool: "exec",
            command: request.command,
            code: result.code,
            stdout: result.stdout.slice(-4000),
            stderr: result.stderr.slice(-4000),
        });
        return result;
    }

    private async emit(type: string, payload: Record<string, any>): Promise<void> {
        if (this.events && this.sessionId) await this.events.append(this.sessionId, type, payload);
    }
}

export function sanitizedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (DENY_ENV.some((pattern) => pattern.test(key))) continue;
        env[key] = value;
    }
    env.HADES_HANDS = "1";
    return env;
}

async function rejectDeniedShebang(executable: string): Promise<void> {
    const prefix = await readFile(executable, { encoding: "utf8" }).catch(() => "");
    const firstLine = prefix.split("\n", 1)[0] ?? "";
    const denied = deniedShebangInterpreter(firstLine);
    if (denied) throw new Error(`Shebang interpreter ${denied} is not allowed in local confined hands`);
}

function runProcess(executable: string, args: string[], cwd: string, timeoutMs: number): Promise<ToolResult> {
    return new Promise((resolve) => {
        const child = spawn(executable, args, {
            cwd,
            env: sanitizedEnv(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
        }, timeoutMs);
        const finish = (result: ToolResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };
        child.stdout.on("data", (data) => { stdout += data.toString(); });
        child.stderr.on("data", (data) => { stderr += data.toString(); });
        child.on("error", (error) => {
            finish({ code: 127, signal: null, stdout, stderr: String(error.message) });
        });
        child.on("close", (code, signal) => {
            finish({ code: code ?? 137, signal, stdout, stderr });
        });
    });
}
