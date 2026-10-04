import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  saveConfig,
  resolveDefaultConnect,
  defaultProfilesFolder,
  configPath,
} from "../src/account-config.js";

const HOME = path.join(os.tmpdir(), `amm-cfg-test-${process.pid}`);

const ENV_KEYS = [
  "AWESOME_MINEFLAYER_MCP_HOME",
  "MCP_DEFAULT_HOST",
  "MCP_DEFAULT_PORT",
  "MCP_DEFAULT_USERNAME",
  "MCP_DEFAULT_AUTH",
  "MCP_DEFAULT_VERSION",
  "MCP_DEFAULT_AUTO_RECONNECT",
  "MCP_PROFILES_FOLDER",
  "MCP_AUTO_CONNECT",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fs.rmSync(HOME, { recursive: true, force: true });
  process.env.AWESOME_MINEFLAYER_MCP_HOME = HOME;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe("account-config", () => {
  it("returns null when nothing is configured", () => {
    const r = resolveDefaultConnect();
    expect(r.opts).toBeNull();
    expect(r.source).toBe("none");
    expect(r.autoConnect).toBe(false);
  });

  it("reads an offline account from the config file", () => {
    saveConfig({ account: { host: "mc.example.com", port: 25566, username: "Bot", auth: "offline" } });
    expect(fs.existsSync(configPath())).toBe(true);
    const r = resolveDefaultConnect();
    expect(r.source).toBe("file");
    expect(r.opts).toMatchObject({ host: "mc.example.com", port: 25566, username: "Bot", auth: "offline" });
    expect(r.autoConnect).toBe(true); // defaults on when an account exists
    expect(r.opts?.profilesFolder).toBeUndefined(); // offline => no profiles folder
  });

  it("defaults profilesFolder under the config home for microsoft accounts", () => {
    saveConfig({ account: { host: "h", username: "me@example.com", auth: "microsoft" } });
    const r = resolveDefaultConnect();
    expect(r.opts?.auth).toBe("microsoft");
    expect(r.opts?.profilesFolder).toBe(defaultProfilesFolder());
  });

  it("lets environment variables override the file", () => {
    saveConfig({ account: { host: "file-host", username: "FileBot", auth: "offline" }, autoConnect: true });
    process.env.MCP_DEFAULT_HOST = "env-host";
    process.env.MCP_DEFAULT_USERNAME = "EnvBot";
    process.env.MCP_AUTO_CONNECT = "false";
    const r = resolveDefaultConnect();
    expect(r.source).toBe("env");
    expect(r.opts).toMatchObject({ host: "env-host", username: "EnvBot" });
    expect(r.autoConnect).toBe(false);
  });

  it("can configure a default purely from env with no file", () => {
    process.env.MCP_DEFAULT_HOST = "only-env";
    process.env.MCP_DEFAULT_USERNAME = "EnvOnly";
    process.env.MCP_DEFAULT_AUTH = "microsoft";
    const r = resolveDefaultConnect();
    expect(r.opts).toMatchObject({ host: "only-env", username: "EnvOnly", auth: "microsoft" });
    expect(r.source).toBe("env");
  });
});
