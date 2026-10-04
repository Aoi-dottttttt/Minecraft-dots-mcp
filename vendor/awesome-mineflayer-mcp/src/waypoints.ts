/**
 * Persistent named waypoints, stored under the config home so an agent's spatial
 * memory (home base, mines, villages) survives restarts and reconnects.
 */

import fs from "node:fs";
import path from "node:path";
import { configHome } from "./account-config.js";

export interface Waypoint {
  name: string;
  x: number;
  y: number;
  z: number;
  dimension?: string | null;
  note?: string;
}

function waypointsPath(): string {
  return path.join(configHome(), "waypoints.json");
}

export function loadWaypoints(): Record<string, Waypoint> {
  try {
    const raw = fs.readFileSync(waypointsPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Waypoint>) : {};
  } catch {
    return {};
  }
}

export function saveWaypoints(map: Record<string, Waypoint>): void {
  fs.mkdirSync(configHome(), { recursive: true });
  fs.writeFileSync(waypointsPath(), `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
