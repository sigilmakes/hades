import path from "node:path";
import type { SandboxProfile } from "../../domain/sandbox.js";

export function parseConfinedExecCommand(command: string, profile: SandboxProfile): string[] {
    if (!command.trim()) throw new Error("Empty command");
    if (!profile.allowShellMetachars && SHELL_METACHARS.test(command)) {
        throw new Error("Shell metacharacters are not allowed in local confined hands");
    }
    const argv = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
    if (argv.length === 0) throw new Error("Empty command");
    const executable = argv[0];
    if (profile.requireHomeRelativeExecutable && !executable.includes("/")) throw new Error("Local confined hands require a Home-relative executable path, e.g. bin/tool");
    if (profile.deniedInterpreters.has(path.basename(executable))) {
        throw new Error(`Executable ${executable} is not allowed in local confined hands`);
    }
    for (const token of argv) {
        if (path.isAbsolute(token) || token.split(/[\\/]+/).includes("..")) {
            throw new Error(`Path escapes home in command token: ${token}`);
        }
    }
    return argv;
}

export function deniedShebangInterpreter(firstLine: string, profile: SandboxProfile): string | undefined {
    if (!firstLine.startsWith("#!")) return undefined;
    const parts = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
    const interpreter = path.basename(parts[0] ?? "");
    const command = interpreter === "env" ? firstEnvCommand(parts.slice(1)) : interpreter;
    const deniedName = path.basename(command ?? interpreter);
    return profile.deniedInterpreters.has(deniedName) ? deniedName : undefined;
}

const SHELL_METACHARS = /[|&;<>()$`\\\n\r]/;

function firstEnvCommand(parts: string[]): string | undefined {
    return parts.find((part) => !part.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(part));
}
