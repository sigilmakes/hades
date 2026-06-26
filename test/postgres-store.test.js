import test from "node:test";
import assert from "node:assert/strict";
import { PostgresStateStore } from "../dist/adapters/store/PostgresStateStore.js";
import { PostgresEventStore } from "../dist/adapters/store/PostgresEventStore.js";

// These tests require a live Postgres at DATABASE_URL. They prove the adapters
// work end-to-end against a real DB; without one they skip (no DB in CI by
// default). Run locally with: docker run -e POSTGRES_PASSWORD=hades -p 5432:5432 postgres
//   DATABASE_URL=postgres://postgres:hades@localhost:5432/hades npx node --test test/postgres-store.test.js
const pgAvailable = Boolean(process.env.DATABASE_URL);

test("PostgresStateStore apply/load/get/list/remove behind the port", { skip: !pgAvailable }, async () => {
    const store = new PostgresStateStore();
    await store.init();
    await store.apply({ kind: "Agent", metadata: { namespace: "pg-test", name: "atlas" }, spec: { lifecycle: "resident" } });
    const got = store.get("Agent", "pg-test", "atlas");
    assert.ok(got, "agent retrieved");
    assert.equal(got.spec.lifecycle, "resident");
    assert.equal(store.list("Agent", "pg-test").length, 1);
    // durable: a fresh store sees it
    const store2 = new PostgresStateStore();
    await store2.init();
    assert.ok(store2.get("Agent", "pg-test", "atlas"), "survived a new store");
    // remove
    assert.equal(await store.remove("Agent", "pg-test", "atlas"), true);
    assert.equal(await store.remove("Agent", "pg-test", "atlas"), false);
    await store.close();
    await store2.close();
});

test("PostgresEventStore append/list/subscribe behind the port", { skip: !pgAvailable }, async () => {
    const store = new PostgresEventStore();
    await store.init();
    const seen = [];
    const unsub = store.subscribe((e) => seen.push(e.type));
    const evt = await store.append("pg-session", "brain.woke", { agent: "atlas" });
    assert.match(evt.id, /evt_/);
    const all = await store.list("pg-session");
    assert.ok(all.some((e) => e.id === evt.id));
    // subscribe fired
    assert.ok(seen.includes("brain.woke"), "subscriber received the appended event");
    unsub();
    await store.close();
});
