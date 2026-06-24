import { readFile } from "node:fs/promises";
import type { HadesResource } from "../domain/resources.js";

export async function loadManifest(file: string): Promise<HadesResource[]> {
    const raw = await readFile(file, "utf8");
    return parseDocuments(raw);
}

export function parseDocuments(raw: string): HadesResource[] {
    return raw.split(/^---\s*$/m).map((doc) => doc.trim()).filter(Boolean).map(parseYamlSubset);
}

function parseYamlSubset(raw: string): HadesResource {
    if (raw.trim().startsWith("{")) return JSON.parse(raw);
    const lines = raw.split("\n");
    const root: Record<string, any> = {};
    const stack: Array<{ indent: number; value: Record<string, any> }> = [{ indent: -1, value: root }];
    for (const rawLine of lines) {
        if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
        const indent = rawLine.match(/^ */)?.[0].length ?? 0;
        const line = rawLine.trim();
        while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
        const parent = stack.at(-1)?.value ?? root;
        const [key, ...rest] = line.split(":");
        const valueText = rest.join(":").trim();
        if (!valueText) {
            parent[key] = {};
            stack.push({ indent, value: parent[key] });
        } else {
            parent[key] = parseScalar(valueText);
        }
    }
    return root as HadesResource;
}

function parseScalar(value: string): string | number | boolean {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+$/.test(value)) return Number(value);
    return value.replace(/^["']|["']$/g, "");
}
