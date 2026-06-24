/**
 * Sandbox policy for Hands execution.
 *
 * The local prototype ships CONFINED_PROFILE because there is no real
 * isolation: interpreters, shell metacharacters, and secret-like env are
 * refused. A future container-backed Hands backend (gVisor/Kata/namespaces)
 * uses a permissive profile that allows bash/python/node under real
 * isolation. The brain and parser depend on the profile, not on hardcoded
 * constants, so the sandbox surface can change without touching orchestration.
 */
export type SandboxProfile = {
    readonly id: string;
    readonly deniedInterpreters: ReadonlySet<string>;
    readonly denyEnvPatterns: readonly RegExp[];
    readonly allowShellMetachars: boolean;
    readonly requireHomeRelativeExecutable: boolean;
    readonly timeoutMs: number;
};

export const CONFINED_PROFILE: SandboxProfile = {
    id: "confined-local",
    deniedInterpreters: new Set([
        "bash", "sh", "zsh", "fish",
        "python", "python3", "node", "perl", "ruby", "php",
    ]),
    denyEnvPatterns: [/KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /AUTH/i],
    allowShellMetachars: false,
    requireHomeRelativeExecutable: true,
    timeoutMs: 15000,
};