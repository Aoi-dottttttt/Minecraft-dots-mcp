// Synthetic local world only. Never imports Mineflayer, connects, or reads gameplay state.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { OfficialMeshWorker, makeMeshFrame, staleMesh } from '../dist/world-mesh-sidecar.js';
import { createPrivateWorldWriter } from '../dist/world-file-export.js';
const require = createRequire(import.meta.url), data = require('minecraft-data')('1.21.1');
const { values } = parseArgs({ options: { directory: { type: 'string' }, seconds: { type: 'string', default: '60' } } });
const seconds = Number(values.seconds);
if (!values.directory || !Number.isInteger(seconds) || seconds < 2 || seconds > 300) throw Error('Pass a private directory and duration 2..300 seconds');
const writer = await createPrivateWorldWriter(values.directory, { name: 'mesh-frame.json', maxBytes: 16*1024*1024 });
const start = performance.now(), worker = new OfficialMeshWorker(), renderTimes = [], cpu = process.cpuUsage();
console.log(JSON.stringify({ synthetic: true, workerStartupMs: Math.round(performance.now()-start), noGameConnection: true }));
const until = performance.now() + seconds*1000;
let sequence = 0;
while (performance.now() < until) {
 const stateIds = [], biomes = [], skyLight = [], blockLight = [], tick = performance.now();
 for (let y=58;y<=70;y++) for (let z=-8;z<=8;z++) for (let x=-8;x<=8;x++) {
  let name = y < 63 ? 'dirt' : y === 63 ? 'grass_block' : 'air';
  if (y>=64 && y<=67 && ((Math.abs(x)===4 && Math.abs(z)<=4) || (z===-4 && Math.abs(x)<=4))) name='oak_planks';
  if (y===65 && z===-4 && Math.abs(x)<=1) name='glass';
  if (y===64 && x===2 && z===1 && sequence%2===0) name='gold_block';
  if (y===64 && x===-2 && z===1) name='oak_stairs';
  if (y===64 && x===1 && z===2) name='crafting_table';
  const unknown = x<=-7 && z<=-7 && y>=64 && y<=66;
  stateIds.push(unknown ? null : data.blocksByName[name].defaultState); biomes.push(data.biomesByName.plains.id); skyLight.push(15); blockLight.push(0);
 }
 const now=Date.now();
 const frame={schemaVersion:1,minecraftVersion:'1.21.1',generation:1,sequence:++sequence,capturedAt:new Date(now).toISOString(),validUntil:new Date(now+5000).toISOString(),status:'live',reason:'observed',position:{x:0.5,y:64,z:0.5},yaw:0,pitch:0,volume:{origin:{x:-8,y:58,z:-8},size:{x:17,y:13,z:17},order:'y,z,x',stateIds,biomes,skyLight,blockLight}};
 const mesh=makeMeshFrame(frame,worker);await writer.write(mesh,()=>true);renderTimes.push(performance.now()-tick);
 if(sequence===1) console.log(JSON.stringify({synthetic:true,status:mesh.status,sections:mesh.sections.length,vertices:mesh.sections.reduce((n,s)=>n+s.positions.length/3,0),unknownCells:mesh.unknownCells}));
 await delay(Math.max(0,2000-(performance.now()-tick)));
}
await writer.write(staleMesh('synthetic-fixture-ended'),()=>true);
const used=process.cpuUsage(cpu);console.log(JSON.stringify({synthetic:true,frames:sequence,meanMeshMs:Math.round(renderTimes.reduce((a,b)=>a+b,0)/renderTimes.length),maxMeshMs:Math.round(Math.max(...renderTimes)),rssMiB:Math.round(process.memoryUsage().rss/1048576),cpuSeconds:(used.user+used.system)/1000000,sourceEnded:true}));
