/**
 * Sandbox policy for Hands execution.
 *
 * The profile is the policy; the {@link HandsBackend} adapter is the
 * substrate. Two profiles ship:
 *
 * - {@link CONFINED_PROFILE} — no real isolation, so interpreters, shell
 *   metacharacters, and secret-like env are refused. Used by
 *   {@link LocalConfinedHands} (in-process hands with no boundary).
 * - {@link PERMISSIVE_CONTAINER_PROFILE} — real isolation (a container), so
 *   interpreters and shell metacharacters are allowed. Used by
 *   {@link ContainerHands}.
 *
 * The brain and parser depend on the profile, not on hardcoded constants,
 * so the sandbox surface changes by swapping the profile + adapter, never
 * by touching orchestration.
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

/**
 * The permissive profile for container-backed hands: real isolation (a
 * disposable container) is the boundary, so interpreters and shell
 * metacharacters are safe. Used by {@link ContainerHands}.
 */
export const PERMISSIVE_CONTAINER_PROFILE: SandboxProfile = {
    id: "permissive-container",
    deniedInterpreters: new Set(),
    denyEnvPatterns: [],
    allowShellMetachars: true,
    requireHomeRelativeExecutable: false,
    timeoutMs: 30000,
};