// Modified for the public-candidate release; see RELEASE.md.
// Modified for 2.1.0-dot.2 release (2026-10-03). See RELEASE.md.
// Persistent gameplay server: upstream Yuniko MCP tools, one configured identity, no relay credentials.
import { startReadonlyObserver, validateObserverPort } from '../dist/readonly-observer.js';
import { createWorldFileExporter } from '../dist/world-file-export.js';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { validateStateDir } from './minecraft-ipc.mjs';
import { registerCompleteControls } from '../dist/complete-controls.js';
import { waitForNativePlugins } from '../dist/bot-startup.js';
import { createRequire } from 'node:module';
import { installInventoryAuthority } from '../dist/inventory-authority.js';
import { installPlacementProvenance } from '../dist/placement-provenance.js';
import { installInteractionTrace } from '../dist/interaction-trace.js';
import { installOxygenAuthority } from '../dist/oxygen-authority.js';
import { constrainMovements } from '../dist/movement-safety.js';
import { equipVerified } from '../dist/verified-inventory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../dist/tool-factory.js';
import { MessageStore } from '../dist/message-store.js';
import { registerPositionTools } from '../dist/tools/position-tools.js';
import { registerBlockTools } from '../dist/tools/block-tools.js';
import { registerInventoryTools } from '../dist/tools/inventory-tools.js';
import { registerCraftingTools } from '../dist/tools/crafting-tools.js';
import { registerEntityTools } from '../dist/tools/entity-tools.js';
import { registerGameStateTools } from '../dist/tools/gamestate-tools.js';
import { registerChatTools } from '../dist/tools/chat-tools.js';
import { registerFurnaceTools } from '../dist/tools/furnace-tools.js';
const fixture=process.argv[2]==='--offline-fixture';
const port=Number(process.argv[3]);
if(!fixture&&(process.argv[2]!=='--user-started-session'||!Number.isInteger(port)||port<1024||port>65535))throw Error('Explicit user-started mode and bridge port required');
const backendVersion='3.2.0-rc.3';
const backendStartedAt=new Date().toISOString();
const {values:backendOptions}=parseArgs({args:process.argv.slice(fixture?3:4),options:{'session-id':{type:'string'},'state-dir':{type:'string'},'username':{type:'string',default:'MCPBot'},'observe-port':{type:'string'},'observe-world-files':{type:'boolean',default:false}},strict:true});
const username=backendOptions.username;
const observerPort=validateObserverPort(backendOptions['observe-port']);
let observer=null,observerError=null,worldObserver=null,worldObserverError=null;
let spawnSeen=false;
function closeWorldObserver(){
 spawnSeen=false;
 if(worldObserver)void worldObserver.close().catch(()=>{worldObserverError='world_observer_close_failed';});
}
function worldObserverStatus(){
 const failure=worldObserverError??worldObserver?.getError();
 return worldObserver?{readonly:true,path:worldObserver.path,...(failure?{error:failure}:{})}:worldObserverError?{readonly:true,path:null,error:worldObserverError}:null;
}
if(!/^[A-Za-z0-9_]{1,16}$/.test(username))throw Error('Username must be 1..16 letters, digits or underscores');
const stateRoot=validateStateDir(backendOptions['state-dir'],{create:true});
const backendSessionId=backendOptions['session-id']??randomUUID();
let complete;
let stopDepth=0,stopFailed=false;
let ready=false,ended=false,dead=false,endReason=null,packets=0,physicsTicks=0,movementPackets=0,chatSent=0,lastChat=0;
const messages=new MessageStore();
const events=[];
function event(type,detail={}){events.push({at:new Date().toISOString(),type,...detail});if(events.length>60)events.shift();}
let bot;
let authority;
let nativePluginsReady;
if(fixture){
 bot=Object.assign(new EventEmitter(),{username,version:'1.21.1',entity:{position:new Vec3(0.5,64,0.5),yaw:0,pitch:0,onGround:true},health:20,food:20,oxygenLevel:20,game:{gameMode:'survival',dimension:'overworld'},time:{timeOfDay:5000},inventory:{items:()=>[]},entities:{},players:{},blockAt:()=>null,clearControlStates(){},quit(){},lookAt:async()=>{},setControlState(){},pathfinder:{stop(){},setGoal(){}}});
 const require=createRequire(import.meta.url);bot.registry=require('prismarine-registry')('1.21.1');bot.supportFeature=bot.registry.supportFeature;bot._client=new EventEmitter();bot._client.write=()=>{throw Error('Fixture has no gameplay socket');};bot.inventory.slots=Array(46).fill(null);bot.inventory.updateSlot=()=>{};bot.inventory.selectedItem=null;
 authority=installInventoryAuthority(bot);const Item=require('prismarine-item')(bot.registry);bot._client.emit('window_items',{windowId:0,stateId:0,items:Array.from({length:46},()=>Item.toNotch(null)),carriedItem:Item.toNotch(null)});ready=true;
}else{
 bot=mineflayer.createBot({host:'127.0.0.1',port,username,version:'1.21.1',auth:'offline',hideErrors:true,logErrors:false,respawn:false,physicsEnabled:true,maxCatchupTicks:4,viewDistance:'short',checkTimeoutInterval:60000});
 nativePluginsReady=waitForNativePlugins(bot);
 authority=installInventoryAuthority(bot);
 bot.loadPlugin(pf.pathfinder);
 bot.once('spawn',()=>{ready=true;dead=false;const m=new pf.Movements(bot);constrainMovements(bot,m);bot.pathfinder.setMovements(m);event('spawn');});
 bot.on('respawn',()=>{dead=false;ready=true;event('respawn');});
 bot.on('death',()=>{dead=true;ready=false;bot.clearControlStates();event('death');});
 bot.on('health',()=>event('health',{health:bot.health,food:bot.food}));
 bot.on('physicsTick',()=>physicsTicks++);
 bot.on('end',reason=>{ended=true;ready=false;endReason=String(reason).slice(0,100);event('disconnected',{reason:endReason});});
 bot.on('error',()=>{event('client_error');});
 bot.on('kicked',()=>{ended=true;ready=false;endReason='server_kicked';event('kicked');});
 bot.on('chat',(username,message)=>{messages.addMessage(username,String(message).slice(0,1000));});
 bot.on('whisper',(username,message)=>{messages.addMessage(username+' (whisper)',String(message).slice(0,1000));});
 bot._client.on('packet',()=>packets++);
 const write=bot._client.write.bind(bot._client);bot._client.write=(name,packet)=>{if(['position','position_look','look','flying'].includes(name))movementPackets++;return write(name,packet);};
}
const oxygenAuthority=installOxygenAuthority(bot);
// Install before any awaited initialization; only an actual spawn event is
// evidence for late observer setup. Lifecycle resets invalidate that evidence.
bot.on('spawn',()=>{spawnSeen=true;});
for(const name of ['respawn','death'])bot.on(name,()=>{spawnSeen=false;});
for(const name of ['end','kicked'])bot.on(name,closeWorldObserver);
if(fixture)bot.emit('spawn'); // synthetic lifecycle evidence, never a game login
const ownBlocks=installPlacementProvenance(bot);
const interactionTrace=installInteractionTrace(bot);
const pos=p=>p?{x:p.x,y:p.y,z:p.z}:null;
function status(){const p=bot.entity?.position;return {at:new Date().toISOString(),backendSessionId,backendPid:process.pid,backendVersion,backendStartedAt,selfDefense:complete?.selfDefense.snapshot()??null,worldObserver:worldObserverStatus(),observer:observer?{url:observer.url,readonly:true}:observerError?{url:null,readonly:true,error:observerError}:null,controlFence:stopFailed?'stop_cleanup_failed':stopDepth?'stop_in_progress':null,username,mode:fixture?'offline-fixture':'live',ready,ended,dead,endReason,version:bot.version,playerUuid:bot.player?.uuid,position:pos(p),yaw:bot.entity?.yaw,pitch:bot.entity?.pitch,onGround:bot.entity?.onGround,health:bot.health,food:bot.food,oxygen:oxygenAuthority.snapshot().oxygen,oxygenEvidence:oxygenAuthority.snapshot(),gameMode:bot.game?.gameMode,dimension:bot.game?.dimension,time:bot.time?.timeOfDay,isRaining:bot.isRaining,heldItem:bot.heldItem?.name,inventory:authority.frames.get(0)?.fullRevision?authority.frames.get(0).slots.flatMap((i,slot)=>i&&slot>=9&&slot<45?[{name:i.name,type:i.type,count:i.count,slot,durabilityUsed:i.durabilityUsed,maxDurability:i.maxDurability}]:[]):null,inventoryAuthority:{ready:Boolean(authority.frames.get(0)?.fullRevision&&authority.cursorKnown&&!authority.ended),mutationReady:Boolean(authority.frames.get(0)?.fullRevision&&authority.cursorKnown&&!authority.ended&&!authority.fence),sequence:authority.sequence,fence:authority.fence,cursor:authority.cursor?{name:authority.cursor.name,count:authority.cursor.count}:null,equipment:authority.frames.get(0)?.slots.flatMap((i,slot)=>i&&[5,6,7,8,45].includes(slot)?[{slot,name:i.name,type:i.type,count:i.count,durabilityUsed:i.durabilityUsed,maxDurability:i.maxDurability}]:[])??[]},support:p?bot.blockAt(p.offset(0,-0.05,0))?.name:null,packets,physicsTicks,movementPackets,chatSent,interactionTrace:interactionTrace.snapshot(),players:Object.keys(bot.players??{}),events:events.slice(-12)};}
const server=new McpServer({name:'minecraft-mcp-server-minecraft',version:backendVersion});
const readTools=new Set(['get-position','list-inventory','find-item','find-blocks','get-block-info','find-entity','detect-gamemode','read-chat','list-recipes','get-recipe','can-craft','inspect-nearby']);
const factory=new ToolFactory(server,{checkConnectionAndReconnect:async()=>({connected:ready&&!ended&&!dead,message:'MCPBot is not ready; reconnection is disabled.'}),assertActionAllowed(name){if(!readTools.has(name)){if(stopDepth||stopFailed)throw Error('Safety stop is draining or failed; new mutations are fenced');
 // Plain chat uses no inventory authority. It remains a mutating, serialized
 // tool behind the live-session, controller, stop, and no-replay barriers.
 if(name!=='send-chat')authority.assertMutationReady();}}});
const natural=/^(dirt|grass_block|stone|cobblestone|deepslate|cobbled_deepslate|granite|diorite|andesite|sand|red_sand|gravel|coal_ore|iron_ore|copper_ore|gold_ore|deepslate_gold_ore|redstone_ore|deepslate_redstone_ore|diamond_ore|deepslate_diamond_ore|deepslate_coal_ore|deepslate_iron_ore|short_grass|tall_grass|fern|large_fern|snow|clay|wheat|carrots|potatoes|beetroots|nether_wart|cocoa|melon|pumpkin|bamboo|cactus|kelp|kelp_plant|sugar_cane|sweet_berry_bush|brown_mushroom|red_mushroom|[a-z_]+_log|[a-z_]+_leaves)$/;
const legacyActions=new Map();
const wrapped={createResponse:factory.createResponse.bind(factory),createErrorResponse:factory.createErrorResponse.bind(factory),registerTool(name,description,schema,executor){
 if(name==='move-to-position'){schema.timeoutMs=z.number().int().min(100).max(25000).optional();schema.range=z.number().min(0).max(5).optional();}
 if(name==='move-in-direction')schema.duration=z.number().int().min(50).max(4000).optional();
 if(name==='send-chat')schema.message=z.string().min(1).max(220).refine(m=>!/^\s*\//.test(m)&&!/[\x00-\x1f\x7f]/.test(m),'Ordinary game chat only; commands forbidden');
 const execute=async args=>{
  const p=bot.entity.position;
  if(name==='move-to-position'){args.timeoutMs??=15000;if(p.distanceTo(new Vec3(args.x,args.y,args.z))>80)throw Error('Use an observed local waypoint within 80 blocks');}
  if(name==='find-blocks'){args.maxDistance=Math.min(args.maxDistance??16,64);args.count=Math.min(args.count??1,128);}
  if(name==='dig-block'){
   const target=new Vec3(args.x,args.y,args.z).floored();const b=bot.blockAt(target);if(!b)throw Error('Unknown block');
   if(p.distanceTo(target.offset(.5,.5,.5))>5)throw Error('Move within reach before digging');
   if(!['air','cave_air','void_air'].includes(b.name)&&!natural.test(b.name)&&!ownBlocks.has(target))throw Error('Protected constructed block; only natural terrain or MCPBot-placed blocks may be mined');
   if(target.x===Math.floor(p.x)&&target.z===Math.floor(p.z)&&target.y<Math.floor(p.y))throw Error('Do not dig support beneath feet');
  }
  if(name==='place-block'&&p.distanceTo(new Vec3(args.x,args.y,args.z).offset(.5,.5,.5))>5)throw Error('Move within reach before placing');
  if(name==='smelt-item')args.timeoutMs=Math.min(args.timeoutMs??20000,20000);
  if(name==='craft-item')args.amount=Math.min(args.amount??1,16);
  if(name==='smelt-item'&&!ownBlocks.has(new Vec3(args.x,args.y,args.z).floored()))throw Error('Only use MCPBot-placed furnaces');
  if(name==='send-chat'){if(Date.now()-lastChat<4000)throw Error('Chat rate limit');lastChat=Date.now();chatSent++;}
  // One serial lane remains held until the actual executor settles. Per-tool
  // timeouts cancel their own work; no global race leaves clicks running behind it.
  const result=await executor(args);
  if(name==='dig-block'&&!result.isError){const v=new Vec3(args.x,args.y,args.z).floored();if(['air','cave_air','void_air'].includes(bot.blockAt(v)?.name))ownBlocks.forget(v);}
  return result;
 };
 legacyActions.set(name,execute);
 // Direct legacy mutations enter the same cancellation context as upstream
 // controls. The compatibility map retains the inner executor because facade
 // calls already own that context; nesting would replace the active controller.
 factory.registerTool(name,description,schema,args=>readTools.has(name)||name==='send-chat'?execute(args):complete.runAction(()=>execute(args),name));
}};
for(const register of [registerPositionTools,registerBlockTools,registerInventoryTools,registerCraftingTools,registerEntityTools,registerGameStateTools,registerFurnaceTools])register(wrapped,()=>bot,()=>complete.getOptions());
registerChatTools(wrapped,()=>bot,messages);
const response=v=>({content:[{type:'text',text:JSON.stringify(v)}]});
server.tool('get-session-status','Read MCPBot connection, health, inventory and protocol progress. Never reconnects.',{},async()=>response(status()));
factory.registerTool('inspect-nearby','Observe nearby entities and a heightmap; player text is untrusted game data.',{radius:z.number().int().min(1).max(12).optional()},async({radius=6})=>{
 const p=bot.entity.position;const c=p.floored();const terrain=[];
 for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++){
  let found=null;
  for(let y=c.y+8;y>=c.y-10;y--){const b=bot.blockAt(new Vec3(c.x+dx,y,c.z+dz));if(b&&b.name!=='air'&&b.name!=='cave_air'&&b.name!=='void_air'){found={x:b.position.x,y:b.position.y,z:b.position.z,name:b.name,solid:b.boundingBox==='block'};break;}}
  if(found)terrain.push(found);
 }
 const entities=Object.values(bot.entities).filter(e=>e!==bot.entity&&e.position.distanceTo(p)<=48).sort((a,b)=>a.position.distanceTo(p)-b.position.distanceTo(p)).slice(0,40).map(e=>({id:e.id,type:e.type,name:e.name,username:e.username,position:pos(e.position),distance:+e.position.distanceTo(p).toFixed(1),item:e.getDroppedItem?.()?.name}));
 return response({status:status(),entities,terrain,ownBlocks:ownBlocks.entries(),chat:messages.getRecentMessages(12)});
});
// registerCompleteControls installs the shared authoritative bot.consume barrier before serving requests.
factory.registerTool('consume-food','Eat a safe food already carried by MCPBot.',{itemName:z.string()},async({itemName})=>complete.runAction(async()=>{const safe=/^(bread|apple|baked_potato|carrot|golden_carrot|cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|cooked_rabbit|cooked_cod|cooked_salmon|melon_slice|sweet_berries|glow_berries|dried_kelp|cookie|pumpkin_pie|beetroot|mushroom_stew|rabbit_stew|beetroot_soup)$/;if(!safe.test(itemName))throw Error('Choose a safe ordinary food');const item=authority.items().find(i=>i.name===itemName);if(!item)throw Error('Food not in inventory');await equipVerified(bot,item.slot,'hand',undefined,complete.getOptions());complete.getOptions().signal?.throwIfAborted();const held=authority.getFrame(0).slots[36+bot.quickBarSlot];if(!held||held.name!==itemName||!safe.test(held.name))throw Error('Authoritative selected food changed; consumption cancelled');await bot.consume();return response(status());}));
factory.registerTool('attack-mob','One ordinary survival attack on a non-player mob in reach.',{entityId:z.number().int()},async({entityId})=>complete.runAction(async()=>{const e=bot.entities[entityId];const allowed=/^(zombie|husk|drowned|skeleton|stray|spider|cave_spider|creeper|slime|magma_cube|phantom|silverfish|endermite|witch|zombie_villager|cow|pig|chicken|sheep|rabbit|cod|salmon)$/;if(!e||e.type==='player'||e.username||!allowed.test(e.name??''))throw Error('Only ordinary survival mobs are eligible');if(bot.entity.position.distanceTo(e.position)>3.2)throw Error('Mob outside reach');await bot.lookAt(e.position.offset(0,e.height*.6,0),true);complete.getOptions().signal?.throwIfAborted();bot.attack(e);return response({attacked:e.name,id:e.id});}));
// Stop is intentionally outside the serialized tool lane so it can interrupt a
// pending action. Its acknowledgement waits for that lane (including already
// queued autonomous work) to drain, then clears controls once more. A timeout at
// the daemon remains fenced; this barrier never resets inventory authority.
async function stopAndDrain(){
 stopDepth++;
 try{
  try{await complete?.stop();}finally{bot.clearControlStates();}
  // Mutating executors already queued behind autonomous work see stopDepth at
  // the factory gate and cannot begin after cancellation has been requested.
  await factory.runInActionLane(async()=>{});
  try{await complete?.stop();bot.pathfinder?.setGoal(null);bot.stopDigging?.();}finally{bot.clearControlStates();}
 }catch(error){stopFailed=true;throw error;}finally{stopDepth--;}
}
server.tool('stop-movement','Stop active work and clear controls without disconnecting; acknowledge after old work settles.',{},async()=>{await stopAndDrain();return response(status());});
server.tool('respawn-player','Respawn MCPBot after death in the existing game session.',{},async()=>{if(ended||!dead)throw Error('Not a connected death state');authority.armRespawnRecovery();bot.respawn();return response({respawnRequested:true});});
function quitGame(){
 ended=true;ready=false;endReason='user_requested_disconnect';
 void observer?.close();
 closeWorldObserver();
 // Emergency quit must not wait for a stuck inventory/plugin cancellation.
 void Promise.resolve().then(()=>complete?.stop()).catch(()=>{});
 try{bot.clearControlStates();}finally{bot.quit();}
}
server.tool('disconnect-player','Quit this MCPBot session when the user asks to stop.',{},async()=>{quitGame();return response({disconnectRequested:true,backendSessionId});});
let closing=false;function finish(){if(closing)return;closing=true;try{quitGame();}finally{setTimeout(()=>process.exit(0),500);}}
process.stdin.on('end',finish);process.on('SIGINT',finish);process.on('SIGTERM',finish);
await nativePluginsReady;
if(ended)throw Error('Minecraft session ended before control initialization');
complete=await registerCompleteControls({server,factory,bot,fixture,legacy:legacyActions,markRead:name=>readTools.add(name),stateRoot});
if(ended)throw Error('Minecraft session ended during control initialization');
if(observerPort!==null){
 try{observer=await startReadonlyObserver(bot,authority,{port:observerPort});}
 catch{observerError='observer_start_failed';event('observer_unavailable');}
}
if(backendOptions['observe-world-files']){
 try{
  worldObserver=await createWorldFileExporter(bot,{directory:join(stateRoot,'native-observer'),initiallyReady:()=>spawnSeen&&!ended&&!dead});
  if(ended)closeWorldObserver();
 }catch{worldObserverError='world_observer_start_failed';event('world_observer_unavailable');}
}
await server.connect(new StdioServerTransport());
