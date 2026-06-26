import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { type ToolResult } from "../../domain/resources.js";
import type { ExecRequest, HandsBackend } from "../../ports/HandsBackend.js";
import { CONFINED_PROFILE, PERMISSIVE_CONTAINER_PROFILE, type SandboxProfile } from "../../domain/sandbox.js";
import { HomePathPolicy } from "./HomePathPolicy.js";

/**
 * A container-backed {@link HandsBackend}: the top rung of the sandbox ladder.
 *
 * `read` and `write` operate on the agent home directly (the home path policy
 * still applies — path escapes are refused regardless of substrate). `exec`
 * runs inside a **disposable container** with the home mounted read-write at
 * `/home/agent`. Because the container *is* the isolation boundary, the
 * {@link PERMISSIVE_CONTAINER_PROFILE} allows interpreters (bash/python/node)
 * and shell metacharacters — the things {@link CONFINED_PROFILE} refuses
 * because it has no real boundary.
 *
 * The sandbox profile is the policy; the backend adapter is the substrate.
 * Swapping `LocalConfinedHands` for `ContainerHands` changes the isolation
 * boundary without touching the brain, the parser, or the wire.
 *
 * In deploy mode the hands pod *is* the container (Kubernetes does the
 * isolation via the pod boundary + NetworkPolicy); this adapter is for
 * dev-mode real-isolation hands against a local docker daemon.
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

export { CONFINED_PROFILE, PERMISSIVE_CONTAINER_PROFILE };
