#!/usr/bin/env node
import { HandsPod } from "./server.js";

const port = Number(process.env.PORT ?? process.env.HADES_HANDS_PORT ?? 7350);

const pod = new HandsPod();
pod.listen(port, () => {
    console.log(`hades hands-pod listening on :${port} (wire=mcp-streamable-http, home=${process.env.HADES_HOME_ROOT ?? "/home/agent"})`);
});

process.on("SIGTERM", async () => {
    await pod.close();
    process.exit(0);
});
