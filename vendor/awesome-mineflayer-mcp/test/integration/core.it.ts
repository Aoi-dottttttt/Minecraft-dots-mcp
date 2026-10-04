/**
 * End-to-end integration test against a REAL Minecraft server.
 *
 * Prereqs:
 *   docker compose up -d        # offline-mode server on localhost:25565
 *   npm run build
 *   npm run test:integration
 *
 * Override the target with IT_MC_HOST / IT_MC_PORT / IT_MC_USER.
 * Not run by `npm test`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HOST = process.env.IT_MC_HOST ?? "localhost";
const PORT = Number(process.env.IT_MC_PORT ?? "25565");
const USER = process.env.IT_MC_USER ?? "ITBot";

let client: Client;
let transport: StdioClientTransport;

type Res = { isError?: boolean; content?: Array<{ type: string }>; structuredContent?: any };
async function call(name: string, args: Record<string, unknown> = {}): Promise<Res> {
  return (await client.callTool({ name, arguments: args })) as Res;
}

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: process.cwd(),
    stderr: "inherit",
  });
  client = new Client({ name: "integration", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  try {
    await call("disconnect_bot", {});
  } catch {
    /* ignore */
  }
  await client?.close();
});

describe("integration: live server", () => {
  it("connects to the server", async () => {
    const r = await call("connect_bot", {
      host: HOST,
      port: PORT,
      username: USER,
      auth: "offline",
      connectTimeoutMs: 25_000,
    });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    await call("wait_for_chunks_to_load", {});
  });

  it("reports online state with structured content", async () => {
    const state = await call("get_state", {});
    expect(state.isError).toBeFalsy();
    expect(state.structuredContent?.username).toBeTruthy();

    const obs = await call("get_observation", {});
    expect(obs.structuredContent?.status).toBe("online");
    expect(obs.structuredContent?.self).toBeTruthy();
  });

  it("queries the world and renders a map image", async () => {
    const blocks = await call("find_blocks", { matching: "stone", maxDistance: 32, count: 1 });
    expect(blocks.isError).toBeFalsy();

    const map = await call("render_map", { radius: 8 });
    expect(map.isError).toBeFalsy();
    expect(map.content?.some((c) => c.type === "image")).toBe(true);
  });

  it("renders a real screenshot (or cleanly reports it's unavailable)", async () => {
    const shot = await call("get_screenshot", { width: 320, height: 180, waitMs: 3000 });
    if (shot.isError) {
      // Acceptable if the optional renderer deps / browser aren't present here.
      const text = (shot as any).content?.[0]?.text ?? "";
      expect(text).toMatch(/UNSUPPORTED/);
    } else {
      expect(shot.content?.some((c) => c.type === "image")).toBe(true);
    }
  });

  it("saves and lists a waypoint", async () => {
    const set = await call("set_waypoint", { name: "it_spawn" });
    expect(set.isError).toBeFalsy();
    const list = await call("list_waypoints", {});
    expect(list.structuredContent?.waypoints?.some((w: any) => w.name === "it_spawn")).toBe(true);
    await call("delete_waypoint", { name: "it_spawn" });
  });
});
