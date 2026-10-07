// Executes the exact pinned browser worker against synthetic 1.21.1 data.
// No sockets, browser, live server, user files or network access are provided.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { viewerAsset } from '../dist/viewer-compatibility.js';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('prismarine-viewer/package.json'));
const callbacks = [], messages = [];
const context = { performance, TextEncoder, TextDecoder, AbortController, AbortSignal,
  console: { log() {}, warn() {}, error() {} },
  setInterval(callback) { callbacks.push(callback); }, setTimeout, clearTimeout,
  postMessage(message) { messages.push(message); } };
context.self = context;
try {
  const sandbox = vm.createContext(context);
  vm.runInContext(viewerAsset('worker.js'), sandbox, { timeout: 15000 });
  const { Vec3 } = require('vec3'), data = require('minecraft-data')('1.21.1'), Chunk = require('prismarine-chunk')('1.21.1'), chunk = new Chunk();
  for (const y of [-32, 63, 280]) chunk.setBlockStateId(new Vec3(8, y, 8), data.blocksByName.grass_block.defaultState);
  for (const data of [{ type: 'version', version: '1.21.1' },
    { type: 'blockStates', json: JSON.parse(readFileSync(join(root, 'public/blocksStates/1.21.1.json'), 'utf8')) },
    { type: 'chunk', x: 0, z: 0, chunk: chunk.toJson() }, ...[-32, 48, 272].map(y => ({ type: 'dirty', x: 0, y, z: 0 }))]) {
    context.jsonData = JSON.stringify(data);
    vm.runInContext('self.onmessage({data: JSON.parse(jsonData)})', sandbox, { timeout: 15000 });
  }
  for (const callback of callbacks) callback();
  const geometries = messages.filter(message => message.type === 'geometry');
  for (const y of [-32, 48, 272]) assert.ok(geometries.find(message => message.key === `0,${y},0`)?.geometry.positions.length > 0, 'Adapted browser worker must render 1.21.1 geometry at Y=' + y);
  const index = viewerAsset('index.js'); assert.equal(index.split('for(let i=-64;i<320;i+=16)').length - 1, 2); assert.ok(!index.includes('t.y>0&&s&&('));
  console.log(JSON.stringify({ passed: true, pinnedBrowserWorker: 'prismarine-viewer@1.33.0', version: '1.21.1', heightSections: geometries.map(value => value.key), vertices: geometries.reduce((sum, value) => sum + value.geometry.positions.length / 3, 0), browserPixelsVerified: false }));
} catch (error) {
  // V8 stacks of a minified bundle can include its entire 61 MB source line.
  console.error('Synthetic worker verification failed: ' + error.message); process.exitCode = 1;
}
