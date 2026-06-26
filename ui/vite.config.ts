import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Hades UI — a React + Tailwind SPA that talks to the Hades API
// (http://localhost:7347 by default; override with VITE_HADES_API).
export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 5173,
        // Proxy /hades + /healthz to the local API server during dev so the
        // browser origin (5173) doesn't need CORS configured.
        proxy: {
            "/hades": "http://127.0.0.1:7347",
            "/healthz": "http://127.0.0.1:7347",
            "/readyz": "http://127.0.0.1:7347",
        },
    },
    build: {
        outDir: "dist",
        // Emit assets the Hades API can serve statically (see adapters/api/static.ts).
        assetsDir: "assets",
    },
});
