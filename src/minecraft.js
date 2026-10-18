import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';
import navigation from 'mineflayer-pathfinder';
import { Planner } from './planner.js';
import { Shelter } from './shelter.js';
import { travel } from './navigation.js';
import { Exploration } from './exploration.js';
import { FurnaceSkill } from './furnace.js';
import { FarmingSkill,CROPS,cropAge } from './farming.js';

const { pathfinder, Movements, goals: navigationGoals } = navigation;

const HOSTILES = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'husk', 'drowned', 'stray', 'witch', 'pillager', 'vindicator', 'ravager', 'blaze', 'ghast', 'wither_skeleton', 'hoglin', 'piglin_brute', 'phantom', 'silverfish', 'endermite', 'warden', 'ender_dragon']);
const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'cactus', 'magma_block', 'powder_snow', 'sweet_berry_bush']);
const DIRECTIONS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const vector = p => new Vec3(p.x, p.y, p.z);
const plain = p => ({ x: p.x, y: p.y, z: p.z });

export function navigationProfiles(bot) {
  const terrain=new Set(['dirt','grass_block','coarse_dirt','rooted_dirt','stone','cobblestone','gravel','andesite','diorite','granite']);
  const create=(foliage,recovery=false)=>{
    const movement=new Movements(bot);
    movement.canDig=foliage;movement.allowFreeMotion=false;movement.scafoldingBlocks=[];
    for(const b of bot.registry.blocksArray) if(!b.name.endsWith('_leaves') && b.name!=='snow' && !(recovery && terrain.has(b.name))) movement.blocksCantBreak.add(b.id);
    movement.digCost=recovery?4:1;
    movement.allow1by1towers=false;movement.allowParkour=false;movement.maxDropDown=4;
    movement.entitiesToAvoid=new Set(HOSTILES);
    return movement;
  };
  const escape=create(false);escape.maxDropDown=1;
  return {work:create(true),escape,recovery:create(true,true)};
}

export class Minecraft {
  constructor(bot) {
    this.bot = bot;
    this.damageTypes=new Map();
    bot._client?.on('registry_data',packet=>{
      if(packet.id==='minecraft:damage_type') packet.entries.forEach((entry,id)=>this.damageTypes.set(id,entry.key));
    });
    bot._client?.on('damage_event',packet=>{
      if(packet.entityId===bot.entity?.id) this.damageSource={type:this.damageTypes.get(packet.sourceTypeId),at:Date.now()};
    });
    this.exploration=new Exploration();
    bot.on('physicsTick',()=>{if(this.ready && this.connected && bot.entity) this.exploration.visit(bot.entity.position,String(bot.game.dimension));});
    let previousHealth=bot.health??20;
    bot.on('health',()=>{
      if(this.ready && bot.entity && bot.health<previousHealth && !this.isStarvationDamage()) this.exploration.harm(bot.entity.position,(previousHealth-bot.health)*2);
      previousHealth=bot.health;
    });
    this.deaths = 0;
    this.connected = true;
    this.fatal = false;
    this.ready = false;
    this.lastError = null;
    this.recipeCache = { key: null, recipes: [] };
    this.blockedNavigation = new Map();
    this.knownResources = new Map();
    this.explorationVisits = new Map();
    this.planner = new Planner(bot.registry);
    this.shelter = new Shelter(this);
    this.furnaces=new FurnaceSkill(this);
    this.farming=new FarmingSkill(this);
    this.recipeUses = new Map();
    for (const recipes of Object.values(bot.registry.recipes || {})) for (const recipe of recipes) {
      const output = bot.registry.items[recipe.result.id]?.name;
      if (!output) continue;
      const ingredients = recipe.ingredients || recipe.inShape?.flat() || [];
      for (const ingredient of ingredients) {
        const name = bot.registry.items[typeof ingredient === 'number' ? ingredient : ingredient?.id]?.name;
        if (!name) continue;
        if (!this.recipeUses.has(name)) this.recipeUses.set(name, new Set());
        this.recipeUses.get(name).add(output);
      }
    }
    bot.on('death', () => { this.deaths++;if(bot.entity) this.exploration.harm(bot.entity.position,20);this.stop(); });
    bot.on('end', () => { this.connected = false; this.ready = false; });
    bot.on('error', e => { this.lastError = e.message; });
    bot.on('spawn', () => { this.ready = true;this.needsSurvey=true;this.exploration.scansRemaining=4; });
    bot.on('respawn', () => { this.ready = false; this.stop(); });
  }
  static async connect(options, signal) {
    const bot = mineflayer.createBot({ ...options, respawn: true });
    bot.loadPlugin(pathfinder);
    const game = new Minecraft(bot);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => done(new Error('Minecraft connection timed out')), 30000);
        const done = error => {
          clearTimeout(timer); bot.off('spawn', spawn); bot.off('error', errorEvent); bot.off('end', end);
          signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve();
        };
        const spawn = () => done();
        const errorEvent = e => done(e);
        const end = () => done(new Error('Minecraft disconnected before spawn'));
        const abort = () => done(new Error('Connection cancelled'));
        bot.once('spawn', spawn); bot.once('error', errorEvent); bot.once('end', end);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      game.navigation=navigationProfiles(bot);
      for(const movement of Object.values(game.navigation)) movement.exclusionAreasStep.push(b=>game.exploration.risk(b?.position??b)*0.25);
      bot.pathfinder.setMovements(game.navigation.escape);
      bot.pathfinder.tickTimeout = 8;
      bot.pathfinder.thinkTimeout = 1500;
      bot.pathfinder.searchRadius = 64;
      await bot.waitForChunksToLoad();
      return game;
    } catch (e) { game.close(); throw e; }
  }
  stop() {
    this.bot.pathfinder?.setGoal(null);
    this.bot.clearControlStates?.();
    this.bot.stopDigging?.();
    if (this.bot.usingHeldItem) this.bot.deactivateItem?.();
  }
  stopWork() { if (!this.inDanger?.()) this.stop(); }
  close() { this.ready=false;this.connected=false;this.stop();this.bot.quit?.(); }
  isStarvationDamage() {
    return this.bot.food===0 && this.damageSource?.type==='minecraft:starve' && Date.now()-this.damageSource.at<500;
  }

  async waitReady(signal) {
    const deadline = Date.now() + 15000;
    while (this.connected && (!this.ready || this.bot.health <= 0)) {
      if (Date.now() > deadline) throw new Error('Minecraft did not become ready after respawn');
      await delay(50, undefined, { signal });
    }
    if (!this.connected) throw new Error('Minecraft disconnected during respawn');
  }

  visible(point) {
    const eye = this.bot.entity.position.offset(0, this.bot.entity.eyeHeight ?? 1.62, 0);
    const delta = point.minus(eye), distance = delta.norm();
    if (distance < 0.1) return true;
    const hit = this.bot.world.raycast(eye, delta.scaled(1 / distance), distance);
    return !hit || hit.intersect.distanceTo(eye) >= distance - 0.15;
  }

  senseThreats() {
    const bot = this.bot;
    return Object.values(bot.entities).filter(e => e !== bot.entity && HOSTILES.has(e.name) &&
      // Daylight spiders are neutral until provoked. Their presence alone must not
      // interrupt every task; recent actual damage still enables a safety reaction.
      !(e.name==='spider' && bot.time.isDay && Date.now()-(this.lastDamageAt??0)>5000) &&
      e.position?.distanceTo(bot.entity.position) <= 8 && this.visible(e.position.offset(0, (e.height ?? 1) / 2, 0)))
      .map(e => ({ id: e.id, name: e.name, position: plain(e.position), distance: e.position.distanceTo(bot.entity.position) }))
      .sort((a, b) => a.distance - b.distance);
  }

  loadMemory(locations) {
    for (const location of locations) {
      const block = this.bot.registry.blocksByName[location.name];
      const berry=block?.name==='sweet_berry_bush';
      if (!block?.diggable || !block.drops?.length && !berry || HAZARDS.has(block.name) && !berry) continue;
      const position = { x: location.x, y: location.y, z: location.z };
      const key = JSON.stringify(position);
      if (!this.knownResources.has(key)) this.knownResources.set(key, { name: location.name, position,
        drops: berry?['sweet_berries']:block.drops.map(id => this.bot.registry.items[id]?.name).filter(Boolean), lastSeen: location.seen, remembered: true });
    }
  }

  usesFor(item) { return [...(this.recipeUses.get(item) || [])].slice(0, 8); }
  setEmergency(active) {
    if(!this.navigation) return;
    const recover=!active && Date.now()<(this.recoveryUntil||0) && this.bot.inventory.items().some(i=>i.name.endsWith('_pickaxe'));
    const movement=active?this.navigation.escape:recover?this.navigation.recovery:this.navigation.work;
    movement.maxDropDown=active?1:this.bot.health<=6?2:4;
    const foodReserve=this.bot.inventory.items().reduce((n,i)=>n+(this.bot.registry.foodsByName?.[i.name]?.foodPoints??0)*i.count,0);
    movement.allowSprinting=active?this.bot.food>6:this.bot.food>=18 || foodReserve>=8;
    if(this.bot.pathfinder.movements!==movement) this.bot.pathfinder.setMovements(movement);
  }
  canHarvestName(name) {
    const required=this.bot.registry.blocksByName[name]?.harvestTools;
    return !required || this.bot.inventory.items().some(i=>required[i.type]);
  }
  goals(o) {
    if(this.needsSurvey && this.exploration.scansRemaining>0 && !(o.food<18 && o.inventory.some(i=>this.bot.registry.foodsByName?.[i.name])))
      return [{id:'survey',kind:'explore',description:'Inspect the surroundings after spawning before choosing a task.'}];
    this.needsSurvey=false;
    const reachable=b=>b.diggable || (this.blockedNavigation.get(JSON.stringify(b.position))||0)<Date.now();
    return this.planner.goals({...o,blocks:o.blocks.filter(reachable),knownResources:(o.knownResources||[]).filter(reachable)});
  }
  canClearLeaf(b) {
    if(!b?.name.endsWith('_leaves') || !this.bot.canDigBlock(b) || b.position.distanceTo(this.bot.entity.position)>3) return false;
    const feet=this.bot.entity.position.floored();
    if(b.position.y>=feet.y) return true;
    if(b.position.x!==feet.x || b.position.z!==feet.z || b.position.y!==feet.y-1) return false;
    return this.safeDescent(b);
  }
  safeDescent(b) {
    if(!b || !/_(log|stem|leaves)$/.test(b.name)) return false;
    for(const n of [1,2,3]) {
      const floor=this.bot.blockAt(b.position.offset(0,-n,0));
      if(!floor || HAZARDS.has(floor.name) || floor.name==='water') return false;
      if(floor.boundingBox==='block') return true;
    }
    return false;
  }

  placementAt(position, item) {
    const bot=this.bot,p=vector(position), current=bot.blockAt(p), body=bot.entity.position;
    if(!current || !['air','snow'].includes(current.name) || p.distanceTo(body)>4.5) return;
    if(body.x+0.3>p.x && body.x-0.3<p.x+1 && body.z+0.3>p.z && body.z-0.3<p.z+1 && body.y+1.8>p.y && body.y<p.y+1) return;
    if(item.endsWith('_door') && bot.blockAt(p.offset(0,1,0))?.name!=='air') return;
    for(const face of [new Vec3(0,1,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1),new Vec3(0,-1,0)]) {
      const reference=bot.blockAt(p.minus(face));
      if(!reference || reference.boundingBox!=='block' || !bot.canSeeBlock(reference)) continue;
      if(item.endsWith('_door') && face.y!==1) continue;
      return {type:'place',item,position:plain(reference.position),targetPosition:plain(p),face:plain(face),blockName:reference.name,
        description:`Place ${item} at ${JSON.stringify(plain(p))}.`};
    }
  }

  escapeThreat(threat) {
    if (!this.bot.pathfinder || (this.lastEscapeUpdate && Date.now() - this.lastEscapeUpdate < 1000)) return;
    this.lastEscapeUpdate = Date.now();
    this.setEmergency(true);
    this.bot.pathfinder.setGoal(new navigationGoals.GoalInvert(new navigationGoals.GoalNear(
      threat.position.x, threat.position.y, threat.position.z, 13)));
  }
  approachThreat(threat) {
    if(!this.bot.pathfinder || this.lastCombatUpdate && Date.now()-this.lastCombatUpdate<600) return;
    this.lastCombatUpdate=Date.now();this.setEmergency(true);
    this.bot.pathfinder.setGoal(new navigationGoals.GoalNear(threat.position.x,threat.position.y,threat.position.z,2));
  }

  inView(point) {
    const bot = this.bot, eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const delta = point.minus(eye), length = delta.norm();
    if (length < 0.8) return true;
    const yaw = bot.entity.yaw, pitch = bot.entity.pitch;
    const facing = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    return facing.dot(delta.scaled(1 / length)) >= Math.cos(Math.PI * 0.36);
  }

  safeStep(direction) {
    const p = this.bot.entity.position.floored(), [dx, dz] = DIRECTIONS[direction] ?? [];
    if (dx === undefined) return false;
    // Check the whole player width. A clear center block can still leave the
    // shoulder colliding with a trunk in the neighboring column.
    const body=this.bot.entity.position;
    for(const ahead of [0.4,0.8]) for(const side of [-0.29,0.29]) {
      const x=Math.floor(body.x+dx*ahead+(dz?side:0)),z=Math.floor(body.z+dz*ahead+(dx?side:0));
      for(const y of [Math.floor(body.y+0.2),Math.floor(body.y+1.7)]) {
        const b=this.bot.blockAt(new Vec3(x,y,z));
        if(!b || HAZARDS.has(b.name) || b.boundingBox==='block' && !b.shapes?.every(s=>s[4]<=0.125)) return false;
      }
    }
    for (let i = 0; i <= 1; i++) {
      const feet = this.bot.blockAt(p.offset(dx * i, 0, dz * i));
      const head = this.bot.blockAt(p.offset(dx * i, 1, dz * i));
      const below = this.bot.blockAt(p.offset(dx * i, -1, dz * i));
      if (!feet || !head || !below || HAZARDS.has(feet.name) || HAZARDS.has(below.name) ||
        (feet.boundingBox !== 'empty' && !feet.shapes?.every(s => s[4] <= 0.125)) || head.boundingBox !== 'empty' || below.boundingBox !== 'block') return false;
    }
    return true;
  }

  safeJump(direction) {
    const p = this.bot.entity.position.floored(), [dx, dz] = DIRECTIONS[direction] ?? [];
    if (dx === undefined) return false;
    const step = this.bot.blockAt(p.offset(dx, 0, dz));
    const clearance = [p.offset(0, 2, 0), p.offset(dx, 1, dz), p.offset(dx, 2, dz)].map(p => this.bot.blockAt(p));
    return Boolean(step && step.boundingBox === 'block' && !HAZARDS.has(step.name) &&
      clearance.every(b => b && b.boundingBox === 'empty' && !HAZARDS.has(b.name)));
  }

  observe() {
    const bot = this.bot;
    if (!this.connected || !this.ready || !bot.entity) throw new Error('Minecraft is not ready');
    const position = bot.entity.position;
    const visitKey = p=>`${Math.floor(p.x/3)},${Math.floor(p.z/3)}`;
    if(this.lastVisit!==visitKey(position)) {
      this.lastVisit=visitKey(position);
      this.explorationVisits.set(this.lastVisit,(this.explorationVisits.get(this.lastVisit)||0)+1);
    }
    const blocks = [];
    // Only nearby exposed blocks, never an ore search through loaded chunks or a world seed lookup.
    const frontiers = [];
    for (let x = -8; x <= 8; x++) for (let y = -6; y <= 5; y++) for (let z = -8; z <= 8; z++) {
      const p = position.floored().offset(x, y, z);
      const b = bot.blockAt(p);
      if (!b || b.name === 'air' || b.name === 'cave_air' || !this.inView(p.offset(0.5, 0.5, 0.5)) || !bot.canSeeBlock(b)) continue;
      const tool = bot.pathfinder?.bestHarvestTool(b);
      const berry=b.name==='sweet_berry_bush' && Number(b.getProperties?.().age)>=2;
      const crop=CROPS.find(c=>c.block===b.name),ripe=crop && Number(b.getProperties?.().age)>=cropAge(bot.registry,b.name);
      const drops = berry?['sweet_berries']:ripe?[...new Set([crop.produce,crop.item])]:(b.drops ?? []).map(id => bot.registry.items[id]?.name).filter(Boolean);
      blocks.push({ name: b.name, position: plain(p), fullCube: b.shapes?.some(s => s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1), distance: +position.distanceTo(p).toFixed(2),
        age:b.getProperties?.().age,
        diggable: bot.canDigBlock(b) && b.diggable && !HAZARDS.has(b.name),
        harvestAction:berry?'harvest':ripe?'harvest-crop':undefined,
        harvestable: berry || (!crop || ripe) && b.diggable && !HAZARDS.has(b.name) && (!b.canHarvest || b.canHarvest(tool?.type ?? null)),
        drops, uses: drops.flatMap(drop => this.usesFor(drop)).slice(0, 8) });
      if (b.boundingBox === 'block' && !HAZARDS.has(b.name) && y >= -3 && y <= 1 &&
        bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty' && bot.blockAt(p.offset(0, 2, 0))?.boundingBox === 'empty') {
        const distance = position.distanceTo(p.offset(0, 1, 0));
        if (distance > 2 && distance <= 8) frontiers.push({ position: plain(p.offset(0, 1, 0)), distance, surface:b.name });
      }
    }
    blocks.sort((a, b) => a.distance - b.distance);
    for (const b of blocks) if (b.harvestable && b.drops.length)
      this.knownResources.set(JSON.stringify(b.position), { ...b, lastSeen: Date.now(), remembered: true });
    for (const [key, b] of this.knownResources) {
      const current = bot.blockAt(vector(b.position));
      if (current && (current.name !== b.name || current.name==='sweet_berry_bush' && Number(current.getProperties?.().age)<2) && this.inView(vector(b.position).offset(0.5, 0.5, 0.5)) &&
        (current.name==='air'?this.visible(vector(b.position).offset(0.5,0.5,0.5)):bot.canSeeBlock(current)))
        this.knownResources.delete(key);
    }
    // Preserve name diversity; a nearby wall must not crowd a tree out of the observation budget.
    const firstByName = [...new Map(blocks.map(b => b.name).map(name => [name, blocks.find(b => b.name === name)])).values()];
    const observedBlocks = [...new Set([...firstByName, ...blocks])].slice(0, 64);
    const items = bot.inventory.items();
    const counts = new Map();
    for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    const table = blocks.find(b => b.name === 'crafting_table' && b.distance <= 4);
    const tableBlock = table ? bot.blockAt(vector(table.position)) : null;
    const recipeKey = JSON.stringify([[...counts], table?.position, bot.version]);
    const recipes = this.recipeCache.key === recipeKey ? this.recipeCache.recipes : [];
    // Recipe definitions are game mechanics knowledge, not hidden world state.
    if (this.recipeCache.key !== recipeKey) for (const item of bot.registry.itemsArray) {
      const matches = bot.recipesFor(item.id, null, 1, tableBlock);
      if (matches.length) recipes.push({ name: item.name, count: matches[0].result.count, table: Boolean(matches[0].requiresTable) });
    }
    this.recipeCache = { key: recipeKey, recipes };
    const entities = Object.values(bot.entities).filter(e => e !== bot.entity && e.position &&
      e.position.distanceTo(position) <= (e.name==='item'?24:48) && this.inView(e.position.offset(0, (e.height ?? 1) / 2, 0)) && this.visible(e.position.offset(0, (e.height ?? 1) / 2, 0)))
      .map(e => ({ id: e.id, name: e.name ?? e.type, kind: HOSTILES.has(e.name) ? 'hostile' : 'other',
        item: e.getDroppedItem?.()?.name, position: plain(e.position), distance: +e.position.distanceTo(position).toFixed(2) }))
      .sort((a, b) => a.distance - b.distance).slice(0, 16);
    const rememberedCounts = new Map();
    const remembered = [...this.knownResources.values()].filter(b=>this.canHarvestName(b.name)).map(b => ({ name: b.name, position: b.position, drops: b.drops,
      uses: b.drops.flatMap(drop => this.usesFor(drop)).slice(0, 8), lastSeen: b.lastSeen, remembered: true,
      routeBlocked: (this.blockedNavigation.get(JSON.stringify(b.position))??0)>Date.now(),
      distance: position.distanceTo(vector(b.position)) })).sort((a, b) => a.distance - b.distance)
      .filter(b => { const n = rememberedCounts.get(b.name) || 0; rememberedCounts.set(b.name, n + 1); return n < 2; }).slice(0, 32);
    const observation={ at: Date.now(), source: 'minecraft-client-line-of-sight', dimension: String(bot.game.dimension),
      health: bot.health, food: bot.food, oxygen: bot.oxygenLevel ?? null, deaths: this.deaths,
      position: plain(position), yaw: bot.entity.yaw, pitch: bot.entity.pitch, heldItem: bot.heldItem?.name ?? null,
      timeOfDay: bot.time.timeOfDay,lastDamage:this.damageSource??null, inventory: [...counts].map(([name, count]) => ({ name, count })),
      blocks: observedBlocks, entities, recipes: recipes.slice(0, 64),furnaces:this.furnaces.observations(),
      equipment:Object.fromEntries([['head',5],['torso',6],['legs',7],['feet',8],['off-hand',45]].map(([name,slot])=>[name,bot.inventory.slots?.[slot]?.name??null])),
      light:{block:bot.blockAt(position.floored())?.light??null,sky:bot.blockAt(position.floored())?.skyLight??null},
      facilities: ['crafting_table', 'furnace', 'chest'].map(name => ({ name, owned: counts.get(name) ?? 0,
        nearby: blocks.some(b => b.name === name && b.distance < 5) })),
      shelter: this.shelter.observe([...counts].map(([name,count])=>({name,count}))), sleeping: Boolean(bot.isSleeping),
      frontiers: frontiers.sort((a,b)=>(this.explorationVisits.get(visitKey(a.position))||0)-(this.explorationVisits.get(visitKey(b.position))||0) || b.distance-a.distance).slice(0,24),
      knownResources: remembered,
      safeDirections: Object.keys(DIRECTIONS).filter(d => this.safeStep(d)),
      jumpDirections: Object.keys(DIRECTIONS).filter(d => this.safeJump(d)),
      semantics: { health: bot.health <= 6 ? 'critical' : bot.health < 15 ? 'injured' : 'healthy',
        hunger: bot.food < 10 ? 'hungry' : 'fed', daylight: bot.time.isDay ? 'day' : 'night',
        unknown: 'Unseen blocks, distant mobs, seed, structures, and unexplored terrain are unknown.' } };
    observation.farm=this.farming.observe(observation);
    return observation;
  }

  actions(o, goal, history = []) {
    if(['till','plant','fertilize','harvest-crop'].includes(goal?.kind)) return [{id:'a0',type:goal.kind,
      item:goal.target,position:goal.position,description:goal.description}];
    if(goal?.kind==='wear') return [{id:'a0',type:'wear',item:goal.target,slot:goal.slot,description:goal.description}];
    if(['smelt','furnace-check'].includes(goal?.kind)) return [{id:'a0',type:goal.kind,input:goal.input,output:goal.target,
      fuel:goal.fuel,position:goal.position,description:goal.description}];
    if(goal?.kind==='explore') {
      const clearance=o.blocks.filter(b=>b.name.endsWith('_leaves') && b.diggable && this.canClearLeaf(this.bot.blockAt(vector(b.position))))
        .map(b=>({type:'dig',position:b.position,blockName:b.name,clearPath:true,description:'Clear a reachable leaf obstruction to continue through the forest.'}));
      return this.exploration.actions(o,this.blockedNavigation,clearance).map((a,i)=>({...a,id:`a${i}`}));
    }
    if(goal?.kind==='pickup') return o.entities.filter(e=>e.id===goal.entityId && e.item===goal.target)
      .map((e,i)=>({id:`a${i}`,type:'collect',entityId:e.id,position:e.position,item:e.item,range:0,description:`Recover the observed ${e.item}.`}));
    if(goal?.kind==='station') return [{id:'a0',type:'navigate',blockName:goal.target,remembered:true,position:goal.position,
      description:`Return to the known ${goal.target} and recheck it.`}];
    if(goal?.kind==='shelter') return this.shelter.actions(o).map((a,i)=>({...a,id:`a${i}`}));
    if(goal?.kind==='sleep') return o.blocks.filter(b=>b.name.endsWith('_bed') && b.distance<=4)
      .map((b,i)=>({id:`a${i}`,type:'sleep',position:b.position,blockName:b.name,description:'Sleep in the nearby bed and set the respawn point.'}));
    const actions = [
      { type: 'look', yaw: o.yaw + Math.PI / 2, pitch: -0.55, description: 'Inspect terrain to the left and below.' },
      { type: 'look', yaw: o.yaw - Math.PI / 2, pitch: -0.55, description: 'Inspect terrain to the right and below.' }
    ];
    for (const direction of o.safeDirections) actions.push({ type: 'move', direction, description: `Walk a short distance ${direction} across currently clear supported ground.` });
    for (const direction of o.jumpDirections ?? []) actions.push({ type: 'jump', direction, description: `Jump onto the visible one-block-high step ${direction}.` });
    for (const b of o.blocks.filter(b => b.harvestable && b.drops?.length && !b.diggable && b.distance <= 12 &&
      (this.blockedNavigation.get(JSON.stringify(b.position))||0)<Date.now()).slice(0, 12))
      actions.push({ type: 'navigate', position: b.position, blockName: b.name, range: 2, description: `Approach visible ${b.name} for collection.` });
    if (goal?.kind === 'gather' && !o.blocks.some(b => b.name === goal.target)) {
      for (const b of (o.knownResources || []).filter(b => b.name === goal.target &&
        (this.blockedNavigation.get(JSON.stringify(b.position)) ?? 0) < Date.now()).slice(0, 3))
        actions.push({ type: 'navigate', position: b.position, blockName: b.name, remembered: true,
          description: `Approach the last observed ${b.name} and check whether it is still there.` });
    }
    const lastPositions = history.filter(h => h.action.type === 'navigate').map(h => h.action.position);
    const surfaceSearch=goal?.kind==='explore';
    const frontiers=[...(o.frontiers??[])].sort((a,b)=>surfaceSearch ?
      (Number(/grass|podzol|dirt|snow/.test(b.surface??''))-Number(/grass|podzol|dirt|snow/.test(a.surface??''))) || b.position.y-a.position.y : 0);
    for (const f of frontiers) {
      if (lastPositions.some(p => Math.hypot(p.x - f.position.x, p.z - f.position.z) < 1.5) ||
        (this.blockedNavigation.get(JSON.stringify(f.position)) ?? 0) > Date.now()) continue;
      actions.push({ type: 'navigate', position: f.position, range: 0, frontier: true, description: `Explore visible ground ${Math.round(f.distance)} blocks away at ${JSON.stringify(f.position)}.` });
      if (actions.filter(a => a.frontier).length >= 4) break;
    }
    for (const e of o.entities.filter(e => e.name === 'item')) actions.push({ type: 'collect', entityId:e.id, position: e.position, item: e.item,
      range: 0, description: `Pick up the visible ${e.item || 'dropped item'}.` });
    if(goal?.kind==='hunt') for(const e of o.entities.filter(e=>e.id===goal.entityId && e.distance>2.8))
      actions.push({type:'approach',entityId:e.id,entityName:e.name,position:e.position,description:`Approach the observed ${e.name} to obtain food or wool.`});
    for (const b of o.blocks.filter(b => (b.diggable || b.harvestAction) && b.distance <= 4).slice(0, 16)) {
      if(b.harvestAction) {actions.push({type:b.harvestAction,position:b.position,blockName:b.name,description:b.harvestAction==='harvest'?'Pick ripe berries without walking into or destroying the bush.':'Harvest a verified mature food crop.'});continue;}
      // Do not mine the support directly under the player.
      const leaf=b.name.endsWith('_leaves') && this.canClearLeaf(this.bot.blockAt(vector(b.position)));
      const support=b.position.x===Math.floor(o.position.x) && b.position.z===Math.floor(o.position.z) && b.position.y===Math.floor(o.position.y)-1;
      if (support && !leaf && !this.safeDescent(this.bot.blockAt(vector(b.position)))) continue;
      actions.push({ type: 'dig', position: b.position, blockName: b.name,clearPath:leaf,
        description: leaf ? 'Clear one reachable leaf obstruction; any descent must have a safe landing within three blocks.' : `Mine one visible ${b.name} at ${JSON.stringify(b.position)}. Possible drops: ${b.drops.join(', ') || 'unknown'}.` });
    }
    for (const r of o.recipes.slice(0, 64)) actions.push({ type: 'craft', item: r.name, description: `Craft ${r.count} ${r.name} using a verified available recipe.` });
    for (const i of o.inventory) {
      if (this.bot.registry.foodsByName?.[i.name] && o.food < 20) actions.push({ type: 'eat', item: i.name, description: `Eat one ${i.name} to restore hunger.` });
      if (i.name !== o.heldItem) actions.push({ type: 'equip', item: i.name, description: `Hold ${i.name} to use it as a tool or weapon.` });
      if (this.bot.registry.blocksByName[i.name]) {
        if(i.name==='torch') {
          for(const b of o.blocks.filter(b=>b.distance<=4 && b.fullCube)) {
            for(const face of [new Vec3(0,1,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]) {
              const target=vector(b.position).plus(face);
              if(this.bot.blockAt(target)?.name!=='air') continue;
              actions.push({type:'place',item:i.name,position:b.position,targetPosition:plain(target),face:plain(face),blockName:b.name,
                description:'Place a torch on an observed supporting floor or wall.'});
            }
          }
          continue;
        }
        for (const b of o.blocks.filter(b => b.distance <= 4 && b.fullCube)) {
          const above = this.bot.blockAt(vector(b.position).offset(0, 1, 0));
          if (above?.name !== 'air' || vector(above.position).distanceTo(this.bot.entity.position) < 1.2) continue;
          if(i.name.endsWith('_bed')) {
            if(!o.dimension.includes('overworld')) continue;
            for(const [dx,dz,yaw] of [[0,1,Math.PI],[0,-1,0],[1,0,-Math.PI/2],[-1,0,Math.PI/2]]) {
              if(this.bot.blockAt(vector(above.position).offset(dx,0,dz))?.name!=='air' || this.bot.blockAt(vector(above.position).offset(dx,-1,dz))?.boundingBox!=='block') continue;
              actions.push({type:'place',item:i.name,position:b.position,blockName:b.name,yaw,
                description:`Place ${i.name} in a supported two-block space.`}); break;
            }
            continue;
          }
          actions.push({ type: 'place', item: i.name, position: b.position, blockName: b.name,
            description: `Place ${i.name} above the visible ${b.name} at ${JSON.stringify(b.position)}.` });
        }
      }
    }
    for (const b of o.blocks.filter(b => ['crafting_table', 'chest', 'furnace'].includes(b.name) && b.distance <= 4).slice(0, 4))
      actions.push({ type: 'interact', position: b.position, blockName: b.name, description: `Interact with ${b.name}.` });
    for (const e of o.entities.filter(e => e.distance <= 3 && e.name !== 'player' && e.name !== 'item').slice(0, 4))
      actions.push({ type: 'attack', entityId: e.id, entityName: e.name, description: `Attack visible ${e.name} once within melee reach.` });
    // Per-control budgets prevent a large craft/inventory list from hiding survival controls.
    const limits = { look: 2, wait: 1, move: 4, jump: 4, navigate: 16, approach:4, collect: 4, dig: 16, harvest:8,'harvest-crop':8, craft: 64, equip: 16, place: 32, eat: 8, interact: 4, attack: 8 };
    const counts = {};
    let allowed = actions.filter(a => (counts[a.type] = (counts[a.type] ?? 0) + 1) <= limits[a.type]);
    if (goal?.kind === 'gather') {
      const focused = allowed.filter(a => (['dig', 'harvest','harvest-crop', 'navigate'].includes(a.type) && a.blockName === goal.target) ||
        (a.type === 'collect' && (!a.item || goal.drops?.includes(a.item))));
      const clearance=allowed.filter(a=>a.clearPath);
      if(focused.some(a=>['dig','harvest','harvest-crop'].includes(a.type))) allowed=focused.filter(a=>a.type!=='navigate');
      else if(focused.length || clearance.length) allowed=[...focused,...clearance];
      else allowed=allowed.filter(a=>['look','move','jump'].includes(a.type) || a.frontier);
    } else if (goal?.kind === 'hunt') {
      allowed=allowed.filter(a=>(['attack','approach'].includes(a.type) && a.entityId===goal.entityId) || (a.type==='collect' && goal.drops.includes(a.item)));
    } else if (goal?.kind === 'craft') {
      const focused = allowed.filter(a => a.type === 'craft' && a.item === goal.target);
      allowed = focused;
    } else if (goal?.kind === 'build') {
      const focused = allowed.filter(a => a.type === 'place' && a.item === goal.target);
      allowed = focused.length?focused:allowed.filter(a=>['look','move','jump'].includes(a.type) || a.frontier);
    } else if (goal?.kind === 'survive') {
      const food = allowed.filter(a => a.type === 'eat');
      if (food.length) allowed = food;
    } else if (goal?.kind === 'explore') {
      const frontiers = allowed.filter(a => a.frontier);
      const movement = frontiers.length ? frontiers : allowed.filter(a => a.type === 'move' || a.type === 'jump');
      const clearance=allowed.filter(a=>a.clearPath);
      if(clearance.length && history.slice(-2).some(h=>h.result?.pathStatus==='noPath')) allowed=clearance;
      else if (movement.length) {
        const last=history.at(-1)?.action;
        const opposite={north:'south',south:'north',east:'west',west:'east'};
        const continuing=movement.filter(a=>!(last?.type==='move' && a.type==='move' && a.direction===opposite[last.direction]));
        allowed=continuing.length?continuing:movement;
      } else allowed=allowed.filter(a=>a.type==='look' || a.type==='dig' && (a.blockName.endsWith('_leaves') || a.blockName==='snow'));
    }
    if (goal && !['craft', 'build'].includes(goal.kind)) allowed = allowed.filter(a => !['place', 'craft', 'equip', 'interact'].includes(a.type));
    if (!allowed.length) allowed = actions.filter(a => a.type === 'look');
    return allowed
      .map((a, i) => ({ ...a, id: `a${i}` }));
  }

  async execute(action, { signal, timeoutMs = action.type==='craft'?15000:['navigate','collect','approach'].includes(action.type)?10000:['place','smelt','furnace-check'].includes(action.type)?8000:4500 } = {}) {
    if (this.fatal) throw new Error('Executor is closed after cancellation');
    const bot = this.bot, startHealth = bot.health;
    const interrupt = new AbortController();
    const onHealth = () => { if (bot.health < startHealth && !this.isStarvationDamage()) interrupt.abort(new Error('Interrupted by damage')); };
    const onDeath = () => interrupt.abort(new Error('Interrupted by death'));
    const onEnd = () => interrupt.abort(new Error('Minecraft disconnected'));
    bot.on('health', onHealth); bot.on('death', onDeath); bot.on('end', onEnd);
    const combined = AbortSignal.any([interrupt.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let abortHandler, operation;
    try {
      combined.throwIfAborted();
      operation = this.perform(action, combined);
      const cancelled = new Promise((_, reject) => {
        abortHandler = () => reject(combined.reason);
        combined.addEventListener('abort', abortHandler, { once: true });
        if (combined.aborted) abortHandler();
      });
      const detail = await Promise.race([operation, cancelled]);
      this.stopWork();
      await delay(action.type === 'dig' ? 180 : 50, undefined, { signal: combined });
      return { ok: true, ...detail };
    } catch (e) {
      // Mineflayer craft/place RPCs cannot all be cancelled. Disconnect before another action
      // can start: no timed-out operation is allowed to mutate the next decision's state.
      let terminalObservation;
      if (combined.aborted) {
        this.stopWork();
        try { terminalObservation = this.observe(); } catch { /* No invented post-state after loss of observation. */ }
        // Drain cancellable work before reusing controls. Only an unresolved RPC closes the client.
        const drained = await Promise.race([Promise.resolve(operation).then(() => true, () => true), delay(300).then(() => false)]);
        if (!drained) { this.fatal = true; this.close(); }
      }
      return { ok: false, error: String(e.message ?? e), fatal: this.fatal, terminalObservation };
    } finally {
      combined.removeEventListener('abort', abortHandler);
      bot.off('health', onHealth); bot.off('death', onDeath); bot.off('end', onEnd);
      this.stopWork();
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
    }
  }

  async perform(a, signal) {
    const bot = this.bot;
    if(['smelt','furnace-check'].includes(a.type)) return this.furnaces.perform(a,signal);
    if(['till','plant','fertilize','harvest-crop'].includes(a.type)) return this.farming.perform(a,signal);
    const getBlock = () => {
      const b = bot.blockAt(vector(a.position));
      if (!b || b.name !== a.blockName || !bot.canSeeBlock(b) || b.position.distanceTo(bot.entity.position) > (a.type === 'navigate' ? 12 : 4.5)) throw new Error('Target block changed or is unreachable');
      return b;
    };
    const equip = async () => {
      const item = bot.inventory.items().find(i => i.name === a.item);
      if (!item) throw new Error('Item is no longer available');
      await bot.equip(item, 'hand'); signal.throwIfAborted();
    };
    if (a.type === 'wait') { await delay(350, undefined, { signal }); return {}; }
    if (a.type === 'look') { await bot.look(a.yaw, a.pitch ?? 0, false); return {}; }
    if (a.type === 'navigate' || a.type === 'collect' || a.type === 'approach') {
      if (!bot.pathfinder) throw new Error('Navigation plugin unavailable');
      if (a.blockName && !a.remembered) getBlock();
      return travel(this,a,signal);
    }
    if (a.type === 'move' || a.type === 'jump') {
      const jumping = a.type === 'jump';
      if (!(jumping ? this.safeJump(a.direction) : this.safeStep(a.direction))) throw new Error('Movement ground is blocked, unsafe or unknown');
      const [dx, dz] = DIRECTIONS[a.direction], start = bot.entity.position.clone();
      await bot.lookAt(start.offset(dx * 3, 1.62, dz * 3), false); signal.throwIfAborted();
      bot.setControlState('forward', true);
      if (jumping) bot.setControlState('jump', true);
      // Check terrain every 25 ms; never keep walking during model inference.
      const until = Date.now() + (jumping ? 400 : 220);
      while (Date.now() < until && bot.entity.position.distanceTo(start) < 0.85) {
        if (!jumping && !this.safeStep(a.direction)) break;
        await delay(25, undefined, { signal });
      }
      return {distanceMoved:bot.entity.position.distanceTo(start)};
    }
    if (a.type === 'dig') {
      if (this.inDanger?.() || this.senseThreats().some(t => t.distance < 9)) throw new Error('Mining blocked while threatened or recovering from damage');
      const b = getBlock();
      if(a.clearPath && !this.canClearLeaf(b)) throw new Error('The leaf obstruction no longer has a safe clearance or landing');
      const feet=bot.entity.position.floored();
      if(b.position.equals(feet.offset(0,-1,0)) && !this.safeDescent(b)) throw new Error('Do not mine the supporting block without a verified safe landing');
      if (!b.diggable || !bot.canDigBlock(b)) throw new Error('Cannot dig target');
      const tool = bot.pathfinder?.bestHarvestTool(b);
      if(a.clearObstruction && !['snow'].includes(b.name)) throw new Error('Only snow may be cleared without harvesting its drops');
      if(!a.clearObstruction && b.canHarvest && !b.canHarvest(tool?.type ?? null)) throw new Error('The available tool cannot harvest this block');
      if (tool && bot.heldItem?.type !== tool.type) { await bot.equip(tool, 'hand'); signal.throwIfAborted(); }
      if (bot.digTime(b) > 4000) throw new Error('Mining exceeds action budget; choose a better tool');
      await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true); signal.throwIfAborted();
      await bot.dig(b, 'ignore');
      const after = bot.blockAt(b.position);
      if (after && after.type !== b.type) this.knownResources.delete(JSON.stringify(b.position));
      return { blockChanged: Boolean(after && after.type !== b.type) };
    }
    if (a.type === 'craft') {
      const item = bot.registry.itemsByName[a.item];
      if (!item) throw new Error('Unknown recipe output');
      // findBlock's matcher also runs on palette-only blocks with no position.
      // Use actually observed locations instead of raycasting those palette entries.
      const table = [...this.knownResources.values()].filter(b=>b.name==='crafting_table')
        .map(b=>bot.blockAt(vector(b.position))).find(b=>b?.name==='crafting_table' &&
          b.position.distanceTo(bot.entity.position)<=4 && bot.canSeeBlock(b));
      const recipe = bot.recipesFor(item.id, null, 1, table)[0];
      if (!recipe) throw new Error('Recipe prerequisites changed');
      // Container state IDs are not the player's inventory state ID. Refresh
      // after closing a furnace before the first optimistic crafting click.
      if(bot._syncWindow) {await delay(100,undefined,{signal});await bot._syncWindow(bot.inventory);await delay(100,undefined,{signal});}
      const beforeCounts=new Map(bot.inventory.items().map(i=>[i.name,bot.inventory.items().filter(j=>j.name===i.name).reduce((n,j)=>n+j.count,0)]));
      await bot.craft(recipe, 1, recipe.requiresTable?table:null);
      // Reconcile optimistic inventory clicks with the server before awarding craft credit.
      if(bot._syncWindow) {await delay(100,undefined,{signal});await bot._syncWindow(bot.inventory);await delay(100,undefined,{signal});}
      // The 2x2 grid is not a container that closes automatically. Reclaim any
      // server-confirmed unused ingredients; inventory.items() excludes this grid.
      if(bot.inventory.slots && !recipe.requiresTable) {
        for(let pass=0;pass<4;pass++) {
          if(bot.inventory.selectedItem) {
            const held=bot.inventory.selectedItem;
            const space=bot.inventory.slots.slice(bot.inventory.inventoryStart,bot.inventory.inventoryEnd).some(i=>!i || i.type===held.type && i.count<i.stackSize);
            if(!space) throw new Error('Inventory full; cannot safely recover crafting cursor');
            await bot.putSelectedItemRange(bot.inventory.inventoryStart,bot.inventory.inventoryEnd,bot.inventory,null);
          }
          for(let slot=1;slot<=4;slot++) if(bot.inventory.slots[slot]) {await bot.putAway(slot);signal.throwIfAborted();}
          if(bot._syncWindow) {await delay(100,undefined,{signal});await bot._syncWindow(bot.inventory);await delay(100,undefined,{signal});}
          if(!bot.inventory.selectedItem && !bot.inventory.slots.slice(1,5).some(Boolean)) break;
        }
      }
      const afterCounts=new Map();for(const i of bot.inventory.items()) afterCounts.set(i.name,(afterCounts.get(i.name)??0)+i.count);
      const expected=new Map((recipe.delta??[]).filter(d=>d.count<0).map(d=>[bot.registry.items[d.id]?.name,-d.count]));
      const unexpectedLoss=[...beforeCounts].filter(([name,n])=>n-(afterCounts.get(name)??0)>(expected.get(name)??0));
      return {inventoryConserved:unexpectedLoss.length===0,unexpectedLoss};
    }
    if (a.type === 'equip') { await equip(); return {}; }
    if(a.type==='wear') {
      if(!['head','torso','legs','feet','off-hand'].includes(a.slot)) throw new Error('Invalid equipment slot');
      const item=bot.inventory.items().find(i=>i.name===a.item);
      if(!item) throw new Error('Equipment is no longer held');
      await bot.equip(item,a.slot);signal.throwIfAborted();return {};
    }
    if(a.type==='harvest') {
      const b=getBlock(),age=Number(b.getProperties?.().age);
      if(b.name!=='sweet_berry_bush' || age<2) throw new Error('The berries are not ripe');
      await bot.activateBlock(b);await delay(180,undefined,{signal});
      return {blockChanged:Number(bot.blockAt(b.position)?.getProperties?.().age)<age};
    }
    if (a.type === 'eat') { await equip(); await bot.consume(); return {}; }
    if (a.type === 'place') {
      const b = getBlock(),face=a.face?vector(a.face):new Vec3(0,1,0), p = b.position.plus(face);
      const body=bot.entity.position;
      const collides=body.x+0.3>p.x && body.x-0.3<p.x+1 && body.z+0.3>p.z && body.z-0.3<p.z+1 && body.y+1.8>p.y && body.y<p.y+1;
      if (bot.blockAt(p)?.name !== 'air' || collides) throw new Error('Placement space changed');
      await equip();
      const interactive=['crafting_table','furnace','blast_furnace','smoker','chest','barrel'].includes(b.name);
      try {
        if(interactive) {bot.setControlState('sneak',true);await delay(75,undefined,{signal});}
        if(a.yaw!==undefined) {await bot.look(a.yaw,0,false);signal.throwIfAborted();}
        if(a.yaw!==undefined) await bot._placeBlockWithOptions(b,face,{forceLook:'ignore',swingArm:'right'});
        else await bot.placeBlock(b, face);
      } finally {if(interactive) bot.setControlState('sneak',false);}
      return { blockChanged: bot.blockAt(p)?.name === a.item || a.item==='torch' && bot.blockAt(p)?.name==='wall_torch' };
    }
    if(a.type==='sleep') {
      if(!String(bot.game.dimension).includes('overworld')) throw new Error('Sleeping is only safe in the Overworld');
      const bed=getBlock(); await bot.sleep(bed);return {sleepStarted:Boolean(bot.isSleeping)};
    }
    if (a.type === 'attack') {
      const weapons = bot.inventory.items().filter(i => /_(sword|axe)$/.test(i.name));
      const score = i => (i.name.endsWith('_sword') ? 10 : 5) + ['wooden','golden','stone','iron','diamond','netherite'].indexOf(i.name.split('_')[0]);
      weapons.sort((a,b) => score(b)-score(a));
      if (weapons[0] && bot.heldItem?.type !== weapons[0].type) { await bot.equip(weapons[0], 'hand'); signal.throwIfAborted(); }
      const cooldown = bot.heldItem?.name.endsWith('_axe') ? 1050 : 650;
      const remaining = cooldown - (Date.now() - (this.lastMeleeAt ?? 0));
      if (remaining > 0) await delay(remaining, undefined, { signal });
      const e = bot.entities[a.entityId];
      if (!e || e.name !== a.entityName || e.position.distanceTo(bot.entity.position) > 3 || !this.visible(e.position.offset(0, 0.5, 0))) throw new Error('Entity target is no longer reachable');
      let hitObserved = false;
      const hurt = target => { if (target.id === e.id) hitObserved = true; };
      bot.on('entityHurt', hurt); bot.on('entityDead', hurt);
      try { await bot.lookAt(e.position.offset(0, 0.5, 0), false); signal.throwIfAborted(); bot.attack(e); this.lastMeleeAt = Date.now(); await delay(400, undefined, { signal }); }
      finally { bot.off('entityHurt', hurt); bot.off('entityDead', hurt); }
      return { hitObserved };
    }
    if (a.type === 'interact') {
      const b = getBlock();
      if (b.name === 'chest') { const container = await bot.openContainer(b); container.close(); return { windowOpened: true }; }
      if (b.name === 'furnace') { const furnace = await bot.openFurnace(b); furnace.close(); return { windowOpened: true }; }
      await bot.activateBlock(b); return { windowOpened: Boolean(bot.currentWindow) };
    }
    throw new Error('Unsupported action');
  }
}
