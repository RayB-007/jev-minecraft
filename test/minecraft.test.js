import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';
import { Minecraft, navigationProfiles } from '../src/minecraft.js';
import registry from 'prismarine-registry';
import { fixture } from '../src/benchmark.js';

function fakeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, { health: 20, food: 20, version: 'test',
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62, yaw: 0, pitch: 0 },
    game: { dimension: 'overworld' }, time: { timeOfDay: 1000, isDay: true },
    inventory: { items: () => [] }, registry: { itemsArray: [], items: {}, blocksByName: {} }, entities: {},
    blockAt(p) { return { name: p.y === 63 ? 'stone' : 'air', boundingBox: p.y === 63 ? 'block' : 'empty', position: p }; },
    canSeeBlock: () => true, canDigBlock: () => true, recipesFor: () => [],
    world: { raycast: () => null }, clearControlStates() { bot.cleared = (bot.cleared ?? 0) + 1; },
    stopDigging() {}, deactivateItem() {}, quit() { bot.quitCalled = true; },
    setControlState() {}, async look() {}, async lookAt() {} });
  return bot;
}

test('field of view excludes blocks behind the player and turning reveals them', () => {
  const bot = fakeBot(), game = new Minecraft(bot);
  assert.equal(game.inView(new Vec3(0, 65.62, -4)), true);
  assert.equal(game.inView(new Vec3(0, 65.62, 4)), false);
  bot.entity.yaw = Math.PI;
  assert.equal(game.inView(new Vec3(0, 65.62, 4)), true);
});

test('unknown terrain and hazards are excluded from safe movement', () => {
  const bot = fakeBot(), game = new Minecraft(bot);
  assert.equal(game.safeStep('north'), true);
  bot.blockAt = () => null;
  assert.equal(game.safeStep('north'), false);
  bot.blockAt = p => ({ name: p.y === 63 ? 'lava' : 'air', boundingBox: p.y === 63 ? 'block' : 'empty' });
  assert.equal(game.safeStep('north'), false);
});

test('movement rejects a tree clipping the player shoulder even when the center column is clear',()=>{
 const bot=fakeBot(),game=new Minecraft(bot),original=bot.blockAt;
 bot.entity.position=new Vec3(-12.21,64,-104.7);
 bot.blockAt=p=>p.x===-12 && p.y===65 && p.z===-106 ? {name:'spruce_log',position:p,boundingBox:'block',shapes:[[0,0,0,1,1,1]]}:original(p);
 assert.equal(game.safeStep('north'),false);assert.equal(game.safeStep('south'),true);
});

test('perception omits occluded blocks even when their data is loaded', () => {
  const bot = fakeBot(), game = new Minecraft(bot); bot.emit('spawn');
  bot.blockAt = p => ({ name: 'diamond_ore', position: p, drops: [], boundingBox: 'block' });
  bot.canSeeBlock = () => false;
  assert.deepEqual(game.observe().blocks, []);
});

test('executor rejects stale targets before calling the mining API', async () => {
  const bot = fakeBot(), game = new Minecraft(bot); bot.emit('spawn');
  let dug = false; bot.dig = async () => { dug = true; };
  const r = await game.execute({ type: 'dig', blockName: 'oak_log', position: { x: 1, y: 64, z: 0 } });
  assert.equal(r.ok, false); assert.equal(dug, false); assert.ok(bot.cleared > 0);
});

test('uncancellable operation timeout closes the executor before another action', async () => {
  const bot = fakeBot(), game = new Minecraft(bot); bot.emit('spawn');
  game.perform = () => new Promise(() => {});
  const keeper = delay(500);
  const r = await game.execute({ type: 'craft' }, { timeoutMs: 5 });
  assert.equal(r.fatal, true); assert.equal(bot.quitCalled, true);
  await assert.rejects(game.execute({ type: 'wait' }), /closed/);
  await keeper;
});

test('damage interrupts cancellable movement without leaving controls held', async () => {
  const bot = fakeBot(), game = new Minecraft(bot); bot.emit('spawn');
  game.perform = async (_, signal) => { await delay(100, undefined, { signal }); return {}; };
  const operation = game.execute({ type: 'move' });
  bot.health = 18; bot.emit('health');
  const r = await operation;
  assert.equal(r.ok, false); assert.equal(r.fatal, false); assert.ok(bot.cleared > 0);
  assert.equal(r.terminalObservation.health, 18);
  assert.equal(bot.quitCalled, undefined);
});

test('verified starvation damage does not cancel obtaining food, while an actual attack still interrupts',async()=>{
 const bot=fakeBot();bot._client=new EventEmitter();bot.entity.id=77;bot.food=0;
 const game=new Minecraft(bot);bot.emit('spawn');
 bot._client.emit('registry_data',{id:'minecraft:damage_type',entries:[{key:'minecraft:starve'},{key:'minecraft:mob_attack'}]});
 game.perform=async(_,signal)=>{await delay(40,undefined,{signal});return {};};
 let action=game.execute({type:'eat'});
 bot._client.emit('damage_event',{entityId:77,sourceTypeId:0});bot.health--;bot.emit('health');
 assert.equal((await action).ok,true);
 action=game.execute({type:'eat'});
 bot._client.emit('damage_event',{entityId:77,sourceTypeId:1});bot.health--;bot.emit('health');
 assert.equal((await action).ok,false);
});

test('gathering retains an observed resource outside the camera view and avoids unrelated building', () => {
  const game = new Minecraft(fakeBot());
  const o = { ...fixture(), safeDirections: [], blocks: [], knownResources: [
    { name: 'oak_log', position: { x: 5, y: 64, z: 0 }, drops: ['oak_log'], remembered: true }
  ] };
  const actions = game.actions(o, { kind: 'gather', target: 'oak_log', drops: ['oak_log'] });
  assert.ok(actions.some(a => a.type === 'navigate' && a.remembered && a.blockName === 'oak_log'));
  assert.equal(actions.some(a => ['wait', 'place', 'craft'].includes(a.type)), false);
});

test('recent damage prevents a work action from beginning mining',async()=>{
  const bot=fakeBot(),game=new Minecraft(bot);bot.emit('spawn');
  game.inDanger=()=>true;let dug=false;bot.dig=async()=>{dug=true;};
  const result=await game.execute({type:'dig',blockName:'stone',position:{x:1,y:64,z:0}});
  assert.equal(result.ok,false);assert.match(result.error,/threatened/);assert.equal(dug,false);
});

test('a surveyed shelter preserves its doorway and verifies all walls and roof before completion',()=>{
  const bot=fakeBot(),game=new Minecraft(bot);bot.emit('spawn');
  const initial=game.shelter.observe([{name:'spruce_planks',count:40}]);
  assert.equal(initial.available,true);assert.equal(initial.complete,false);assert.equal(initial.remaining,38);
  assert.equal(initial.missing.some(p=>p.x===initial.doorPosition.x && p.z===initial.doorPosition.z && p.y<initial.doorPosition.y+2),false);
  const occupied=new Map(initial.missing.map(p=>[JSON.stringify(p),{name:'spruce_planks',boundingBox:'block',shapes:[[0,0,0,1,1,1]],position:new Vec3(p.x,p.y,p.z)}]));
  occupied.set(JSON.stringify(initial.doorPosition),{name:'spruce_door',boundingBox:'block'});
  const original=bot.blockAt;
  bot.blockAt=p=>occupied.get(JSON.stringify({x:p.x,y:p.y,z:p.z})) || original(p);
  assert.equal(game.shelter.observe([]).complete,true);
  const key=JSON.stringify(initial.missing[0]),solid=occupied.get(key);
  occupied.set(key,{name:'snow',boundingBox:'block',shapes:[[0,0,0,1,0.125,1]]});
  assert.equal(game.shelter.observe([]).complete,false);
  occupied.set(key,solid);
  occupied.delete(JSON.stringify(initial.missing.at(-1)));
  assert.equal(game.shelter.observe([]).complete,false);
});

test('wood beside the player can be mined below foot height, while the support block stays protected',()=>{
  const game=new Minecraft(fakeBot()),o={...fixture(),safeDirections:[],inventory:[],recipes:[],blocks:[
    {name:'oak_log',position:{x:1,y:62,z:0},distance:2.3,diggable:true,harvestable:true,drops:['oak_log']},
    {name:'oak_log',position:{x:0,y:63,z:0},distance:1,diggable:true,harvestable:true,drops:['oak_log']}
  ]};
  const actions=game.actions(o,{kind:'gather',target:'oak_log',drops:['oak_log']});
  assert.ok(actions.some(a=>a.type==='dig' && a.position.x===1 && a.position.y===62));
  assert.equal(actions.some(a=>a.type==='dig' && a.position.x===0 && a.position.y===63),false);
});

test('escape cannot dig, and work navigation can clear foliage but cannot tunnel through dirt or logs',()=>{
  const r=registry('1.21.1'),profiles=navigationProfiles({registry:r});
  assert.equal(profiles.escape.canDig,false);
  assert.equal(profiles.work.canDig,true);
  assert.equal(profiles.work.blocksCantBreak.has(r.blocksByName.dirt.id),true);
  assert.equal(profiles.work.blocksCantBreak.has(r.blocksByName.spruce_log.id),true);
  assert.equal(profiles.work.blocksCantBreak.has(r.blocksByName.spruce_leaves.id),false);
  assert.equal(profiles.recovery.blocksCantBreak.has(r.blocksByName.stone.id),false);
  assert.equal(profiles.recovery.blocksCantBreak.has(r.blocksByName.diamond_ore.id),true);
  assert.equal(profiles.recovery.blocksCantBreak.has(r.blocksByName.spruce_log.id),true);
});

test('travel conserves hunger without food reserves while emergency escape can still sprint',()=>{
 const bot=fakeBot();bot.registry=registry('1.21.1');bot.food=12;
 bot.pathfinder={setMovements(m){this.movements=m;}};
 const game=new Minecraft(bot);game.navigation=navigationProfiles(bot);
 game.setEmergency(false);assert.equal(bot.pathfinder.movements.allowSprinting,false);
 game.setEmergency(true);assert.equal(bot.pathfinder.movements.allowSprinting,true);
 bot.food=5;game.setEmergency(true);assert.equal(bot.pathfinder.movements.allowSprinting,false);
 bot.health=2;game.setEmergency(false);assert.equal(bot.pathfinder.movements.maxDropDown,2);
});

test('crafting uses observed table positions, never a palette entry without a position',async()=>{
 const bot=fakeBot(),game=new Minecraft(bot);bot.emit('spawn');
 const recipe={requiresTable:false};
 bot.registry.itemsByName={stick:{id:1}};bot.recipesFor=()=>[recipe];
 bot.findBlock=()=>{throw new Error('Palette-only blocks have no position');};
 let crafted=false,synced=false;
 bot.craft=async(r,n,table)=>{assert.equal(r,recipe);assert.equal(table,null);crafted=true;};
 bot._syncWindow=async()=>{synced=true;};
 const result=await game.execute({type:'craft',item:'stick'});
 assert.equal(result.ok,true);assert.equal(crafted,true);assert.equal(synced,true);
});

test('crafting reclaims a cursor stack revealed by a late authoritative update',async()=>{
 const bot=fakeBot(),game=new Minecraft(bot);bot.emit('spawn');
 const log={name:'oak_log',type:1,count:7,stackSize:64},planks={name:'oak_planks',type:2,count:4};
 bot.registry.itemsByName={oak_planks:{id:2}};bot.registry.items={1:{name:'oak_log'}};
 bot.recipesFor=()=>[{requiresTable:false,delta:[{id:1,count:-1}]}];
 const slots=Array(46).fill(null);slots[9]={...log,count:8};
 Object.assign(bot.inventory,{slots,inventoryStart:9,inventoryEnd:45,selectedItem:null,
  items:()=>slots.slice(9,45).filter(Boolean)});
 let syncs=0,reclaimed=0;
 bot.craft=async()=>{slots[9]=null;slots[10]=planks;};
 bot._syncWindow=async()=>{syncs++;if(syncs===3) bot.inventory.selectedItem=log;};
 bot.putSelectedItemRange=async()=>{reclaimed++;slots[9]=bot.inventory.selectedItem;bot.inventory.selectedItem=null;};
 const result=await game.execute({type:'craft',item:'oak_planks'});
 assert.equal(result.ok,true);assert.equal(result.inventoryConserved,true);
 assert.equal(reclaimed,1);assert.equal(slots[9].count,7);assert.equal(bot.inventory.selectedItem,null);
});

test('an unloaded house retains its last survey without inventing missing walls',()=>{
 const bot=fakeBot(),game=new Minecraft(bot);bot.emit('spawn');
 const surveyed=game.shelter.observe([]);assert.equal(surveyed.observed,true);
 bot.blockAt=()=>null;
 const stale=game.shelter.observe([]);
 assert.equal(stale.observed,false);assert.equal(stale.remaining,surveyed.remaining);
 assert.equal(stale.missing,undefined);
});

test('a blocked placement goal cannot fall back to unrelated crafting or equipment',()=>{
 const game=new Minecraft(fakeBot()),o={...fixture(),recipes:[{name:'oak_button',count:1}],inventory:[{name:'stick',count:4}]};
 const actions=game.actions(o,{kind:'build',target:'crafting_table'});
 assert.equal(actions.some(a=>['craft','equip','dig'].includes(a.type)),false);
});

test('finishing a house approaches the doorway even when the actor is already near a wall',()=>{
 const bot=fakeBot(),game=new Minecraft(bot);
 game.placementAt=()=>undefined;
 const s={available:true,complete:false,remaining:0,door:false,anchor:{x:0,y:64,z:0},doorPosition:{x:1,y:64,z:0},entrance:{x:1,y:64,z:-1}};
 const actions=game.shelter.actions({shelter:s,inventory:[{name:'spruce_door',count:1}]});
 assert.equal(actions[0].type,'navigate');assert.deepEqual(actions[0].position,s.entrance);
 assert.equal(actions[0].range,0);
});

test('ripe berries are food observations and produce a harvest action without mining the bush',async()=>{
 const bot=fakeBot(),game=new Minecraft(bot);bot.emit('spawn');
 let age=3;
 const original=bot.blockAt;
 bot.blockAt=p=>p.x===0 && p.y===64 && p.z===-2 ? {
  name:'sweet_berry_bush',position:p,drops:[],diggable:true,boundingBox:'empty',getProperties:()=>({age})
 } : original(p);
 bot.activateBlock=async()=>{age=1;};
 const o=game.observe(),berry=o.blocks.find(b=>b.name==='sweet_berry_bush');
 assert.equal(berry.harvestable,true);assert.deepEqual(berry.drops,['sweet_berries']);
 const actions=game.actions(o,{kind:'gather',target:'sweet_berry_bush',drops:['sweet_berries']});
 assert.equal(actions[0].type,'harvest');assert.equal(actions.some(a=>a.type==='dig'),false);
 const result=await game.execute(actions[0]);assert.equal(result.blockChanged,true);
 game.observe();assert.equal([...game.knownResources.values()].some(b=>b.name==='sweet_berry_bush'),false);
});

test('daylight neutral spiders do not cause endless retreat, but recent damage does',()=>{
 const bot=fakeBot(),game=new Minecraft(bot);
 bot.entities[1]={id:1,name:'spider',position:new Vec3(2,64,0)};game.visible=()=>true;
 assert.equal(game.senseThreats().length,0);
 game.lastDamageAt=Date.now();assert.equal(game.senseThreats().length,1);
});
