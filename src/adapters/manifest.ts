import { readFile } from "node:fs/promises";
import { load as loadYaml } from "js-yaml";
import type { HadesResource } from "../domain/resources.js";

/**
 * Load a manifest file (JSON or YAML, single- or multi-document) into Hades
 * resources. Accepts any valid k8s YAML: multi-doc (--- separators), block
 * scalars, arrays-of-objects, anchors, quoted strings.
 */
export async function loadManifest(file: string): Promise<HadesResource[]> {
    const raw = await readFile(file, "utf8");
    return parseDocuments(raw);
}

/**
 * Parse a raw manifest string into Hades resources. Splits on `---` document
 * separators, then parses each non-empty document as YAML (JSON is a subset of
 * YAML, so JSON documents parse too). Empty documents (leading/trailing `---`)
 * are dropped.
 */
export function parseDocuments(raw: string): HadesResource[] {
    return raw
        .split(/^---\s*$/m)
        .map((doc) => doc.trim())
        .filter(Boolean)
        .map((doc) => loadYaml(doc) as HadesResource)
        .filter((resource): resource is HadesResource => resource !== null && typeof resource === "object");
}
