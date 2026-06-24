import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nameOf, namespaceOf, type HadesResource } from "../domain/resources.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { StateStorePort } from "../ports/StateStore.js";

export class HomeService {
    constructor(
        private readonly dataDir: string,
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
    ) {}

    async reconcileHomes(): Promise<void> {
        for (const home of this.state.list("Home")) await this.reconcileHome(home);
    }

    async reconcileHome(home: HadesResource): Promise<void> {
        const namespace = namespaceOf(home);
        const homePath = home.spec?.path ?? path.join(this.dataDir, "homes", namespace, nameOf(home));
        for (const dir of home.spec?.layout?.create ?? ["vault", "bin", "cron.d", "projects", "skills", "inbox", "outbox"]) {
            await mkdir(path.join(homePath, dir), { recursive: true });
        }
        for (const file of home.spec?.files ?? []) {
            const relativePath = String(file.path ?? "");
            if (!relativePath) throw new Error(`Home ${nameOf(home)} has a bootstrap file without path`);
            const target = safeHomePath(homePath, relativePath);
            await mkdir(path.dirname(target), { recursive: true });
            if (!file.overwrite && await exists(target)) continue;
            await writeFile(target, String(file.content ?? ""), "utf8");
            if (file.mode) await chmod(target, Number.parseInt(String(file.mode), 8));
        }
        home.status = { ...(home.status ?? {}), phase: "ready", path: homePath };
        await this.events.append("system", "home.ready", { home: nameOf(home), path: homePath });
    }
}

async function exists(file: string): Promise<boolean> {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

function safeHomePath(homePath: string, relativePath: string): string {
    const root = path.resolve(homePath);
    const target = path.resolve(root, relativePath);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Home bootstrap file escapes home: ${relativePath}`);
    return target;
}
