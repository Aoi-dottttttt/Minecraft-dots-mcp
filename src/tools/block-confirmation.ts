// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import type { Bot } from 'mineflayer';
import type { Vec3 } from 'vec3';

type Location = { x: number; y: number; z: number };
type BlockChange = { location: Location; type: number };
type MultiChange = { chunkCoordinates?: Location; chunkX?: number; chunkZ?: number; records: Array<number | { horizontalPos: number; y: number; blockId: number }> };

/** Ignore optimistic Mineflayer blockUpdate events; observe raw server packets. */
export async function withServerBlockConfirmation(
  bot: Bot,
  target: Vec3,
  acceptsState: (stateId: number) => boolean,
  operation: () => Promise<void>,
  timeoutMs = 3000
): Promise<void> {
  let confirmed = false;
  let ended = false;
  let notify: (() => void) | undefined;
  const record = (position: Location, stateId: number) => {
    if (position.x !== target.x || position.y !== target.y || position.z !== target.z) return;
    confirmed = acceptsState(stateId);
    notify?.();
  };
  const single = (packet: BlockChange) => record(packet.location, packet.type);
  const multi = (packet: MultiChange) => {
    for (const value of packet.records) {
      const modern = typeof value === 'number';
      const x = modern ? (value >> 8) & 15 : (value.horizontalPos >> 4) & 15;
      const z = modern ? (value >> 4) & 15 : value.horizontalPos & 15;
      const y = modern ? value & 15 : value.y;
      const chunk = packet.chunkCoordinates ?? { x: packet.chunkX ?? 0, y: 0, z: packet.chunkZ ?? 0 };
      record({ x: chunk.x * 16 + x, y: chunk.y * 16 + y, z: chunk.z * 16 + z }, modern ? value >>> 12 : value.blockId);
    }
  };
  const end = () => { ended = true; notify?.(); };
  bot._client.on('block_change', single);
  bot._client.on('multi_block_change', multi);
  bot.on('end', end);
  try {
    await operation();
    if (ended) throw new Error('Session ended before server block confirmation');
    if (!confirmed) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          notify = undefined;
          reject(new Error('Server block change was not confirmed; inspect the target before retrying'));
        }, timeoutMs);
        notify = () => {
          if (!confirmed && !ended) return;
          clearTimeout(timer);
          notify = undefined;
          if (ended) reject(new Error('Session ended before server block confirmation'));
          else resolve();
        };
        notify();
      });
    }
  } finally {
    notify = undefined;
    bot._client.removeListener('block_change', single);
    bot._client.removeListener('multi_block_change', multi);
    bot.removeListener('end', end);
  }
}
