import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DENY_ENV = [/KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /AUTH/i];

export class HandsExecutor {
    constructor({ homeRoot, events, sessionId, timeoutMs = 15000 }) {
        this.homeRoot = path.resolve(homeRoot);
        this.events = events;
        this.sessionId = sessionId;
        this.timeoutMs = timeoutMs;
    }

    resolve(userPath = ".") {
        const resolved = path.resolve(this.homeRoot, userPath);
        if (!resolved.startsWith(this.homeRoot)) throw new Error(`Path escapes home: ${userPath}`);
        return resolved;
    }

    async read(userPath) {
        await this.events?.append(this.sessionId, "tool.requested", { tool: "read", path: userPath });
        const content = await readFile(this.resolve(userPath), "utf8");
        await this.events?.append(this.sessionId, "tool.completed", { tool: "read", path: userPath, bytes: content.length });
        return content;
    }

    async write(userPath, content) {
        await this.events?.append(this.sessionId, "tool.requested", { tool: "write", path: userPath });
        const target = this.resolve(userPath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        await this.events?.append(this.sessionId, "home.file.written", { path: userPath, bytes: content.length });
        await this.events?.append(this.sessionId, "tool.completed", { tool: "write", path: userPath });
        return { path: userPath, bytes: content.length };
    }

    async bash(command, cwd = ".") {
        await this.events?.append(this.sessionId, "tool.requested", { tool: "bash", command });
        const result = await runBash(command, this.resolve(cwd), this.timeoutMs);
        await this.events?.append(this.sessionId, result.code === 0 ? "tool.completed" : "tool.failed", {
            tool: "bash",
            command,
            code: result.code,
            stdout: result.stdout.slice(-4000),
            stderr: result.stderr.slice(-4000),
        });
        return result;
    }
}

export function sanitizedEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (DENY_ENV.some((pattern) => pattern.test(key))) continue;
        env[key] = value;
    }
    env.HADES_HANDS = "1";
    return env;
}

function runBash(command, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn("/bin/bash", ["-lc", command], {
            cwd,
            env: sanitizedEnv(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (data) => { stdout += data.toString(); });
        child.stderr.on("data", (data) => { stderr += data.toString(); });
        child.on("close", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code: code ?? 137, signal, stdout, stderr });
        });
    });
}
