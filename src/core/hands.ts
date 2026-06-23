import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { EventStore } from "./events.js";
import type { ToolResult } from "./types.js";

const DENY_ENV = [/KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /AUTH/i];
const DENY_EXECUTABLES = new Set(["bash", "sh", "zsh", "fish", "python", "python3", "node", "perl", "ruby", "php"]);
const SHELL_METACHARS = /[|&;<>()$`\\\n\r]/;

type HandsOptions = {
    homeRoot: string;
    events?: EventStore;
    sessionId?: string;
    timeoutMs?: number;
};

export class HandsExecutor {
    homeRoot: string;
    events?: EventStore;
    sessionId?: string;
    timeoutMs: number;

    constructor({ homeRoot, events, sessionId, timeoutMs = 15000 }: HandsOptions) {
        this.homeRoot = path.resolve(homeRoot);
        this.events = events;
        this.sessionId = sessionId;
        this.timeoutMs = timeoutMs;
    }

    resolve(userPath = "."): string {
        const root = path.resolve(this.homeRoot);
        const resolved = path.resolve(root, userPath);
        const relative = path.relative(root, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes home: ${userPath}`);
        return resolved;
    }

    async read(userPath: string): Promise<string> {
        await this.emit("tool.requested", { tool: "read", path: userPath });
        const content = await readFile(this.resolve(userPath), "utf8");
        await this.emit("tool.completed", { tool: "read", path: userPath, bytes: content.length });
        return content;
    }

    async write(userPath: string, content: string): Promise<{ path: string; bytes: number }> {
        await this.emit("tool.requested", { tool: "write", path: userPath });
        const target = this.resolve(userPath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        await this.emit("home.file.written", { path: userPath, bytes: content.length });
        await this.emit("tool.completed", { tool: "write", path: userPath });
        return { path: userPath, bytes: content.length };
    }

    async bash(command: string, cwd = "."): Promise<ToolResult> {
        await this.emit("tool.requested", { tool: "bash", command });
        const argv = parseConfinedCommand(command);
        const result = await runConfined(argv, this.resolve(cwd), this.homeRoot, this.timeoutMs);
        await this.emit(result.code === 0 ? "tool.completed" : "tool.failed", {
            tool: "bash",
            command,
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

export function parseConfinedCommand(command: string): string[] {
    if (!command.trim()) throw new Error("Empty command");
    if (SHELL_METACHARS.test(command)) throw new Error("Shell metacharacters are not allowed in local confined hands");
    const argv = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
    if (argv.length === 0) throw new Error("Empty command");
    const executable = argv[0];
    if (!executable.includes("/")) throw new Error("Local confined hands require a Home-relative executable path, e.g. bin/tool");
    if (DENY_EXECUTABLES.has(path.basename(executable))) throw new Error(`Executable ${executable} is not allowed in local confined hands`);
    for (const token of argv) {
        if (path.isAbsolute(token) || token.split(/[\\/]+/).includes("..")) {
            throw new Error(`Path escapes home in command token: ${token}`);
        }
    }
    return argv;
}

async function runConfined(argv: string[], cwd: string, homeRoot: string, timeoutMs: number): Promise<ToolResult> {
    const executable = path.resolve(homeRoot, argv[0]);
    const relativeExecutable = path.relative(path.resolve(homeRoot), executable);
    if (relativeExecutable.startsWith("..") || path.isAbsolute(relativeExecutable)) throw new Error(`Executable escapes home: ${argv[0]}`);
    await access(executable);
    return new Promise((resolve) => {
        const child = spawn(executable, argv.slice(1), {
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
