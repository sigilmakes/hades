import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class HomePathPolicy {
    readonly root: string;

    constructor(homeRoot: string) {
        this.root = path.resolve(homeRoot);
    }

    resolveUserPath(userPath = "."): string {
        if (path.isAbsolute(userPath)) throw new Error(`Absolute paths are not allowed in local hands: ${userPath}`);
        const resolved = path.resolve(this.root, userPath);
        this.assertAbsolutePathInside(resolved, `Path escapes home: ${userPath}`);
        return resolved;
    }

    async resolveExecCwd(userPath = "."): Promise<string> {
        const resolved = this.resolveUserPath(userPath);
        const info = await stat(resolved);
        if (!info.isDirectory()) throw new Error(`Execution cwd is not a directory: ${userPath}`);
        const real = await realpath(resolved);
        this.assertAbsolutePathInside(real, `Execution cwd realpath escapes home: ${userPath}`);
        return real;
    }

    async resolveExecutable(userPath: string): Promise<string> {
        const resolved = this.resolveUserPath(userPath);
        const info = await lstat(resolved);
        if (info.isSymbolicLink()) throw new Error(`Executable symlinks are not allowed in local confined hands: ${userPath}`);
        if (!info.isFile()) throw new Error(`Executable is not a file: ${userPath}`);
        const real = await realpath(resolved);
        this.assertAbsolutePathInside(real, `Executable realpath escapes home: ${userPath}`);
        return real;
    }

    private assertAbsolutePathInside(resolved: string, message: string): void {
        const relative = path.relative(this.root, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
    }
}
