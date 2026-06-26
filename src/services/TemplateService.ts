import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocuments } from "../adapters/manifest.js";
import { validateResource } from "../domain/validate.js";
import type { HadesResource } from "../domain/resources.js";

/**
 * Render the prebaked agent templates (examples/templates/*.yaml) with
 * {{name}}/{{namespace}}/{{var}} substitution. Used by `hades new` and the
 * web UI's "New Agent" template picker so spin-up is one action, not four
 * hand-written resources.
 */
export class TemplateService {
    constructor(private readonly dir: string = TemplateService.defaultDir()) {}

    static defaultDir(): string {
        return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../examples/templates");
    }

    /** List available template names (without the .yaml suffix). */
    async list(): Promise<string[]> {
        const files = await readdir(this.dir).catch(() => [] as string[]);
        return files.filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort();
    }

    /**
     * Render a template: substitute {{name}}, {{namespace}}, and any extra
     * vars, returning the parsed + validated resources. Throws if the
     * template or a referenced var is missing.
     */
    async render(template: string, name: string, namespace: string, vars: Record<string, string> = {}): Promise<HadesResource[]> {
        const file = path.join(this.dir, `${template}.yaml`);
        const raw = await readFile(file, "utf8").catch(() => {
            throw new Error(`template '${template}' not found in ${this.dir}`);
        });
        const all = { name, namespace, ...vars };
        const rendered = raw.replace(/\{\{([\w-]+)}}/g, (_, k) => all[k] ?? `{{${k}}}`);
        const resources = parseDocuments(rendered);
        for (const resource of resources) validateResource(resource);
        return resources;
    }
}
