# Evaluation fixture

The questions in `evaluation.xml` are **read-only** and have stable answers **only against the seeded world described here**. A live Minecraft world is not deterministic, so this fixture pins the world, the bot, and a fixed set of placed blocks / items / mobs. Set it up exactly, then run the evaluation harness pointing the bot at this server.

## Server

- Minecraft Java Edition **1.20.4**, **superflat** preset **"Classic Flat"** (bedrock at y=0, dirt y=1–2, grass_block top at y=3).
- Run these once (as operator console) before connecting the bot:

```
/gamerule doDaylightCycle false
/gamerule doWeatherCycle false
/time set 6000
/weather clear
/difficulty peaceful
/setblock 50 4 50 minecraft:diamond_ore
/setblock 51 4 50 minecraft:diamond_ore
/setblock 52 4 50 minecraft:diamond_ore
/setblock 50 4 52 minecraft:crafting_table
/setblock 50 4 54 minecraft:furnace
/setblock 50 4 56 minecraft:chest
/summon minecraft:cow 60 4 60
/summon minecraft:cow 61 4 60
/summon minecraft:pig 62 4 60
```

## Bot

- Connect with `connect_bot { host: <server>, username: "EvalBot", auth: "offline" }`.
- After spawn, run as operator:

```
/give EvalBot minecraft:oak_planks 4
/give EvalBot minecraft:stick 8
/give EvalBot minecraft:iron_ingot 3
/tp EvalBot 50 4 48
```

- Then call `wait_for_chunks_to_load` before answering.

All answers below follow deterministically from this exact setup.
