import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { HadesEvent } from "../../domain/events.js";
import type { EventStorePort } from "../../ports/EventStore.js";

export class JsonlEventStore implements EventStorePort {
    readonly dataDir: string;
    readonly eventsDir: string;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.eventsDir = path.join(dataDir, "events");
    }

    async init(): Promise<void> {
        await mkdir(this.eventsDir, { recursive: true });
    }

    async append(sessionId: string, type: string, payload: Record<string, any> = {}, meta: Record<string, any> = {}): Promise<HadesEvent> {
        await this.init();
        const event = {
            id: await this.nextId(sessionId),
            sessionId,
            type,
            createdAt: new Date().toISOString(),
            payload,
            ...meta,
        };
        await appendFile(this.fileFor(sessionId), JSON.stringify(event) + "\n", "utf8");
        return event;
    }

    async list(sessionId: string | undefined = undefined): Promise<HadesEvent[]> {
        await this.init();
        if (sessionId) return this.readSessionFile(sessionId);
        const files = await readdir(this.eventsDir).catch(() => []);
        const groups = await Promise.all(
            files.filter((file) => file.endsWith(".jsonl")).map((file) => this.readSessionFile(file.slice(0, -6))),
        );
        return groups.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    }

    private async readSessionFile(sessionId: string): Promise<HadesEvent[]> {
        const raw = await readFile(this.fileFor(sessionId), "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
        });
        return raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) : [];
    }

    private async nextId(sessionId: string): Promise<string> {
        const events = await this.readSessionFile(sessionId);
        const n = events.length + 1;
        return `evt_${String(n).padStart(6, "0")}`;
    }

    private fileFor(sessionId: string): string {
        return path.join(this.eventsDir, `${safeName(sessionId)}.jsonl`);
    }
}

export function safeName(value: string): string {
    return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}
