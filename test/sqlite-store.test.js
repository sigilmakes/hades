import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteEventStore } from "../dist/adapters/store/SqliteEventStore.js";
import { SqliteStateStore } from "../dist/adapters/store/SqliteStateStore.js";
import { JsonlEventStore, safeName } from "../dist/adapters/store/JsonlEventStore.js";
import { JsonStateStore } from "../dist/adapters/store/JsonStateStore.js";

test("sqlite event store appends and lists in order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sqlite-evt-"));
    const store = new SqliteEventStore(dir);
    await store.init();
    await store.append("sess-a", "brain.woke", { agent: "a" });
    await store.append("sess-a", "tool.completed", { tool: "read" });
    await store.append("sess-b", "brain.woke", { agent: "b" });
    const a = await store.list("sess-a");
    assert.equal(a.length, 2);
    assert.equal(a[0].type, "brain.woke");
    assert.equal(a[1].type, "tool.completed");
    assert.equal(a[0].sessionId, "sess-a");
    const all = await store.list();
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((e) => e.type), ["brain.woke", "tool.completed", "brain.woke"]);
    store.close();
});

test("sqlite event store preserves payload and meta", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sqlite-evt-"));
    const store = new SqliteEventStore(dir);
    await store.init();
    await store.append("sess", "home.file.written", { path: "vault/x", bytes: 4 }, { trace_id: "t1" });
    const [event] = await store.list("sess");
    assert.deepEqual(event.payload, { path: "vault/x", bytes: 4 });
    assert.equal(event.trace_id, "t1");
    assert.match(event.id, /^evt_\d{6}$/);
    store.close();
});

test("sqlite event store survives a close/reopen (pod restart)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sqlite-evt-"));
    const store = new SqliteEventStore(dir);
    await store.init();
    for (let i = 0; i < 100; i++) await store.append("sess", "tick", { n: i });
    store.close();
    // Reopen — a new instance pointing at the same PVC.
    const reopened = new SqliteEventStore(dir);
    await reopened.init();
    const events = await reopened.list("sess");
    assert.equal(events.length, 100);
    assert.equal(events[0].payload.n, 0);
    assert.equal(events[99].payload.n, 99);
    // IDs resume after the max existing seq, no collision.
    const next = await reopened.append("sess", "tick", { n: 100 });
    assert.notEqual(next.id, events[0].id);
    reopened.close();
});

test("sqlite event store query scales (1000 events, ordered)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sqlite-evt-"));
    const store = new SqliteEventStore(dir);
    await store.init();
    for (let i = 0; i < 1000; i++) await store.append("sess", i % 2 === 0 ? "even" : "odd", { n: i });
    const all = await store.list("sess");
    assert.equal(all.length, 1000);
    // ordered by seq ascending
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].id <= all[i].id, "events must be ordered");
    store.close();
});

test("sqlite state store applies, gets, lists, patches, and removes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sqlite-state-"));
    const store = new SqliteStateStore(dir);
    await store.init();
    await store.apply({ kind: "Agent", metadata: { namespace: "ns", name: "wren" }, spec: { brain: { mode: "test" } } });
    await store.apply({ kind: "Agent", metadata: { namespace: "ns", name: "raven" }, spec: { brain: { mode: "test" } } });
    await store.apply({ kind: "Home", metadata: { namespace: "ns", name: "wren-home" }, spec: {} });
    assert.ok(store.get("Agent", "ns", "wren"));
    assert.equal(store.list("Agent").length, 2);
    assert.equal(store.list("Agent", "ns").length, 2);
    assert.equal(store.findByName("Agent", "wren", "ns").spec.brain.mode, "test");
    await store.patch("Agent", "ns", "wren", { status: { phase: "active" } });
    assert.equal(store.get("Agent", "ns", "wren").status.phase, "active");
    const removed = await store.remove("Agent", "ns", "raven");
    assert.equal(removed, true);
    assert.equal(store.get("Agent", "ns", "raven"), undefined);
    assert.equal(await store.remove("Agent", "ns", "raven"), false, "second remove returns false");
    store.close();
});

test("sqlite state store rejects unsupported kinds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sqlite-state-"));
    const store = new SqliteStateStore(dir);
    await store.init();
    await assert.rejects(store.apply({ kind: "Gateway", metadata: { namespace: "ns", name: "x" }, spec: {} }), /Unsupported kind Gateway/);
    store.close();
});

test("sqlite state store survives a close/reopen (pod restart)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sqlite-state-"));
    const store = new SqliteStateStore(dir);
    await store.init();
    await store.apply({ kind: "Agent", metadata: { namespace: "ns", name: "wren" }, spec: { brain: { mode: "test" } } });
    await store.apply({ kind: "Home", metadata: { namespace: "ns", name: "wren-home" }, spec: { layout: { create: ["vault"] } } });
    store.close();
    const reopened = new SqliteStateStore(dir);
    await reopened.init();
    assert.ok(reopened.get("Agent", "ns", "wren"));
    assert.equal(reopened.get("Home", "ns", "wren-home").spec.layout.create[0], "vault");
    reopened.close();
});

test("migration: JSONL events import into the sqlite store", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-migrate-"));
    // Seed a JSONL event store with events.
    const jsonl = new JsonlEventStore(dir);
    await jsonl.init();
    await jsonl.append("sess", "brain.woke", { agent: "wren" });
    await jsonl.append("sess", "tool.completed", { tool: "read", ok: true });
    // Migrate into sqlite.
    const sqlite = new SqliteEventStore(dir);
    await sqlite.init();
    await migrateJsonlEvents(dir, sqlite);
    const events = await sqlite.list("sess");
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "brain.woke");
    assert.equal(events[1].payload.tool, "read");
    sqlite.close();
});

test("migration: JSON state imports into the sqlite store", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-migrate-"));
    const json = new JsonStateStore(dir);
    await json.init();
    await json.apply({ kind: "Agent", metadata: { namespace: "ns", name: "wren" }, spec: { brain: { mode: "test" } } });
    await json.apply({ kind: "Home", metadata: { namespace: "ns", name: "wren-home" }, spec: {} });
    await json.apply({ kind: "CapabilityGrant", metadata: { namespace: "ns", name: "g" }, spec: { capabilities: ["x"] } });
    // Migrate into sqlite.
    const sqlite = new SqliteStateStore(dir);
    await sqlite.init();
    await migrateJsonState(dir, sqlite);
    assert.ok(sqlite.get("Agent", "ns", "wren"));
    assert.ok(sqlite.get("Home", "ns", "wren-home"));
    assert.equal(sqlite.get("CapabilityGrant", "ns", "g").spec.capabilities[0], "x");
    sqlite.close();
});

/** Import events from a JsonlEventStore data dir into a SqliteEventStore. */
async function migrateJsonlEvents(dir, sqlite) {
    const jsonl = new JsonlEventStore(dir);
    await jsonl.init();
    const events = await jsonl.list();
    for (const event of events) {
        const { id, sessionId, type, createdAt, payload, ...meta } = event;
        // Re-append with original id order preserved via seq; meta carries trace fields.
        sqlite.db.prepare(
            "INSERT INTO events (id, session_id, type, created_at, payload, meta) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, sessionId, type, createdAt, JSON.stringify(payload ?? {}), JSON.stringify(meta ?? {}));
    }
    // Reset seq counter.
    const row = sqlite.db.prepare("SELECT MAX(seq) AS max_seq FROM events").get();
    sqlite.seq = row?.max_seq ?? 0;
}

/** Import resources from a JsonStateStore data dir into a SqliteStateStore. */
async function migrateJsonState(dir, sqlite) {
    const json = new JsonStateStore(dir);
    await json.init();
    for (const kind of Object.keys(json.state)) {
        for (const resource of Object.values(json.state[kind])) {
            await sqlite.apply(resource);
        }
    }
}
