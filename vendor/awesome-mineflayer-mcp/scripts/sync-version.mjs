#!/usr/bin/env node
/**
 * Propagate package.json's version into the other places that hard-code it, so a
 * single `npm version <x>` keeps everything in sync. Wired to the npm `version`
 * lifecycle script, which runs after the bump and before the commit/tag.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

// src/config.ts → SERVER_VERSION
const cfgPath = path.join(root, "src", "config.ts");
const cfg = fs.readFileSync(cfgPath, "utf8");
const cfgNext = cfg.replace(/export const SERVER_VERSION = "[^"]*";/, `export const SERVER_VERSION = "${version}";`);
if (cfg === cfgNext && !cfg.includes(`SERVER_VERSION = "${version}"`)) {
  console.error("sync-version: could not find SERVER_VERSION in config.ts");
  process.exit(1);
}
fs.writeFileSync(cfgPath, cfgNext);

// server.json → top-level version + npm package version
const sjPath = path.join(root, "server.json");
const sj = JSON.parse(fs.readFileSync(sjPath, "utf8"));
sj.version = version;
for (const p of sj.packages ?? []) if (p.registryType === "npm") p.version = version;
fs.writeFileSync(sjPath, JSON.stringify(sj, null, 2) + "\n");

console.log(`sync-version: set ${version} in src/config.ts and server.json`);
