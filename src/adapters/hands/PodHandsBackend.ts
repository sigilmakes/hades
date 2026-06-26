import { nameOf, namespaceOf, type HadesResource, type ToolResult } from "../../domain/resources.js";
import type { ExecRequest, HandsBackend } from "../../ports/HandsBackend.js";
import type { KubeClient } from "../../ports/KubeClient.js";
import { HomePathPolicy } from "./HomePathPolicy.js";

/**
 * A {@link HandsBackend} that executes read/write/exec against an agent's
 * hands pod via the Kubernetes `exec` API.
 *
 * The hands pod is a thin sandbox (a container running `sleep infinity` with
 * the agent's Home mounted at `/home/agent`). The brain does not run a tool
 * server in the pod — it execs into the pod directly: `cat`/`dd` for file
 * reads and writes, `/bin/sh -c` for exec. This is the goldilocks-app model:
 * hands are pods the controller provisions; the server drives all tool
 * execution via k8s exec.
 *
 * The home path policy still applies (path escapes are refused) — confinement
 * is enforced client-side before any exec reaches the pod.
 */
export class PodHandsBackend implements HandsBackend {
    readonly mode = "pod";
    private readonly paths: HomePathPolicy;
    private readonly kube: KubeClient;
    private readonly namespace: string;
    private readonly pod: string;
    private readonly container: string;
    private readonly homeMount: string;

    constructor(options: PodHandsOptions) {
        this.paths = new HomePathPolicy(options.homeRoot);
        this.kube = options.kubeClient;
        this.namespace = options.namespace;
        this.pod = options.pod;
        this.container = options.container ?? "hands";
        this.homeMount = options.homeMount ?? "/home/agent";
    }

    async read(userPath: string): Promise<string> {
        const target = this.mountPath(userPath);
        const result = await this.kube.exec(this.namespace, this.pod, this.container, ["cat", target]);
        if (result.code !== 0) throw new Error(result.stderr || `read failed (exit ${result.code})`);
        return result.stdout;
    }

    async write(userPath: string, content: string): Promise<{ path: string; bytes: number }> {
        const target = this.mountPath(userPath);
        // mkdir -p the parent, then write via stdin to avoid shell-quoting the content.
        const dir = target.slice(0, Math.max(0, target.lastIndexOf("/")));
        if (dir) await this.kube.exec(this.namespace, this.pod, this.container, ["mkdir", "-p", dir]);
        const result = await this.kube.exec(this.namespace, this.pod, this.container, ["sh", "-c", `cat > ${shellQuote(target)}`], content);
        if (result.code !== 0) throw new Error(result.stderr || `write failed (exit ${result.code})`);
        return { path: userPath, bytes: content.length };
    }

    async exec(request: ExecRequest): Promise<ToolResult> {
        const cwd = request.cwd ?? ".";
        const workdir = `${this.homeMount}/${cwd}`.replace(/\/+$/, "");
        // Run the command in the workdir, inside the pod.
        const result = await this.kube.exec(this.namespace, this.pod, this.container, ["sh", "-c", `cd ${shellQuote(workdir)} && ${request.command}`]);
        return { code: result.code, signal: null, stdout: result.stdout, stderr: result.stderr };
    }

    /** Resolve a user path to the in-pod mount path, after policy checks. */
    private mountPath(userPath: string): string {
        const resolved = this.paths.resolveUserPath(userPath);
        // HomePathPolicy resolves against the host homeRoot; map to the pod mount.
        const rel = resolved.slice(this.paths.root.length).replace(/^\/+/, "");
        return `${this.homeMount}/${rel}`.replace(/\/+$/, "");
    }
}

export type PodHandsOptions = {
    homeRoot: string;
    kubeClient: KubeClient;
    namespace: string;
    pod: string;
    container?: string;
    homeMount?: string;
};

/** Resolve the pod name for an agent's hands pod (convention: `hands-<agent>`). */
export function handsPodName(agent: HadesResource): string {
    return `hands-${nameOf(agent)}`;
}

/** Resolve the namespace for an agent's hands pod. */
export function handsNamespace(agent: HadesResource): string {
    return namespaceOf(agent);
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}
