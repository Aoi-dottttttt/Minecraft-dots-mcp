// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { moveAndVerify } from './movement-utils.js';
import { withServerBlockConfirmation } from './block-confirmation.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
const MAX_FIND_BLOCKS_COUNT = 256;

interface FaceOption {
  direction: string;
  vector: Vec3;
}

export function registerBlockTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "place-block",
    "Place a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      faceDirection: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: 'down')")
    },
    async ({ x, y, z, faceDirection = 'down' }: { x: number, y: number, z: number, faceDirection?: FaceDirection }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const placePos = new Vec3(x, y, z).floored();
      ({ x, y, z } = placePos);

      const botPos = bot.entity.position.floored();
      if (placePos.equals(botPos) || placePos.equals(botPos.offset(0, 1, 0))) {
        return factory.createResponse(`You can't place a block where you're standing or one block above`);
      }

      const blockAtPos = bot.blockAt(placePos);
      if (!blockAtPos) throw new Error('Target chunk is not loaded; placement cancelled');

      if (!['air', 'cave_air', 'void_air'].includes(blockAtPos.name)) {
        return factory.createResponse(`There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z})`);
      }

      const held = bot.heldItem;
      const expectedBlock = held && minecraftData(bot.version).blocksByName[held.name];
      if (!held || !expectedBlock) throw new Error('Hold a placeable block before placing');

      const possibleFaces: FaceOption[] = [
        { direction: 'down', vector: new Vec3(0, -1, 0) },
        { direction: 'north', vector: new Vec3(0, 0, -1) },
        { direction: 'south', vector: new Vec3(0, 0, 1) },
        { direction: 'east', vector: new Vec3(1, 0, 0) },
        { direction: 'west', vector: new Vec3(-1, 0, 0) },
        { direction: 'up', vector: new Vec3(0, 1, 0) }
      ];

      if (faceDirection !== 'down') {
        const specificFace = possibleFaces.find(face => face.direction === faceDirection);
        if (specificFace) {
          possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
        }
      }

      for (const face of possibleFaces) {
        const referencePos = placePos.plus(face.vector);
        const referenceBlock = bot.blockAt(referencePos);

        if (referenceBlock && referenceBlock.name !== 'air') {
          if (!bot.canSeeBlock(referenceBlock)) {
            const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
            await moveAndVerify(bot, goal);
          }

          // Navigation can change both player and world state. Recheck before
          // issuing a side effect; never retry another face after an uncertain click.
          const currentBotPos = bot.entity.position.floored();
          if (placePos.equals(currentBotPos) || placePos.equals(currentBotPos.offset(0, 1, 0))) {
            throw new Error('Placement target now overlaps the player; placement cancelled');
          }
          const currentTarget = bot.blockAt(placePos);
          if (!currentTarget || !['air', 'cave_air', 'void_air'].includes(currentTarget.name)) {
            throw new Error('Placement target changed or unloaded; placement cancelled');
          }
          if (!bot.heldItem || bot.heldItem.type !== held.type) {
            throw new Error('Held item changed during navigation; placement cancelled');
          }
          await bot.lookAt(placePos, true);
          try {
            await withServerBlockConfirmation(bot, placePos, stateId => bot.registry.blocksByStateId[stateId]?.id === expectedBlock.id, () => bot.placeBlock(referenceBlock, face.vector.scaled(-1)));
          } catch (error) {
            throw new Error(`Placement was not confirmed; inspect the target before retrying: ${error instanceof Error ? error.message : String(error)}`);
          }
          const placed = bot.blockAt(placePos);
          if (!placed || placed.type !== expectedBlock.id) {
            throw new Error('Expected block was not observed at target after placement; no retry performed');
          }
          return factory.createResponse(`Placed ${placed.name} at (${x}, ${y}, ${z}) using ${face.direction} face`);
        }
      }

      return factory.createErrorResponse(`Failed to place block at (${x}, ${y}, ${z}): No suitable reference block found`);
    }
  );

  factory.registerTool(
    "dig-block",
    "Dig a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block || block.name === 'air') {
        return factory.createResponse(`No block found at position (${x}, ${y}, ${z})`);
      }

      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        const goal = new goals.GoalNear(x, y, z, 2);
        await moveAndVerify(bot, goal);
      }

      const currentBlock = bot.blockAt(blockPos);
      if (!currentBlock || currentBlock.type !== block.type) {
        throw new Error('Target changed or unloaded during navigation; digging cancelled');
      }
      if (!bot.canDigBlock(currentBlock) || !bot.canSeeBlock(currentBlock)) {
        throw new Error('Target is still not safely reachable for digging');
      }
      await withServerBlockConfirmation(bot, blockPos.floored(), stateId => {
        const type = bot.registry.blocksByStateId[stateId]?.id;
        return type !== undefined && type !== currentBlock.type;
      }, () => bot.dig(currentBlock));
      const after = bot.blockAt(blockPos);
      if (!after || after.type === currentBlock.type) {
        throw new Error('Target block removal was not observed; digging not confirmed');
      }
      return factory.createResponse(`Dug ${block.name} at (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "get-block-info",
    "Get information about a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block) {
        return factory.createResponse(`No block information found at position (${x}, ${y}, ${z})`);
      }

      return factory.createResponse(`Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
    }
  );

  factory.registerTool(
    "find-blocks",
    "Find one or more nearby blocks of a specific type",
    {
      blockType: z.string().describe("Type of block to find"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)"),
      count: z.coerce.number().int().positive().optional().describe("Maximum number of blocks to return (default: 1; values above 256 are clamped)")
    },
    async ({ blockType, maxDistance = 16, count = 1 }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const blocksByName = mcData.blocksByName;
      const normalizedCount = Math.min(count, MAX_FIND_BLOCKS_COUNT);

      if (!blocksByName[blockType]) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }

      const blockId = blocksByName[blockType].id;

      if (normalizedCount === 1) {
        const block = bot.findBlock({
          matching: blockId,
          maxDistance: maxDistance
        });

        if (!block) {
          return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
        }

        return factory.createResponse(`Found ${blockType} at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
      }

      const blocks = bot.findBlocks({
        point: bot.entity.position,
        matching: blockId,
        maxDistance: maxDistance,
        count: normalizedCount
      });

      if (blocks.length === 0) {
        return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
      }

      const blocksList = blocks
        .map((block, i) => `${i + 1}. (${block.x}, ${block.y}, ${block.z})`)
        .join('\n');

      return factory.createResponse(`Found ${blocks.length} ${blockType} block(s) within ${maxDistance} blocks:\n${blocksList}`);
    }
  );
}