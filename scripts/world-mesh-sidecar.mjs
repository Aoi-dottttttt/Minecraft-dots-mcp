// Explicit file-only prototype. No HTTP, sockets, browser, game or control channel.
import { parseArgs } from 'node:util';
import { watch } from 'node:fs';
import { createMeshFileSidecar } from '../dist/world-mesh-sidecar.js';
const { values } = parseArgs({ options: { directory: { type: 'string' }, once: { type: 'boolean', default: false } }, strict: true });
if (!values.directory) throw Error('Pass --directory with the private world-frame directory');
const sidecar = await createMeshFileSidecar(values.directory);
let stopping = false, timer, watcher;
const close = async () => { if (stopping) return; stopping = true; clearInterval(timer); watcher?.close(); await sidecar.close(); };
process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); }); process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
try {
  const result = await sidecar.tick();
  if (values.once) console.log(JSON.stringify({ status: result.status, reason: result.reason, sections: result.sections.length, unknownCells: result.unknownCells }));
  else {
    const tick = () => { if (!stopping) void sidecar.tick().catch(() => close()).catch(() => { process.exitCode = 1; }); };
    // File events only expedite stale/generation checks; geometry still has a
    // two-second ceiling and shares the single in-flight conversion/write.
    watcher = watch(values.directory, (_event, filename) => { if (filename === 'world-frame.json') tick(); });
    watcher.on('error', () => { void close().catch(() => { process.exitCode = 1; }); });
    timer = setInterval(tick, 2000);
  }
} catch { await close(); throw Error('Mesh sidecar failed; no gameplay action was attempted'); }
// --once leaves the bounded result only until its original source validUntil;
// it does not renew its lease or leave a background process.
