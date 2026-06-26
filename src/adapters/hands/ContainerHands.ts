import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { type ToolResult } from "../../domain/resources.js";
import type { ExecRequest, HandsBackend } from "../../ports/HandsBackend.js";
import { CONFINED_PROFILE, type SandboxProfile } from "../../domain/sandbox.js";
import { HomePathPolicy } from "./HomePathPolicy.js";

/**
 * A container-backed {@link HandsBackend} (the top sandbox rung, spec/15). Runs
 * `hades_read`/`hades_write`/`hades_exec` against the agent home, but `exec`
 * runs inside a disposable container (docker) with the home mounted read-write
 * and a **permissive** profile — because the container *is* the isolation
 * boundary, interpreters (bash/python/node) and shell metacharacters are safe.
 *
 * This is the sandbox ladder RLM uses (docker/modal/e2b/daytona) and the
 * "real isolation" backend the {@link CONFINED_PROFILE} comment has been
 * pointing at: a confined-local profile refuses interpreters because there is
 * no real isolation; a container-backed profile allows them under real
 * isolation. The {@link SandboxProfile} is the policy; the backend is the
 * substrate.
 *
 * In deploy mode the hands pod *is* the container (k8s does the isolation);
 * this adapter is for dev-mode real-isolation hands and for a future
 * per-call container hands (gVisor/Kata).
 */
export class ContainerHands implements HandsBackend {
    readonly mode = "container";
    private readonly paths: HomePathPolicy;
    private readonly profile: SandboxProfile;
    private readonly image: string;

    constructor(options: ContainerHandsOptions) {
        this.paths = new HomePathPolicy(options.homeRoot);
        this.profile = options.profile ?? PERMISSIVE_CONTAINER_PROFILE;
        this.image = options.image ?? "node:24-slim";
    }

    async read(userPath: string): Promise<string> {
        const target = this.paths.resolveUserPath(userPath);
        return readFile(target, "utf8");
    }

    async write(userPath: string, content: string): Promise<{ path: string; bytes: number }> {
        const target = this.paths.resolveUserPath(userPath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        return { path: userPath, bytes: content.length };
    }

    async exec(request: ExecRequest): Promise<ToolResult> {
        // Run inside a disposable container: home mounted read-write at /home/agent,
        // working dir /home/agent, the permissive profile (interpreters allowed).
        const cwd = request.cwd ?? ".";
        const argv = ["/bin/sh", "-c", request.command];
        const args = [
            "run", "--rm",
            "-i",
            "--security-opt", "no-new-privileges",
            "--network", "none",
            "--memory", "256m",
            "--cpus", "0.5",
            "--pids-limit", "64",
            "-v", `${this.paths.root}:/home/agent:rw`,
            "-w", `/home/agent/${cwd}`,
            this.image,
            ...argv,
        ];
        return runDocker(args, this.profile.timeoutMs);
    }
}

export const PERMISSIVE_CONTAINER_PROFILE: SandboxProfile = {
    id: "permissive-container",
    deniedInterpreters: new Set(),
    denyEnvPatterns: [],
    allowShellMetachars: true,
    requireHomeRelativeExecutable: false,
    timeoutMs: 30000,
};

export type ContainerHandsOptions = {
    homeRoot: string;
    profile?: SandboxProfile;
    image?: string;
};

function runDocker(args: string[], timeoutMs: number): Promise<ToolResult> {
    return new Promise((resolve) => {
        const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        const finish = (result: ToolResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("error", (error) => finish({ code: 127, signal: null, stdout, stderr: String(error.message) }));
        child.on("close", (code, signal) => finish({ code: code ?? 137, signal, stdout, stderr }));
    });
}

// Re-export for tests that check the profile.
export { CONFINED_PROFILE };
