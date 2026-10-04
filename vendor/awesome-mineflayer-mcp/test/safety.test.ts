import { describe, it, expect, afterEach, vi } from "vitest";
import { redactSecrets } from "../src/util/redact.js";
import { checkCommand, checkHost } from "../src/config.js";

describe("redactSecrets", () => {
  it("masks known secrets and leaves the rest intact", () => {
    expect(redactSecrets("auth failed: token=hunter2pass!", ["hunter2pass!"])).toBe("auth failed: token=***");
  });
  it("ignores too-short / empty / nullish secrets", () => {
    expect(redactSecrets("abc", ["ab"])).toBe("abc");
    expect(redactSecrets("xy", [undefined, null, ""])).toBe("xy");
  });
});

describe("command policy (defaults, no env)", () => {
  it("blocks server-administration commands", () => {
    expect(checkCommand("/op Steve").allowed).toBe(false);
    expect(checkCommand("ban Griefer").allowed).toBe(false);
    expect(checkCommand("/minecraft:stop").allowed).toBe(false);
  });

  it("does not fail open on leading whitespace / extra slashes", () => {
    expect(checkCommand("  op Steve").allowed).toBe(false);
    expect(checkCommand("//op Steve").allowed).toBe(false);
    expect(checkCommand("/  op Steve").allowed).toBe(false);
    expect(checkCommand("/minecraft:op Steve").allowed).toBe(false);
  });

  it("blocks command wrappers that could run a denied command", () => {
    expect(checkCommand("/execute as @s run op @s").allowed).toBe(false);
    expect(checkCommand("function my:pack").allowed).toBe(false);
  });
  it("allows ordinary gameplay commands and empty input", () => {
    expect(checkCommand("/tp @s 0 64 0").allowed).toBe(true);
    expect(checkCommand("time set day").allowed).toBe(true);
    expect(checkCommand("").allowed).toBe(true);
  });
});

describe("host policy (default: any host)", () => {
  it("permits any host when no allow-list is configured", () => {
    expect(checkHost("play.example.net").allowed).toBe(true);
  });
});

describe("configurable policies (env-driven)", () => {
  afterEach(() => {
    delete process.env.MCP_COMMAND_ALLOW;
    delete process.env.MCP_COMMAND_DENY;
    delete process.env.MCP_ALLOWED_HOSTS;
    vi.resetModules();
  });

  it("allow-list mode permits only listed commands", async () => {
    vi.resetModules();
    process.env.MCP_COMMAND_ALLOW = "tp,time";
    const cfg = await import("../src/config.js");
    expect(cfg.checkCommand("/tp @s ~ ~ ~").allowed).toBe(true);
    expect(cfg.checkCommand("/give @s diamond").allowed).toBe(false);
    // The fail-open hole would have let a space-prefixed command slip the allow-list:
    expect(cfg.checkCommand("  give @s diamond").allowed).toBe(false);
  });

  it('empty MCP_COMMAND_DENY="" allows everything', async () => {
    vi.resetModules();
    process.env.MCP_COMMAND_DENY = "";
    const cfg = await import("../src/config.js");
    expect(cfg.checkCommand("/op Steve").allowed).toBe(true);
  });

  it("host allow-list restricts which servers the bot may join", async () => {
    vi.resetModules();
    process.env.MCP_ALLOWED_HOSTS = "localhost,play.example.net";
    const cfg = await import("../src/config.js");
    expect(cfg.checkHost("localhost").allowed).toBe(true);
    expect(cfg.checkHost("PLAY.EXAMPLE.NET").allowed).toBe(true); // case-insensitive
    expect(cfg.checkHost("evil.example.com").allowed).toBe(false);
  });
});
