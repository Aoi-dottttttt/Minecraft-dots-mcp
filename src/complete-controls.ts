/* eslint-disable @typescript-eslint/no-explicit-any */
// Integration of awesome-mineflayer-mcp 1.3.2, commit
// 89a407ca18a4a39196c6ebe726d5208cff88a9e5 (MIT, license in vendor).
// Its reusable tool definitions run on the existing MCPBot bot. No BotManager,
// authentication, reconnect, raw protocol or creative/admin surface is imported.
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import { ToolFactory } from './tool-factory.js';
import { getInventoryAuthority } from './inventory-authority.js';
import { equipVerified } from './verified-inventory.js';
import { craftVerified } from './verified-crafting.js';
import { consumeOnceVerified, snapshotConsumption, confirmConsumption } from './verified-consumption.js';
import { clickWindowVerified, openWindowVerified, closeWindowVerified, readWindowVerified, transferWindowVerified, readFurnaceVerified, furnaceActionVerified, dropItemVerified, validateWindowBlock, FURNACE_WINDOW_TYPES, STORAGE_WINDOW_TYPES } from './verified-window-actions.js';
import * as interactions from './survival-interactions.js';
import {fishOnceVerified} from './verified-fishing.js';
import {openVillagerVerified,tradeWithVillagerVerified,enchantItemVerified,anvilCombineVerified} from './verified-workstation-actions.js';
import { registerInteractionTools } from './tools/interaction-tools.js';
import { registerWindowTools } from './tools/window-tools.js';
import { readBookVerified, readBookSchema } from './book-observation.js';
import { registerWorkflowTools } from './tools/workflow-tools.js';
import { constrainMovements, navigationHazard, waitForDryMovement } from './movement-safety.js';
import { moveAndVerify } from './tools/movement-utils.js';
import { launchBoatVerified } from './verified-boat.js';
import { registerMovementSafetyTools } from './tools/movement-safety-tools.js';

export const UPSTREAM_COMMIT = '89a407ca18a4a39196c6ebe726d5208cff88a9e5';
export const EXCLUDED_TOOLS = new Set(['connect_bot','connect_default','reconnect_bot','disconnect_bot','respawn','get_connection_status','get_default_account','send_packet','subscribe_packet','unsubscribe_packet','list_packet_subscriptions','creative_set_inventory_slot','creative_clear_inventory','creative_fly','creative_fly_to','run_command','set_physics_enabled','configure_movements','configure_pathfinder','set_settings','register_chat_pattern','wait_for_message']);
const CLEANUP = new Set(['cancel_task','cancel_fish','pvp_stop','cancel_collect','stop_pathfinding','clear_control_states','autoeat_cancel','stop-using-item']);
const GROUPS = ['state-inspect','world','movement','look','digging','combat','inventory','containers','furnace','enchant-anvil','villager','crafting','gathering','tool-select','survival','beds','vehicles','fishing-books-signs','chat','events','vision','waypoints','build'];
const hasControl=(value:string)=>[...value].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127);
const range = (start:number,end:number) => Array.from({length:Math.max(0,end-start)},(_,i)=>start+i);
const json = (value:any) => ({content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value});
const modules = (path:string) => import(new URL(`../vendor/awesome-mineflayer-mcp/dist/${path}.js`,import.meta.url).href);
type ToolDef = {name:string;group:string;description:string;inputSchema?:Record<string,any>;annotations?:{readOnlyHint?:boolean};handler:(args:any,ctx:any)=>any};
type Options = {server:any;factory:ToolFactory;bot:Bot;fixture?:boolean;markRead:(name:string)=>void;legacy:Map<string,(args:any)=>Promise<any>>;stateRoot:string};
type Action = {controller:AbortController;pending:Set<Promise<any>>;evidence:Array<Record<string,any>>};

export async function registerCompleteControls(options:Options):Promise<{names:string[];stop:()=>Promise<void>;getOptions:()=>interactions.InteractionOptions;runAction:<T>(operation:()=>Promise<T>)=>Promise<T>}> {
  const {bot,factory,server}=options;
  const raw = bot as any;
  const authority=getInventoryAuthority(bot);
  interactions.installVehicleStateGuard(bot);
  const upstreamRequire=createRequire(new URL('../vendor/awesome-mineflayer-mcp/package.json',import.meta.url));
  const z4=(await import(upstreamRequire.resolve('zod'))).z;
  const {EventBus}=await modules('bot/events');
  const {WindowManager}=await modules('bot/windows');
  const {ActionLocks}=await modules('bot/action-locks');
  const {wireBotEvents}=await modules('bot/wire-events');
  const {dataResult,RawToolResult}=await modules('util/result');
  const events=new EventBus(300), windows=new WindowManager(), locks=new ActionLocks();
  const lane=new AsyncLocalStorage<Action>();
  let current:Action|undefined, autoEnabled=false, autoPending=false, lastAuto=0, lastChat=0;
  const names:string[]=[];
  process.env.AWESOME_MINEFLAYER_MCP_HOME=options.stateRoot;
  const settings=()=>({signal:lane.getStore()?.controller.signal,timeoutMs:5000});
  function note(value:Record<string,any>):void { lane.getStore()?.evidence.push(value); }
  function tracked<T>(promise:Promise<T>):Promise<T> {
    const a=lane.getStore();
    if(a){a.pending.add(promise);void promise.catch(()=>{});}
    return promise;
  }
  function assertLive():void { authority.assertMutationReady();settings().signal?.throwIfAborted(); }
  async function legacy(name:string,args:any):Promise<any> {
    assertLive();
    const action=options.legacy.get(name);if(!action)throw Error(`Missing compatibility operation ${name}`);
    const value=await action(args);if(value?.isError)throw Error(value.content?.[0]?.text??`${name} failed`);return value;
  }
  function chosen(item:any):any {
    const items=authority.items();
    const found=typeof item==='number'?items.filter(i=>i.type===item):typeof item==='string'?items.filter(i=>i.name===item.replace(/^minecraft:/,'')):items.filter(i=>i.slot===item?.slot&&authority.same(i,item,false));
    if(!found.length)throw Error('Requested item is not in authoritative inventory');
    const identities=new Set(found.map(i=>authority.identity(i)));
    if(identities.size>1)throw Error('Multiple items with different components or durability; use equip-inventory-slot');
    return found[0];
  }
  const native={equip:raw.equip,craft:raw.craft,transfer:raw.transfer,clickWindow:raw.clickWindow,moveSlotItem:raw.moveSlotItem,putAway:raw.putAway,consume:raw.consume?.bind(bot),openContainer:raw.openContainer?.bind(bot),openFurnace:raw.openFurnace?.bind(bot),openVillager:raw.openVillager?.bind(bot),openAnvil:raw.openAnvil?.bind(bot),openEnchantmentTable:raw.openEnchantmentTable?.bind(bot),fish:raw.fish?.bind(bot)};
  function playerSlots():number[]{const s=readWindowVerified(bot);return range(s.inventoryStart,s.inventoryEnd);}
  async function transfer(args:any):Promise<any> {
    assertLive();const s=readWindowVerified(bot);
    if(args.window&&args.window.id!==s.id)throw Error('Requested window is stale');
    if(args.destStart<0)throw Error('Use drop-item-verified for deliberate dropping; implicit overflow is forbidden');
    const result=await transferWindowVerified(bot,{sourceSlots:range(args.sourceStart,args.sourceEnd),destinationSlots:range(args.destStart,args.destEnd),itemType:args.itemType,metadata:args.metadata,count:args.count??undefined,...settings()});
    note({kind:'inventory_transfer',confirmed:true,transferred:result.transferred,item:result.itemName});return result;
  }
  // These shared replacements also cover native furnace/anvil/trade internals
  // that call bot.transfer/putAway, avoiding optimistic private click helpers.
  if(!options.fixture){
    raw.openBlock=(block:any)=>openWindowVerified(bot,block,settings());
    raw.openEntity=(entity:any)=>openWindowVerified(bot,entity,{entity:true,...settings()});
    raw.equip=(item:any,destination:any)=>tracked((async()=>{assertLive();const i=chosen(item);await equipVerified(bot,i.slot,destination,settings().timeoutMs,{signal:settings().signal});note({kind:'equip',confirmed:true,slot:i.slot,destination});})());
    raw.craft=async(recipe:any,count=1,table:any)=>{assertLive();if(!Number.isInteger(count)||count<1||count>16)throw Error('Craft iterations must be 1..16');for(let i=0;i<count;i++){settings().signal?.throwIfAborted();await craftVerified(bot,recipe,table,settings().timeoutMs,{signal:settings().signal});}note({kind:'craft',confirmed:true,iterations:count});};
    raw.transfer=transfer;
    raw.unequip=async(destination:string)=>{assertLive();const slots:any={hand:36+bot.quickBarSlot,'off-hand':45,head:5,torso:6,legs:7,feet:8};const slot=slots[destination];if(slot===undefined)throw Error('Unknown equipment destination');if(!authority.getFrame(0).slots[slot])return;await transferWindowVerified(bot,{sourceSlots:[slot],destinationSlots:range(9,45).filter(i=>i!==slot),...settings()});note({kind:'unequip',confirmed:true,destination});};
    raw.clickWindow=async(slot:number,button:number,mode:number)=>{if(mode!==0||![0,1].includes(button))throw Error('Use exact transfer tools; speculative shift/drag/creative click modes are unavailable');const r=await clickWindowVerified(bot,{slot,mouseButton:button as 0|1,...settings()});note({kind:'window_click',confirmed:true,slot});return r;};
    raw.moveSlotItem=async(source:number,dest:number)=>transferWindowVerified(bot,{sourceSlots:[source],destinationSlots:[dest],...settings()});
    raw.putAway=async(source:number)=>transferWindowVerified(bot,{sourceSlots:[source],destinationSlots:playerSlots().filter(i=>i!==source),...settings()});
    raw.consume=async()=>{assertLive();const result=await consumeOnceVerified(bot,native.consume,settings());note({kind:'consume',...result});};
  }
  const guardedMethods=new Map<string,any>();
  if(!options.fixture){
    for(const name of ['openBlock','openEntity','equip','craft','transfer','unequip','clickWindow','moveSlotItem','putAway','consume'])guardedMethods.set(name,raw[name]);
    let integrityFailure:string|undefined;
    authority.addMutationGuard(()=>{
      const changed=[...guardedMethods].find(([name,method])=>raw[name]!==method)?.[0];
      if(changed&&!integrityFailure){integrityFailure=`Verified inventory guard was replaced (${changed})`;authority.block(integrityFailure);}
      if(integrityFailure)throw Error(integrityFailure);
    });
  }
  function wrapWindow(window:any,kind:string):any {
    const s=readWindowVerified(bot);if(window.id!==s.id)throw Error('Opened window did not match authoritative snapshot');
    const wrapped=new Proxy(window,{get(target,key){
      if(key==='slots')return authority.getFrame(target.id).slots;
      if(key==='selectedItem')return authority.cursor;
      if(key==='inventoryStart')return authority.getFrame(target.id).inventoryStart;
      if(key==='inventoryEnd')return authority.getFrame(target.id).inventoryEnd;
      if(key==='deposit'||key==='withdraw')return async(itemType:number,metadata:number,count:number)=>{const f=authority.getFrame(target.id);return transfer({window:target,itemType,metadata,count,sourceStart:key==='deposit'?f.inventoryStart:0,sourceEnd:key==='deposit'?f.inventoryEnd:f.inventoryStart,destStart:key==='deposit'?0:f.inventoryStart,destEnd:key==='deposit'?f.inventoryStart:f.inventoryEnd});};
      if(key==='containerItems'||key==='items')return ()=>{const f=authority.getFrame(target.id);return f.slots.flatMap((i,slot)=>i&&(key==='containerItems'?slot<f.inventoryStart:slot>=f.inventoryStart&&slot<f.inventoryEnd)?[Object.assign(Object.create(Object.getPrototypeOf(i)),i,{slot})]:[]);};
      if(key==='inputItem'||key==='fuelItem'||key==='outputItem')return ()=>authority.getFrame(target.id).slots[key==='inputItem'?0:key==='fuelItem'?1:2];
      if(key==='putInput'||key==='putFuel')return (type:number,_metadata:number,count:number)=>tracked(furnaceActionVerified(bot,{op:'put',slot:key==='putInput'?'input':'fuel',itemType:type,count,...settings()}));
      if(key==='takeInput'||key==='takeFuel'||key==='takeOutput')return async()=>{const slot=key==='takeInput'?'input':key==='takeFuel'?'fuel':'output';const old=authority.getFrame(target.id).slots[slot==='input'?0:slot==='fuel'?1:2];await furnaceActionVerified(bot,{op:'take',slot,...settings()});return old;};
      if(key==='close')return ()=>{if(authority.cursor||authority.fence)throw Error('Cannot close an uncertain inventory window');return tracked(closeWindowVerified(bot));};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    windows.set(kind,wrapped);return wrapped;
  }
  const inventoryView=new Proxy(raw.inventory??{}, {get(target,key){
    if(key==='slots')return authority.frames.get(0)?.slots??[];
    if(key==='selectedItem')return authority.cursor;
    if(key==='items')return ()=>authority.getFrame(0).slots.flatMap((i,slot)=>i&&slot>=9&&slot<45?[Object.assign(Object.create(Object.getPrototypeOf(i)),i,{slot})]:[]);
    if(key==='count')return (type:number,metadata:number)=>authority.count(type,metadata);
    if(key==='emptySlotCount')return ()=>authority.getFrame(0).slots.slice(9,45).filter(i=>!i).length;
    const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
  }});
  function entityAllowed(entity:any):void {if(!entity||entity===bot.entity||entity.type==='player'||entity.username)throw Error('This survival action cannot target a player');}
  const safePathfinder=new Proxy(raw.pathfinder??{}, {get(target,key){
    if(key==='setMovements')return (movement:any)=>{constrainMovements(bot,movement);return target.setMovements(movement);};
    if(key==='goto')return (goal:any)=>tracked(moveAndVerify(bot,goal,60000,settings()));
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const facade:any=new Proxy(raw,{get(target,key){
    if(typeof key==='string'&&guardedMethods.has(key))return guardedMethods.get(key).bind(target);
    if(key==='pathfinder')return safePathfinder;
    if(key==='inventory')return inventoryView;
    if(key==='heldItem')return authority.frames.get(0)?.slots[36+bot.quickBarSlot]??null;
    if(key==='dig')return async(block:any)=>{await legacy('dig-block',block.position);note({kind:'dig',confirmed:true,position:block.position});};
    if(key==='placeBlock')return async(ref:any,face:any)=>{await legacy('place-block',ref.position.plus(face));note({kind:'place',confirmed:true,position:ref.position.plus(face)});};
    if(key==='activateBlock')return (block:any,direction?:any,cursor?:any)=>tracked(interactions.activateBlockVerified(bot,block.position,{...settings(),face:faceName(direction),cursor}));
    if(key==='useOn'||key==='activateEntity'||key==='activateEntityAt')return (e:any)=>{entityAllowed(e);return tracked(interactions.useOnEntityVerified(bot,e.id,settings()));};
    if(key==='mount')return (e:any)=>{entityAllowed(e);return tracked(interactions.mountVerified(bot,e.id,settings()));};
    if(key==='dismount')return ()=>tracked(interactions.dismountVerified(bot,settings()));
    if(key==='moveVehicle')return (left:number,forward:number)=>tracked(interactions.steerVehicleBounded(bot,{left,forward,durationMs:300,...settings()}));
    if(key==='sleep')return (bed:any)=>tracked(interactions.sleepInBedVerified(bot,bed.position,settings()));
    if(key==='wake')return ()=>tracked(interactions.wakeVerified(bot,settings()));
    if(key==='attack')return (e:any,swing=true)=>{assertLive();entityAllowed(e);if(e.position.distanceTo(bot.entity.position)>3.2)throw Error('Target outside melee reach');raw.attack(e,swing);note({kind:'attack',requestIssued:true,confirmed:false});};
    if(key==='openContainer'||key==='openChest'||key==='openDispenser')return async(block:any)=>{await openWindowVerified(bot,block,{entity:block?.type!==undefined&&!block?.getProperties,expectedTypes:STORAGE_WINDOW_TYPES,...settings()});return wrapWindow(bot.currentWindow,'container');};
    if(key==='openFurnace')return async(block:any)=>{const current=validateWindowBlock(bot,block,FURNACE_WINDOW_TYPES);const w=await native.openFurnace(current);return wrapWindow(w,'furnace');};
    if(key==='openVillager')return async(e:any)=>{entityAllowed(e);const w=await native.openVillager(e);return wrapWindow(w,'villager');};
    if(key==='openAnvil')return async(block:any)=>wrapWindow(await native.openAnvil(validateWindowBlock(bot,block,['minecraft:anvil'])),'anvil');
    if(key==='openEnchantmentTable')return async(block:any)=>wrapWindow(await native.openEnchantmentTable(validateWindowBlock(bot,block,['minecraft:enchantment'])),'enchant');
    if(key==='chat')return (message:string)=>{if(/^\s*\//.test(message)||hasControl(message)||message.length>220)throw Error('Plain bounded game chat only');if(Date.now()-lastChat<4000)throw Error('Chat rate limit');lastChat=Date.now();raw.chat(message);note({kind:'chat',requestIssued:true,confirmed:false});};
    if(key==='whisper')return (username:string,message:string)=>{if(!/^[A-Za-z0-9_]{1,16}$/.test(username)||hasControl(message)||message.length>180)throw Error('Invalid bounded whisper');if(Date.now()-lastChat<4000)throw Error('Chat rate limit');lastChat=Date.now();raw.whisper(username,message);note({kind:'whisper',requestIssued:true,confirmed:false});};
    if(key==='loadPlugin')return (plugin:any)=>plugin(facade,{});
    const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
  }});
  function faceName(v:any):interactions.BlockFace|undefined {if(!v)return undefined;const map:any={'0,1,0':'up','0,-1,0':'down','0,0,-1':'north','0,0,1':'south','1,0,0':'east','-1,0,0':'west'};const face=map[`${v.x},${v.y},${v.z}`];if(!face)throw Error('Interaction face must be a unit axis vector');return face;}
  // Plugins receive the guarded facade, including verified equip/dig/container
  // methods. No second Mineflayer bot is created.
  if(!options.fixture){
    upstreamRequire('mineflayer-tool').plugin(facade);
    upstreamRequire('mineflayer-pvp').plugin(facade);
    upstreamRequire('mineflayer-collectblock').plugin(facade);
    const auto=(await import(upstreamRequire.resolve('mineflayer-auto-eat'))).loader;auto(facade);
    raw.autoEat.disableAuto();
    const eat=raw.autoEat.eat.bind(raw.autoEat);
    raw.autoEat.eat=async(opts:any={})=>{
      assertLive();
      const request={...opts,equipOldItem:false};
      // Reuse pinned auto-eat 5.0.3's pure selection/normalization before the
      // mutation boundary. An empty eligible food set never equips or uses an
      // item, so it must neither release item use nor fence future mutations.
      if(!raw.autoEat.sanitizeOpts(request))throw Error("No food specified and couldn't find a choice in inventory!");
      const offhand=request.offhand;
      const held=authority.getFrame(0).slots[offhand?45:36+bot.quickBarSlot];
      const before=snapshotConsumption(bot);
      raw.autoEat.setOpts({strictErrors:true,eatingTimeout:Math.max(500,Math.min(raw.autoEat.opts.eatingTimeout??7000,10000))});
      let cleanupFailed=false,cleanupError:unknown;
      try {await eat(request);await confirmConsumption(bot,before,request.food,{...settings(),offHand:offhand});note({kind:'consume',confirmed:true,item:request.food?.name});}
      catch(error){authority.block('Auto-eat consumption was not confirmed; inspect inventory before another mutation');throw error;}
      finally{try{raw.deactivateItem();}catch(error){authority.block('Auto-eat item-use cleanup failed; do not repeat automatically');cleanupFailed=true;cleanupError=error;}}
      if(cleanupFailed)throw cleanupError;
      if((opts.equipOldItem??raw.autoEat.opts.returnToLastItem)&&held){const old=authority.items().find(i=>authority.same(i,held,false));if(old)await raw.equip(old,offhand?'off-hand':'hand');}
      return {confirmed:true};
    };
    const pvpAttack=raw.pvp.attack.bind(raw.pvp);raw.pvp.attack=(target:any)=>{entityAllowed(target);return pvpAttack(target);};
    // Armor manager installs an unsolicited pickup auto-equip callback. Retain
    // its equipAll implementation but suppress this callback; explicit calls
    // run in the shared lane instead.
    const armorFacade=new Proxy(facade,{get(t,k){if(k==='on')return (event:string,fn:any)=>event==='playerCollect'?armorFacade:t.on(event,fn);return t[k];}});
    upstreamRequire('mineflayer-armor-manager')(armorFacade);
  }
  const manager={requireBot:()=>facade,botOrNull:()=>facade,get status(){return authority.ended?'disconnected':'online';},snapshot:()=>({status:authority.ended?'disconnected':'online',username:'MCPBot',version:bot.version})};
  const ctx={server,manager,events,windows,locks};windows.attach(bot);wireBotEvents(bot,events);
  let workflowControls:ReturnType<typeof registerWorkflowTools>|undefined;
  async function stop():Promise<void>{workflowControls?.cancelAll();current?.controller.abort();autoEnabled=false;locks.cancelAll('manual');raw.pathfinder?.setGoal(null);raw.pathfinder?.stop();raw.stopDigging?.();raw.clearControlStates?.();if(raw.deactivateItem)interactions.stopHeldItem(bot);raw.pvp?.forceStop?.();await Promise.resolve(raw.collectBlock?.cancelTask?.()).catch(()=>{});raw.autoEat?.cancelEat?.();}
  for(const event of ['death','end'])bot.on(event as any,()=>{void stop().catch(()=>{});});
  const withAction=async(operation:()=>Promise<any>):Promise<{value:any;evidence:Array<Record<string,any>>}>=>{
    assertLive();const a:Action={controller:new AbortController(),pending:new Set(),evidence:[]};current=a;
    const timer=setTimeout(()=>{a.controller.abort();locks.cancelAll('manual');raw.pathfinder?.setGoal(null);raw.stopDigging?.();raw.clearControlStates?.();raw.deactivateItem?.();},120000);
    try{return await lane.run(a,async()=>{
      let value:any, failure:unknown;
      try { value=await operation(); } catch(error) {failure=error;a.controller.abort();}
      // Always settle guarded void-like operations, including handlers that
      // throw after starting one. Drain new work added while settling too.
      while(a.pending.size){const pending=[...a.pending];a.pending.clear();const settled=await Promise.allSettled(pending);for(const item of settled)if(item.status==='rejected'&&failure===undefined)failure=item.reason;}
      if(failure!==undefined)throw failure;
      a.controller.signal.throwIfAborted();return {value,evidence:a.evidence};
    });}finally{clearTimeout(timer);if(current===a)current=undefined;}
  };
  const execute=async(def:ToolDef,input:any):Promise<any>=>{
    const args=z4.object(def.inputSchema??{}).strict().parse(input??{});
    if(def.annotations?.readOnlyHint)return dispatch(def,args);
    const {value,evidence}=await withAction(()=>dispatch(def,args));
    return {result:value,verification:{confirmed:value?.confirmed===true,evidence,inventorySequence:authority.sequence,note:'A returned request is not proof of its intended game effect. Only explicit confirmation/evidence establishes that effect.'}};
  };
  async function dispatch(def:ToolDef,args:any):Promise<any>{
    switch(def.name){
      case 'fish':return fishOnceVerified(bot,{signal:settings().signal,timeoutMs:args.timeoutMs??30000});
      case 'wait_for_ticks':await boundedTicks(args.ticks);return {ticksObserved:args.ticks};
      case 'write_book': {if(bot.currentWindow)throw Error('Close the current window before editing a book');const item=authority.getFrame(0).slots[args.slot];if(item?.name!=='writable_book')throw Error('Selected authoritative slot is not a writable book');await equipVerified(bot,args.slot,'hand',5000,{exactSource:true,signal:settings().signal});assertLive();const selected=36+bot.quickBarSlot;await raw.writeBook(selected,args.pages);return {requestIssued:true,confirmed:false,detail:'Book edit helper returned; exact server page contents must be inspected separately'};}
      case 'open_villager':return openVillagerVerified(bot,args.entityId,settings());
      case 'trade_with_villager':return tradeWithVillagerVerified(bot,{...args,...settings()});
      case 'enchant_item':return enchantItemVerified(bot,{...args,...settings()});
      case 'anvil_combine':return anvilCombineVerified(bot,{...args,...settings()});
      case 'craft_item': {const type=typeof args.item==='number'?args.item:bot.registry.itemsByName[args.item]?.id;if(type===undefined)throw Error('Unknown item');const table=args.craftingTablePos?bot.blockAt(new Vec3(args.craftingTablePos.x,args.craftingTablePos.y,args.craftingTablePos.z)):bot.findBlock({matching:bot.registry.blocksByName.crafting_table.id,maxDistance:4});const recipe=bot.recipesFor(type,null,1,table)[0];if(!recipe)throw Error('No craftable recipe');await raw.craft(recipe,args.count??1,table);return {confirmed:true,item:args.item,iterations:args.count??1};}
      case 'equip_item':await raw.equip(args.item,args.destination);return {confirmed:true};
      case 'toss_item': {const item=args.slot!==undefined?authority.getFrame(0).slots[args.slot]:chosen(args.item);if(!item)throw Error('No authoritative item in that slot');return dropItemVerified(bot,args.slot??chosen(args.item).slot,args.count,settings());}
      case 'unequip_item': {const slots:any={hand:36+bot.quickBarSlot,'off-hand':45,head:5,torso:6,legs:7,feet:8};return transferWindowVerified(bot,{sourceSlots:[slots[args.destination]],destinationSlots:range(9,45).filter(i=>i!==slots[args.destination]),...settings()});}
      case 'click_window':return raw.clickWindow(args.slot,args.mouseButton,args.mode);
      case 'activate_item':return args.action==='stop'?interactions.stopHeldItem(bot):interactions.useHeldItemBounded(bot,{offHand:args.offHand,durationMs:args.durationMs??250,...settings()});
      case 'activate_block':return interactions.activateBlockVerified(bot,args,{desiredState:args.desiredState,face:faceName(args.direction),cursor:args.cursorPos,...settings()});
      case 'mount_entity':return interactions.mountVerified(bot,args.entityId,settings());
      case 'dismount':return interactions.dismountVerified(bot,settings());
      case 'steer_vehicle':return interactions.steerVehicleBounded(bot,{...args,durationMs:args.durationMs??300,...settings()});
      case 'sleep':return interactions.sleepInBedVerified(bot,args,settings());
      case 'wake':return interactions.wakeVerified(bot,settings());
      case 'open_furnace': {await facade.openFurnace(bot.blockAt(new Vec3(args.x,args.y,args.z)));return readFurnaceVerified(bot);}
      case 'furnace_action':return furnaceActionVerified(bot,{...args,itemName:typeof args.item==='string'?args.item:undefined,itemType:typeof args.item==='number'?args.item:undefined,...settings()});
      case 'furnace_status':return readFurnaceVerified(bot);
      case 'read_open_container':return readWindowVerified(bot);
      case 'close_window':return closeWindowVerified(bot);
      case 'set_control_state': {raw.setControlState(args.control,args.state);if(args.state){try{await waitMs(args.durationMs??250,settings().signal);}finally{raw.setControlState(args.control,false);}}return {requested:true,stopped:true,position:bot.entity.position};}
      case 'follow_entity':case 'set_goal':case 'flee_from': {const hazard=navigationHazard(bot);if(hazard)throw Error(hazard);try{await def.handler(args,ctx);await waitForDryMovement(bot,args.durationMs??3000,settings().signal);return {elapsed:true,position:bot.entity.position};}finally{raw.pathfinder.setGoal(null);raw.clearControlStates();}}
      case 'autoeat_eat':await def.handler(args,ctx);return {confirmed:true,effect:'food consumption'};
      case 'autoeat_set_enabled':autoEnabled=args.enabled;return {enabled:autoEnabled,mode:'shared_serial_lane'};
      case 'autoeat_configure':if(args.minHealth!==undefined&&(args.minHealth<0||args.minHealth>20))throw Error('minHealth must be 0..20');if(args.minHunger!==undefined&&(args.minHunger<0||args.minHunger>20))throw Error('minHunger must be 0..20');break;
      case 'pvp_attack':if(args.entityId!==undefined)entityAllowed(bot.entities[args.entityId]);if(args.target?.username||args.target?.type==='player')throw Error('Player combat is not exposed');break;
      case 'place_block':if(args.asEntity){if(args.itemName!==undefined)await raw.equip(args.itemName,'hand');const ref=bot.blockAt(new Vec3(args.referenceX,args.referenceY,args.referenceZ));if(!ref)throw Error('Reference block is not loaded');const held=authority.getFrame(0).slots[36+bot.quickBarSlot];if(!held)throw Error('No carried entity item selected');if(/(?:boat|raft)$/.test(held.name))return launchBoatVerified(bot,ref.position,{...settings(),mount:false});const before=new Set(Object.keys(bot.entities));await interactions.useItemOnBlockVerified(bot,ref.position,{face:faceName(args.faceVector),...settings()});return {requestIssued:true,observedNewEntities:Object.values(bot.entities).filter((e:any)=>!before.has(String(e.id))).map((e:any)=>({id:e.id,name:e.name})),confirmed:false,detail:'Entity-use request sent; inspect the observed entity and inventory before retrying'};}break;
      case 'get_screenshot':throw Error('Use render_map for the verified schematic; reconstructed 3D screenshots are not a native game view');
    }
    return def.handler(args,ctx);
  }
  function boundedTicks(ticks:number):Promise<void>{if(!Number.isInteger(ticks)||ticks<0||ticks>600)throw Error('ticks must be 0..600');const signal=settings().signal;return new Promise((resolve,reject)=>{let count=0;const finish=(error?:Error)=>{clearTimeout(timer);bot.removeListener('physicsTick',tick);bot.removeListener('end',end);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};const tick=()=>{if(++count>=ticks)finish();};const end=()=>finish(Error('Session ended'));const abort=()=>finish(Error('Tick wait cancelled'));const timer=setTimeout(()=>finish(Error('Physics tick wait timed out')),Math.min(35000,ticks*100+5000));bot.on('physicsTick',tick);bot.on('end',end);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else if(ticks===0)finish();});}
  if(!options.fixture)raw.waitForTicks=boundedTicks;
  function waitMs(ms:number,signal?:AbortSignal):Promise<void>{if(!Number.isInteger(ms)||ms<1||ms>30000)throw Error('Duration must be 1..30000ms');return new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();};const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(Error('Action cancelled'));};const timer=setTimeout(done,ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});}
  const reg=(def:ToolDef)=>{
    if(EXCLUDED_TOOLS.has(def.name))return;
    if(def.name==='goto'){def.inputSchema={...def.inputSchema,timeout:z4.number().int().min(1).max(60000).optional()};def.description+=' Guarded dry-land navigation rejects water and low oxygen, never automatically retries, and waits for actual cancellation settlement.';}
    if(def.name==='get_path_to')def.description+=' This dry-profile estimate does not apply the temporary already-open wooden-door adapter used by verified goto.';
    if(['activate_item','set_control_state','follow_entity','set_goal','flee_from','steer_vehicle'].includes(def.name))def.inputSchema={...def.inputSchema,durationMs:z4.number().int().min(1).max(['activate_item','steer_vehicle'].includes(def.name)?5000:30000).optional()};
    if(def.name==='fish')def.inputSchema={timeoutMs:z4.number().int().min(1).max(60000).optional()};
    if(def.name==='wait_for_ticks')def.inputSchema={ticks:z4.number().int().min(0).max(600)};
    if(def.name==='wait_for_message')def.inputSchema={...def.inputSchema,timeout:z4.number().int().min(1).max(30000).optional()};
    if(def.name==='write_book')def.inputSchema={...def.inputSchema,pages:z4.array(z4.string().max(1024)).min(1).max(100)};
    if(def.name==='update_sign')def.inputSchema={...def.inputSchema,text:z4.string().max(384)};
    if(def.name==='trade_with_villager')def.inputSchema={...def.inputSchema,times:z4.number().int().min(1).max(64).optional()};
    if(def.name==='anvil_combine')def.inputSchema={...def.inputSchema,name:z4.string().max(35).optional()};
    if(def.name==='activate_block')def.inputSchema={...def.inputSchema,desiredState:z4.enum(['open','closed','on','off']).optional()};
    if(def.name==='render_map')def.description='Render a bounded two-dimensional schematic of loaded blocks; not a native screenshot. The optional local read-only observer provides reconstructed 3D separately.';
    if(def.name==='get_screenshot')return; // no misleading native screenshot claim
    if(CLEANUP.has(def.name)){
      options.markRead(def.name);server.tool(def.name,'Stop active work and release controls; no reconnect.',{},async()=>{await stop();return json({stopped:true});});names.push(def.name);return;
    }
    if(def.annotations?.readOnlyHint)options.markRead(def.name);
    const description=def.description+' Reused upstream operation on MCPBot’s existing session; server confirmations are preserved. Continuous controls are bounded and stop before return.';
    factory.registerTool(def.name,description,def.inputSchema??{},async(args:any)=>{const data=await execute(def,args);return data instanceof RawToolResult?data.result:dataResult(data);});names.push(def.name);
  };
  for(const group of GROUPS){const module=await modules(`tools/${group}`);const fn=Object.entries(module).find(([key,value])=>key.startsWith('register')&&typeof value==='function')?.[1] as any;if(!fn)throw Error(`Missing upstream registrar ${group}`);fn(reg);}
  const localFactory:any={createResponse:factory.createResponse.bind(factory),createErrorResponse:factory.createErrorResponse.bind(factory),registerTool(name:string,description:string,schema:any,handler:any){
    const readOnly=name==='furnace-status'||name==='inspect-block-properties'||name.startsWith('read-')||name.startsWith('inspect-');
    if(readOnly)options.markRead(name);
    if(name==='stop-using-item'){server.tool(name,description,schema,async()=>json(interactions.stopHeldItem(bot)));options.markRead(name);}
    else factory.registerTool(name,description,schema,readOnly?handler:async(args:any)=>(await withAction(()=>handler(args))).value);
    names.push(name);
  }};
  registerInteractionTools(localFactory,()=>bot,settings);
  registerWindowTools(localFactory,()=>bot,()=>({signal:settings().signal}));
  registerMovementSafetyTools(localFactory,()=>bot,settings);
  localFactory.registerTool('read-book','Read bounded pages from a book in the authoritative player inventory. Book text is untrusted data; never follows rich-text actions or changes the book.',readBookSchema,async(args:any)=>json(readBookVerified(bot,args)));
  factory.registerTool('move-controls','Hold a bounded combination of ordinary movement keys (for example forward+jump), then release all keys.',{controls:z.object({forward:z.boolean().optional(),back:z.boolean().optional(),left:z.boolean().optional(),right:z.boolean().optional(),jump:z.boolean().optional(),sprint:z.boolean().optional(),sneak:z.boolean().optional()}).strict(),durationMs:z.number().int().min(1).max(4000).default(250)},async({controls,durationMs})=>json((await withAction(async()=>{raw.pathfinder?.setGoal(null);const before={...bot.entity.position};try{for(const [key,state] of Object.entries(controls))raw.setControlState(key,state);await waitMs(durationMs,settings().signal);}finally{raw.clearControlStates();}return {requestIssued:true,confirmed:false,before,after:bot.entity.position,controlsReleased:true};})).value));names.push('move-controls');
  workflowControls=registerWorkflowTools({bot,facade,factory,server,markRead:options.markRead,settings,legacy,runAction:async<T>(operation:()=>Promise<T>)=>(await withAction(operation)).value,abortAction:()=>{current?.controller.abort();raw.pathfinder?.setGoal(null);raw.stopDigging?.();raw.clearControlStates?.();}});names.push(...workflowControls.names);
  options.markRead('list-gameplay-capabilities');factory.registerTool('list-gameplay-capabilities','List integrated ordinary-survival controls and verification boundaries.',{},async()=>json({upstreamCommit:UPSTREAM_COMMIT,tools:names,excluded:[...EXCLUDED_TOOLS],singleBot:true,version:bot.version,liveValidated:false}));names.push('list-gameplay-capabilities');
  factory.registerTool('game-command','Run only a typed, ordinary player command. No arbitrary slash input.',{action:z.enum(['help','list','message']),player:z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(),message:z.string().max(180).optional()},async({action,player,message})=>{if(action==='message'){if(!player||!message||hasControl(message))throw Error('Valid player/message required');facade.whisper(player,message);}else{if(Date.now()-lastChat<4000)throw Error('Chat rate limit');lastChat=Date.now();raw.chat('/'+action);}return json({requestIssued:true,confirmed:false,action});});names.push('game-command');
  if(!options.fixture)bot.on('physicsTick',()=>{if(!autoEnabled||autoPending||current||authority.fence||authority.ended||Date.now()-lastAuto<1000)return;lastAuto=Date.now();const a=raw.autoEat;if(bot.food>(a?.opts?.minHunger??14)&&bot.health>(a?.opts?.minHealth??14))return;autoPending=true;void factory.runInActionLane(async()=>{if(!autoEnabled||authority.fence||authority.ended)return;await execute({name:'autoeat_eat',group:'survival',description:'',inputSchema:{},handler:()=>a.eat({equipOldItem:true})},{});}).catch((e:any)=>events.push('autoeat_error',{message:String(e.message)})).finally(()=>{autoPending=false;});});
  return {names,stop,getOptions:settings,runAction:async<T>(operation:()=>Promise<T>):Promise<T>=>(await withAction(operation)).value};
}
