// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import { interruptible, type InterruptibleOptions } from '../action-interruption.js';
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
import { placementProvenance } from '../placement-provenance.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
const MAX_FIND_BLOCKS_COUNT = 256;
const MAX_PLACEMENT_REACH = 4.5;
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);

interface FaceOption {
  direction: string;
  vector: Vec3;
}

export function registerBlockTools(factory: ToolFactory, getBot: () => mineflayer.Bot, getOptions: () => InterruptibleOptions = () => ({})): void {
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
      const options = getOptions();
      options.signal?.throwIfAborted();
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

      const item = bot.heldItem;
      const held = item && { type: item.type, name: item.name, count: item.count };
      const window = bot.currentWindow;
      const handSlot = bot.quickBarSlot;
      const client = bot._client;
      const dimension = bot.game?.dimension;
      const clientState = client.state;
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
        options.signal?.throwIfAborted();
        const referencePos = placePos.plus(face.vector);
        const referenceBlock = bot.blockAt(referencePos);

        if (referenceBlock && !AIR_BLOCKS.has(referenceBlock.name)) {
          const reference = { type: referenceBlock.type, name: referenceBlock.name, stateId: referenceBlock.stateId };
          const clickedFace = face.vector.scaled(-1);
          // This is the same center used by Mineflayer's public placeBlock.
          const facePoint = referencePos.offset(0.5, 0.5, 0.5).plus(clickedFace.scaled(0.5));
          if (!bot.canSeeBlock(referenceBlock)) {
            const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
            await moveAndVerify(bot, goal, undefined, options);
            options.signal?.throwIfAborted();
          }

          // Navigation and the rotation tick can both invalidate preparation.
          // Snapshot primitives: Mineflayer can mutate the same objects in place.
          const validate = () => {
            options.signal?.throwIfAborted();
            if (getBot() !== bot || bot._client !== client || client.state !== clientState || bot.game?.dimension !== dimension ||
              bot.health <= 0 || (bot as mineflayer.Bot & { isAlive?: boolean }).isAlive === false) {
              throw new Error('Session changed before placement; placement cancelled');
            }
            if (bot.currentWindow !== window || bot.quickBarSlot !== handSlot ||
              bot.heldItem?.type !== held.type || bot.heldItem?.name !== held.name || bot.heldItem?.count !== held.count) {
              throw new Error('Held item or inventory window changed; placement cancelled');
            }
            const currentBotPos = bot.entity.position.floored();
            if (placePos.equals(currentBotPos) || placePos.equals(currentBotPos.offset(0, 1, 0))) {
              throw new Error('Placement target now overlaps the player; placement cancelled');
            }
            const currentTarget = bot.blockAt(placePos);
            if (!currentTarget || !AIR_BLOCKS.has(currentTarget.name)) {
              throw new Error('Placement target changed or unloaded; placement cancelled');
            }
            const currentReference = bot.blockAt(referencePos);
            if (!currentReference || currentReference.type !== reference.type || currentReference.name !== reference.name ||
              currentReference.stateId !== reference.stateId) {
              throw new Error('Reference block changed or unloaded; placement cancelled');
            }
            const distance = bot.entity.position.offset(0, (bot.entity as typeof bot.entity & { eyeHeight: number }).eyeHeight, 0).distanceTo(facePoint);
            if (!Number.isFinite(distance) || distance > MAX_PLACEMENT_REACH || !bot.canSeeBlock(currentReference)) {
              throw new Error('Placement face is not safely reachable (tool limit: 4.5 blocks); placement cancelled');
            }
            return currentReference;
          };
          validate();
          const entity = bot.entity as typeof bot.entity & { eyeHeight: number };
          const position = entity.position.clone();
          const eyeHeight = entity.eyeHeight;
          const height = entity.height;
          let sessionChanged = false;
          const invalidate = () => { sessionChanged = true; };
          bot.on('end', invalidate);
          bot.on('respawn', invalidate);
          client.on('respawn', invalidate);
          client.on('start_configuration', invalidate);
          try {
            const beforeYaw = entity.yaw;
            const beforePitch = entity.pitch;
            await bot.lookAt(facePoint, true);
            options.signal?.throwIfAborted();
            if (entity.yaw === beforeYaw && entity.pitch === beforePitch) {
              // In 4.39.0, look returns before handling force when the rounded
              // local delta is zero. A previous non-forced turn can therefore
              // still be in flight. Use only public look APIs: this <1 degree
              // turn exceeds its 0.15 degree quantization, then the exact face
              // aim reaches force's synchronization branch. Both forced calls
              // settle in microtasks before the next native physics tick.
              await bot.look(entity.yaw + 0.01, entity.pitch, true);
              options.signal?.throwIfAborted();
              const nudgedYaw = entity.yaw;
              const nudgedPitch = entity.pitch;
              if (!Number.isFinite(nudgedYaw) || !Number.isFinite(nudgedPitch) || nudgedYaw === beforeYaw) {
                throw new Error('Could not synchronize placement rotation; placement cancelled');
              }
              await bot.lookAt(facePoint, true);
              options.signal?.throwIfAborted();
              if (entity.yaw === nudgedYaw && entity.pitch === nudgedPitch) {
                throw new Error('Could not restore clicked-face rotation; placement cancelled');
              }
            }
            const { yaw, pitch } = entity;
            const delta = facePoint.minus(position.offset(0, eyeHeight, 0));
            const wantedYaw = Math.atan2(-delta.x, -delta.z);
            const wantedPitch = Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z));
            // The public placement's second look must round to zero in the
            // pinned 0.15-degree quantizer. Reject non-finite/extreme poses.
            // Keep the pinned fromNotchianPitch conversion's rounding exactly.
            const sensitivity = ((Math.PI / 180 * -0.15 + Math.PI) % (2 * Math.PI)) - Math.PI;
            if (![yaw, pitch, wantedYaw, wantedPitch].every(Number.isFinite) ||
              Math.round((wantedYaw - yaw) / sensitivity) !== 0 || Math.round((wantedPitch - pitch) / sensitivity) !== 0) {
              throw new Error('Clicked-face rotation is not stable; placement cancelled');
            }
            // Forced look updates local rotation immediately, but the pinned
            // Mineflayer sends it during the next physics tick. That tick's
            // synchronous position/look write precedes this await continuation.
            await bot.waitForTicks(1);
            validate();
            if (sessionChanged || bot.entity !== entity || !entity.position.equals(position) ||
              entity.eyeHeight !== eyeHeight || entity.height !== height || entity.yaw !== yaw || entity.pitch !== pitch) {
              throw new Error('Player pose or session changed while aiming; placement cancelled');
            }
            // A stable origin and rotation make placeBlock's internal look at
            // this same point a no-op; it cannot start a second unguarded turn.
          } finally {
            bot.removeListener('end', invalidate);
            bot.removeListener('respawn', invalidate);
            client.removeListener('respawn', invalidate);
            client.removeListener('start_configuration', invalidate);
          }
          const currentReference = validate();
          const placement = placementProvenance(bot)?.begin(placePos, held.name);
          const deadline = Date.now() + 3000;
          try {
            await withServerBlockConfirmation(bot, placePos, stateId => bot.registry.blocksByStateId[stateId]?.id === expectedBlock.id, () => {
              options.signal?.throwIfAborted();
              placement?.arm();
              return bot.placeBlock(currentReference, clickedFace);
            });
            await placement?.confirm(Math.max(1, deadline - Date.now()), options.signal);
            options.signal?.throwIfAborted();
          } catch (error) {
            throw new Error(`Placement was not confirmed; inspect the target before retrying: ${error instanceof Error ? error.message : String(error)}`);
          } finally { placement?.dispose(); }
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
      const options = getOptions();
      options.signal?.throwIfAborted();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block || block.name === 'air') {
        return factory.createResponse(`No block found at position (${x}, ${y}, ${z})`);
      }

      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        const goal = new goals.GoalNear(x, y, z, 2);
        await moveAndVerify(bot, goal, undefined, options);
        options.signal?.throwIfAborted();
      }

      const currentBlock = bot.blockAt(blockPos);
      if (!currentBlock || currentBlock.type !== block.type) {
        throw new Error('Target changed or unloaded during navigation; digging cancelled');
      }
      if (!bot.canDigBlock(currentBlock) || !bot.canSeeBlock(currentBlock)) {
        throw new Error('Target is still not safely reachable for digging');
      }
      await interruptible(options, () => withServerBlockConfirmation(bot, blockPos.floored(), stateId => {
        const type = bot.registry.blocksByStateId[stateId]?.id;
        return type !== undefined && type !== currentBlock.type;
      }, () => { options.signal?.throwIfAborted(); return bot.dig(currentBlock); }));
      options.signal?.throwIfAborted();
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
