#!/usr/bin/env node
import { BrainPod } from "./server.js";

const port = Number(process.env.PORT ?? process.env.HADES_BRAIN_PORT ?? 7349);
const mode = process.env.HADES_BRAIN_MODE ?? "pi-sdk";

const pod = new BrainPod({ mode });
pod.listen(port, () => {
    console.log(`hades brain-pod listening on :${port} (mode=${mode}, hands=${process.env.HADES_HANDS_URL ?? "unset"})`);
});

process.on("SIGTERM", async () => {
    await pod.close();
    process.exit(0);
});
