import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { EventStore } from "./events.js";
import type { ToolResult } from "./types.js";

const DENY_ENV = [/KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /AUTH/i];

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
        const result = await runBash(command, this.resolve(cwd), this.timeoutMs);
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

function runBash(command: string, cwd: string, timeoutMs: number): Promise<ToolResult> {
    return new Promise((resolve) => {
        const child = spawn("bash", ["-lc", command], {
            cwd,
            env: sanitizedEnv(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result: ToolResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
        }, timeoutMs);
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
