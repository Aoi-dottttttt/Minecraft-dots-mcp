// Synthetic world only. Never starts a Mineflayer connection or reads user state.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { startReadonlyObserver } from '../dist/readonly-observer.js';
const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3'), registry = require('prismarine-registry')('1.21.1');
const Chunk = require('prismarine-chunk')('1.21.1'), chunk = new Chunk();
for (const y of [-33, 63, 279]) for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
  const position = new Vec3(x, y, z);
  chunk.setBlockStateId(position, registry.blocksByName.grass_block.defaultState);
  // The default biome id 0 is badlands in 1.21.1; its brown grass cannot
  // satisfy a green-grass pixel assertion. Make the synthetic scene explicit.
  chunk.setBiome(position, registry.biomesByName.plains.id);
}
let actions = 0;
const rejectAction = () => { actions++; throw Error('Read-only observer attempted gameplay'); };
const bot = Object.assign(new EventEmitter(), { version: '1.21.1', username: 'Fixture',
  entity: { position: new Vec3(8.5, 64, 8.5), yaw: 0, pitch: -0.4 }, entities: {},
  world: { async getColumnAt() { return chunk; }, raycast: rejectAction },
  health: 20, food: 18, oxygenLevel: 20, game: { dimension: 'overworld' }, time: { timeOfDay: 5000 }, currentWindow: null,
  setControlState: rejectAction, chat: rejectAction, clickWindow: rejectAction, _client: { write: rejectAction } });
const slots = Array(46).fill(null); slots[9] = { name: 'stone', type: 1, count: 12 };
const authority = { frames: new Map([[0, { id: 0, slots, fullRevision: 1, inventoryStart: 9, inventoryEnd: 45 }]]),
  ended: false, cursorKnown: true, cursor: null, sequence: 1, fence: null };
const observer = await startReadonlyObserver(bot, authority, { port: 0 });
let browser, page, currentHeight;
const errors = [], browserErrors = [];
try {
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && browserErrors.length < 12) browserErrors.push(message.text().slice(0, 400)); });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (name, options) {
      return getContext.call(this, name, /webgl/.test(name) ? { ...options, preserveDrawingBuffer: true } : options);
    };
  });
  await page.goto(observer.url);
  await page.waitForFunction(() => document.querySelectorAll('#inventory .slot').length === 46);
  assert.equal(await page.locator('#inventory img').getAttribute('alt'), 'stone');
  assert.equal(await page.locator('button,input,textarea').count(), 0, 'Dashboard has no gameplay inputs');
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#inventory .slot').length === 46);
  for (const y of [64, -32, 280]) {
  currentHeight = y; bot.entity.position.y = y;
  await page.goto(observer.url + 'viewer/'); await page.waitForSelector('canvas');
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas'), gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    if (!gl) return false;
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let green = 0;
    for (let i = 0; i < pixels.length; i += 64) if (pixels[i + 1] > pixels[i] * 1.2 && pixels[i + 1] > pixels[i + 2] * 1.1 && pixels[i + 1] > 35) green++;
    return green > 100;
  }, null, { timeout: 60000 });
  await page.mouse.click(600, 450); await page.mouse.click(600, 450);
  bot.emit('respawn'); await page.waitForFunction(() => !document.querySelector('#stream-status').hidden && document.querySelector('#stream-message').textContent.includes('stale'));
  }
  await page.goto(observer.url); await page.waitForFunction(() => document.querySelectorAll('#inventory .slot').length === 46);
  assert.deepEqual(errors, []); assert.equal(actions, 0);
  console.log(JSON.stringify({ passed: true, dashboardSlots: 46, textured3DWorldRendered: true, heights: [-32, 64, 280], staleOverlayVerified: true, browser: 'Chromium', fixtureOnly: true, gameActions: actions }));
} catch (error) {
  const pixels = await page?.evaluate(() => {
    const canvas = document.querySelector('canvas'), gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    if (!gl) return { webgl: false, status: document.querySelector('#stream-message')?.textContent };
    const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const colors = new Map();
    for (let i = 0; i < data.length; i += 64) { const key = `${data[i]},${data[i + 1]},${data[i + 2]}`; colors.set(key, (colors.get(key) ?? 0) + 1); }
    return { webgl: true, topColors: [...colors].sort((a, b) => b[1] - a[1]).slice(0, 8), overlayHidden: document.querySelector('#stream-status')?.hidden };
  }).catch(() => null);
  console.error(JSON.stringify({ syntheticBrowserFailure: true, currentHeight, errors, browserErrors, pixels }));
  throw error;
} finally { await browser?.close(); await observer.close(); }
