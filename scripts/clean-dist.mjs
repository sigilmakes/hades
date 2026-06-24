import { rm } from "node:fs/promises";
import path from "node:path";

const dist = path.resolve(process.cwd(), "dist");
const cwd = path.resolve(process.cwd());

if (path.basename(dist) !== "dist" || !dist.startsWith(cwd + path.sep)) {
    throw new Error(`Refusing to clean unexpected build directory: ${dist}`);
}

await rm(dist, { recursive: true, force: true });
