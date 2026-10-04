// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { moveAndVerify, DEFAULT_MOVE_TIMEOUT_MS, MAX_MOVE_TIMEOUT_MS } from './movement-utils.js';

type Direction = 'forward' | 'back' | 'left' | 'right';

export function registerPositionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "get-position",
    "Get the current position of the bot",
    {},
    async () => {
      const bot = getBot();
      const position = bot.entity.position;
      const pos = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
      };
      return factory.createResponse(`Current position: (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "move-to-position",
    "Move the bot to a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      range: z.coerce.number().finite().min(0).max(64).optional().describe("How close to get to the target (default: 1)"),
      timeoutMs: z.number().int().min(50).max(MAX_MOVE_TIMEOUT_MS).optional().describe("Timeout in milliseconds before cancelling (50–60000, default: 15000)")
    },
    async ({ x, y, z, range = 1, timeoutMs = DEFAULT_MOVE_TIMEOUT_MS }: { x: number; y: number; z: number; range?: number; timeoutMs?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const goal = new goals.GoalNear(x, y, z, range);
      await moveAndVerify(bot, goal, timeoutMs);
      const actual = bot.entity.position;
      return factory.createResponse(`Successfully moved to position near (${x}, ${y}, ${z}); current position (${actual.x.toFixed(2)}, ${actual.y.toFixed(2)}, ${actual.z.toFixed(2)})`);
    }
  );

  factory.registerTool(
    "look-at",
    "Make the bot look at a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      await bot.lookAt(new Vec3(x, y, z), true);
      return factory.createResponse(`Looking at position (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "jump",
    "Make the bot jump",
    {},
    async () => {
      const bot = getBot();
      bot.setControlState('jump', true);
      try {
        await new Promise(resolve => setTimeout(resolve, 250));
      } finally {
        bot.setControlState('jump', false);
      }
      return factory.createResponse("Jump control applied for 250ms");
    }
  );

  factory.registerTool(
    "move-in-direction",
    "Move the bot in a specific direction for a duration",
    {
      direction: z.enum(['forward', 'back', 'left', 'right']).describe("Direction to move"),
      duration: z.number().int().min(1).max(2000).optional().describe("Duration in milliseconds (1–2000, default: 1000)")
    },
    async ({ direction, duration = 1000 }: { direction: Direction, duration?: number }) => {
      const bot = getBot();
      const before = bot.entity.position.clone();
      bot.setControlState(direction, true);
      try {
        await new Promise(resolve => setTimeout(resolve, duration));
      } finally {
        bot.setControlState(direction, false);
      }
      const actual = bot.entity.position;
      const moved = actual.distanceTo(before);
      return factory.createResponse(`Applied ${direction} control for ${duration}ms; observed displacement ${moved.toFixed(2)} blocks, current position (${actual.x.toFixed(2)}, ${actual.y.toFixed(2)}, ${actual.z.toFixed(2)})`);
    }
  );
}
