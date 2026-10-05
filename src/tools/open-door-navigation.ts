import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';

const woodenDoors = new Set([
  'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door',
  'dark_oak_door', 'mangrove_door', 'cherry_door', 'bamboo_door',
  'pale_oak_door', 'crimson_door', 'warped_door'
]);
type PlanningNode = Vec3 & { hash: string };
const gridPosition = (node: PlanningNode): Vec3 | null => {
  const coords = node.hash?.split(',').map(Number);
  return coords?.length === 3 && coords.every(Number.isInteger) ? new Vec3(coords[0], coords[1], coords[2]) : null;
};
type PlanningBlock = Block & { safe: boolean; physical: boolean; height: number };
type DoorMovements = Bot['pathfinder']['movements'] & {
  canOpenDoors: boolean;
  blocksToAvoid: Set<number>;
  getBlock(pos: Vec3, dx: number, dy: number, dz: number): PlanningBlock;
  getNeighbors(node: PlanningNode): PlanningNode[];
};

/** Scope the pathfinder 2.4.5 open-door workaround to one verified movement. */
export function allowOpenWoodenDoors(bot: Bot): () => void {
  const original = bot.pathfinder.movements as DoorMovements | undefined;
  if (!original?.getBlock || !original.getNeighbors) return () => {};
  const movements: DoorMovements = Object.assign(Object.create(Object.getPrototypeOf(original)), original);
  Object.assign(movements, {
    canDig: false, canOpenDoors: false, allow1by1towers: false,
    allowParkour: false, allowFreeMotion: false, scafoldingBlocks: []
  });

  const passageAxis = (block: Block | null): 'x' | 'z' | null => {
    if (!block || !woodenDoors.has(block.name) || movements.blocksToAvoid.has(block.type)) return null;
    const props = block.getProperties();
    if (props.open !== true || !['lower', 'upper'].includes(String(props.half)) ||
        !['left', 'right'].includes(String(props.hinge))) return null;
    const other = bot.blockAt(block.position.offset(0, props.half === 'lower' ? 1 : -1, 0), false);
    if (!other || other.name !== block.name) return null;
    const otherProps = other.getProperties();
    if (otherProps.open !== true || otherProps.half !== (props.half === 'lower' ? 'upper' : 'lower') ||
        otherProps.facing !== props.facing || otherProps.hinge !== props.hinge) return null;
    const axis = props.facing === 'north' || props.facing === 'south' ? 'z'
      : props.facing === 'east' || props.facing === 'west' ? 'x' : null;
    if (!axis) return null;
    const transverse = axis === 'z' ? 0 : 2;
    // Each real collision box must leave the central 0.6-wide player corridor
    // clear in both halves. Unknown/modded/malformed geometry fails closed.
    if (![block, other].every(half => Array.isArray(half.shapes) && half.shapes.length > 0 && half.shapes.every(shape =>
      Array.isArray(shape) && shape.length === 6 &&
      shape.every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
      [0, 1, 2].every(index => shape[index] < shape[index + 3]) &&
      (shape[transverse + 3] <= 0.2 || shape[transverse] >= 0.8)))) return null;
    return axis;
  };
  movements.getBlock = function (pos: Vec3, dx: number, dy: number, dz: number): PlanningBlock {
    const block = original.getBlock.call(this, pos, dx, dy, dz);
    // Only planning metadata changes. Preserve world blocks and collision shapes.
    return passageAxis(block) ? Object.assign(Object.create(Object.getPrototypeOf(block)), block, {
      safe: true, physical: false, height: block.position.y
    }) : block;
  };
  movements.getNeighbors = function (node: PlanningNode): PlanningNode[] {
    // A partial search retains these Move objects in its frontier even after
    // post-processing centers its returned waypoints. Expand an integer-grid
    // copy, without moving the waypoint being followed by the controller.
    const raw = gridPosition(node);
    if (raw && !node.equals(raw)) node = Object.assign(Object.create(Object.getPrototypeOf(node)), node, raw);
    return (original.getNeighbors.call(this, node) as PlanningNode[]).filter(next => {
      // Check the swept body cells, not just the endpoints: an air-to-air
      // diagonal can still clip a door leaf in either adjacent corner cell.
      // This conservative rectangle also covers headroom and descending edges.
      for (let x = Math.min(node.x, next.x); x <= Math.max(node.x, next.x); x++) {
        for (let z = Math.min(node.z, next.z); z <= Math.max(node.z, next.z); z++) {
          for (let y = Math.min(node.y, next.y); y <= Math.max(node.y, next.y) + 1; y++) {
            const axis = passageAxis(bot.blockAt(new Vec3(x, y, z), false));
            if (axis && (next.y !== node.y || (axis === 'z' ? next.x !== node.x : next.z !== node.z))) return false;
          }
        }
      }
      return true;
    });
  };
  const onPathUpdate = (result: { path: PlanningNode[] }) => {
    if (bot.pathfinder.movements !== movements) return;
    for (const point of result.path) {
      // postProcessPath moves door points onto the leaf's top. Move.hash still
      // records the A* grid location; restore the waypoint, never entity.position.
      const raw = gridPosition(point);
      if (!raw) continue;
      if (passageAxis(bot.blockAt(raw, false))) point.set(raw.x + 0.5, raw.y, raw.z + 0.5);
    }
  };
  const restore = () => {
    bot.removeListener('path_update', onPathUpdate);
    // Do not overwrite a policy installed by a later owner during cancellation.
    if (bot.pathfinder.movements === movements) bot.pathfinder.setMovements(original);
  };
  bot.on('path_update', onPathUpdate);
  try {
    bot.pathfinder.setMovements(movements);
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}
