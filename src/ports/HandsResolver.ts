import type { HadesResource } from "../domain/resources.js";
import type { HandsBackend } from "./HandsBackend.js";

/**
 * Resolves the Hands backend for a given agent + session.
 *
 * This port replaces the in-process closure leak where `createRuntime` wired
 * `handsFor` as a function closing over private `agents`/`events` state. Both
 * modes satisfy it:
 *
 * - **Dev mode** returns an in-process `LocalConfinedHands` over the agent's
 *   local home directory.
 * - **Deploy mode** returns an MCP client (`McpHandsClient`) to a hands pod.
 *
 * The brain drivers depend on this resolver, not on concrete hands adapters,
 * so the hands substrate can change without touching brain logic.
 */
export interface HandsResolver {
    for(agent: HadesResource, session: HadesResource): HandsBackend;
}
