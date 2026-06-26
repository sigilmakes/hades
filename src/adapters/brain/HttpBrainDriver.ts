import type { BrainDriver, BrainRunInput } from "../../ports/BrainDriver.js";

/**
 * A {@link BrainDriver} that satisfies `run` by calling a brain pod's
 * `POST /run` endpoint and returning the final reply.
 *
 * This is the parent side of the brain wire: plain HTTP/JSON + SSE. The parent
 * is an orchestrator, not a tool client — it sends a run request and awaits
 * the full reply. Token streaming arrives on the SSE wire but the
 * {@link BrainDriver} port returns `Promise<string>`, so the client consumes
 * the stream and returns the assembled reply.
 *
 * `HADES_BRAIN_URL` (or the constructor arg) is the brain pod base URL, e.g.
 * `http://brain-atlas.hades.svc.cluster.local`.
 */
export class HttpBrainDriver implements BrainDriver {
    readonly mode = "http";
    private readonly baseUrl: string;

    constructor(baseUrl: string = process.env.HADES_BRAIN_URL ?? "http://127.0.0.1:7349") {
        if (!baseUrl) throw new Error("HttpBrainDriver requires a brain base URL (HADES_BRAIN_URL)");
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }

    async run({ agent, session, prompt }: BrainRunInput): Promise<string> {
        const res = await fetch(`${this.baseUrl}/run`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify({ agent, session, prompt }),
        });
        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            throw new Error(`brain run failed (${res.status}): ${text || res.statusText}`);
        }
        return consumeSseReply(res.body);
    }
}

/**
 * Consume an SSE stream from the brain pod `/run` endpoint and return the
 * assembled reply. Emits a done/error terminal event.
 *
 * Exported for tests.
 */
export async function consumeSseReply(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reply = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const chunk of events) {
            const data = chunk.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
            if (!data) continue;
            const event = JSON.parse(data);
            if (event.type === "token") reply += String(event.delta ?? "");
            else if (event.type === "done") return String(event.reply ?? reply);
            else if (event.type === "error") throw new Error(`brain pod error: ${event.message}`);
        }
    }
    return reply;
}
