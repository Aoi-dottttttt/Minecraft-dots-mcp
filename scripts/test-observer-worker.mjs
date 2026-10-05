// Executes the exact pinned browser worker against synthetic 1.21.1 data.
// No sockets, browser, live server, user files or network access are provided.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('prismarine-viewer/package.json'));
const callbacks = [], messages = [];
const context = { performance, TextEncoder, TextDecoder, AbortController, AbortSignal,
  console: { log() {}, warn() {}, error() {} },
  setInterval(callback) { callbacks.push(callback); }, setTimeout, clearTimeout,
  postMessage(message) { messages.push(message); } };
context.self = context;
try {
  vm.runInContext(readFileSync(join(root, 'public/worker.js'), 'utf8'), vm.createContext(context), { timeout: 15000 });
  const { Vec3 } = require('vec3'), data = require('minecraft-data')('1.21.1'), Chunk = require('prismarine-chunk')('1.21.1'), chunk = new Chunk();
  chunk.setBlockStateId(new Vec3(8, 63, 8), data.blocksByName.grass_block.defaultState);
  for (const data of [{ type: 'version', version: '1.21.1' },
    { type: 'blockStates', json: JSON.parse(readFileSync(join(root, 'public/blocksStates/1.21.1.json'), 'utf8')) },
    { type: 'chunk', x: 0, z: 0, chunk: chunk.toJson() }, { type: 'dirty', x: 0, y: 48, z: 0 }]) context.self.onmessage({ data });
  for (const callback of callbacks) callback();
  const geometry = messages.find(message => message.type === 'geometry');
  assert.ok(geometry?.geometry.positions.length > 0, 'Pinned browser worker must render 1.21.1 chunk geometry');
  console.log(JSON.stringify({ passed: true, pinnedBrowserWorker: 'prismarine-viewer@1.33.0', version: '1.21.1', vertices: geometry.geometry.positions.length / 3, browserPixelsVerified: false }));
} catch (error) {
  // V8 stacks of a minified bundle can include its entire 61 MB source line.
  console.error('Synthetic worker verification failed: ' + error.message); process.exitCode = 1;
}
