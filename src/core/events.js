import { mkdir, readFile, appendFile, readdir } from "node:fs/promises";
import path from "node:path";

export class EventStore {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.eventsDir = path.join(dataDir, "events");
    }

    async init() {
        await mkdir(this.eventsDir, { recursive: true });
    }

    async append(sessionId, type, payload = {}, meta = {}) {
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

    async list(sessionId = undefined) {
        await this.init();
        if (sessionId) return this.readFile(sessionId);
        const files = await readdir(this.eventsDir).catch(() => []);
        const groups = await Promise.all(
            files.filter((file) => file.endsWith(".jsonl")).map((file) => this.readFile(file.slice(0, -6))),
        );
        return groups.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    }

    async readFile(sessionId) {
        const raw = await readFile(this.fileFor(sessionId), "utf8").catch((error) => {
            if (error.code === "ENOENT") return "";
            throw error;
        });
        return raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) : [];
    }

    async nextId(sessionId) {
        const events = await this.readFile(sessionId);
        const n = events.length + 1;
        return `evt_${String(n).padStart(6, "0")}`;
    }

    fileFor(sessionId) {
        return path.join(this.eventsDir, `${safeName(sessionId)}.jsonl`);
    }
}

export function safeName(value) {
    return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}
