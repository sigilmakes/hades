import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serve the built Hades web UI (a Vite/React SPA in `ui/dist`) at the root.
 *
 * The API routes (`/hades/...`, `/healthz`, `/readyz`) are matched first by the
 * server; anything else falls through here. For a path with a file extension
 * we serve the asset verbatim (with a long cache). For any other path we serve
 * `index.html` so client-side routing (e.g. /agents/atlas) works on refresh.
 *
 * If the UI has not been built, the API still serves normally — static serving
 * is a no-op, not an error.
 */
const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

export function createStaticHandler(uiDir: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
    return async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        // Only serve GETs that aren't API routes.
        if (req.method !== "GET" || url.pathname.startsWith("/hades/") || url.pathname === "/healthz" || url.pathname === "/readyz") {
            return false;
        }
        // Resolve the requested path under uiDir, guarding against traversal.
        const rel = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
        const candidate = path.join(uiDir, rel);
        if (!candidate.startsWith(uiDir)) return false;

        try {
            const info = await stat(candidate);
            const file = info.isDirectory() ? path.join(candidate, "index.html") : candidate;
            const data = await readFile(file);
            const ext = path.extname(file);
            res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable" });
            res.end(data);
            return true;
        } catch {
            // No matching file — serve index.html for SPA client routing.
            try {
                const index = await readFile(path.join(uiDir, "index.html"));
                res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
                res.end(index);
                return true;
            } catch {
                return false; // UI not built — let the server 404.
            }
        }
    };
}
