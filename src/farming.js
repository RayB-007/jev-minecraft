import {Vec3} from 'vec3';
import {setTimeout as delay} from 'node:timers/promises';

export const CROPS=[
  {item:'wheat_seeds',block:'wheat',produce:'wheat'},
  {item:'carrot',block:'carrots',produce:'carrot'},
  {item:'potato',block:'potatoes',produce:'potato'},
  {item:'beetroot_seeds',block:'beetroots',produce:'beetroot'}
];
const point=p=>new Vec3(p.x,p.y,p.z);
export function cropAge(registry,name) {
  return Math.max(...(registry.blocksByName[name]?.states?.find(s=>s.name==='age')?.values??[]).map(Number));
}

export class FarmingSkill {
  constructor(game) {this.game=game;this.known=new Map();}
  attach(memory,world) {this.memory=memory;this.world=world;this.dimension=null;}
  observe(o) {
    const bot=this.game.bot;
    if(this.dimension!==o.dimension) {
      this.dimension=o.dimension;
      this.known=new Map((this.memory?.stations(this.world,o.dimension)??[]).filter(s=>s.kind==='farm').map(s=>[JSON.stringify(s.position),s]));
    }
    const crops=o.blocks.filter(b=>CROPS.some(c=>c.block===b.name));
    for(const b of crops) {
      const k=JSON.stringify(b.position),old=this.known.get(k);
      const state={kind:'farm',position:b.position,crop:b.name,age:b.age,observedAt:o.at??Date.now()};
      this.known.set(k,state);
      if(old?.age!==state.age || state.observedAt-(old?.observedAt??0)>60000) this.memory?.rememberStation(this.world,o.dimension,state);
    }
    const empty=p=>bot.blockAt(point(p).offset(0,1,0))?.name==='air';
    const hydrated=p=>o.blocks.some(b=>b.name==='water' && Math.abs(b.position.y-p.y)<=1 &&
      Math.abs(b.position.x-p.x)<=4 && Math.abs(b.position.z-p.z)<=4);
    return {crops,ripe:crops.filter(b=>b.age>=cropAge(bot.registry,b.name)),
      empty:o.blocks.filter(b=>b.name==='farmland' && b.distance<=4 && empty(b.position)),
      tillable:o.blocks.filter(b=>['grass_block','dirt','dirt_path'].includes(b.name) && b.distance<=4 && hydrated(b.position) && empty(b.position)),
      needsReplant:[...this.known.values()].filter(s=>s.needsReplant && point(s.position).distanceTo(bot.entity.position)<=8),
      remembered:[...this.known.values()].map(s=>({...s,distance:point(s.position).distanceTo(bot.entity.position),status:'Past crop observation; maturity must be checked again'}))};
  }
  async perform(a,signal) {
    const bot=this.game.bot,p=point(a.position),b=bot.blockAt(p);
    if(!b || p.distanceTo(bot.entity.position)>4.5 || !bot.canSeeBlock(b)) throw new Error('Farm target is no longer reachable');
    const equip=async name=>{
      const item=bot.inventory.items().find(i=>i.name===name);if(!item) throw new Error('Required farming item is missing');
      await bot.equip(item,'hand');signal.throwIfAborted();
    };
    if(a.type==='till') {
      if(!['grass_block','dirt','dirt_path'].includes(b.name) || bot.blockAt(p.offset(0,1,0))?.name!=='air') throw new Error('Soil cannot be tilled now');
      if(!a.item?.endsWith('_hoe')) throw new Error('Tilling requires a hoe');
      await equip(a.item);await bot.activateBlock(b);await delay(150,undefined,{signal});
      return {blockChanged:bot.blockAt(p)?.name==='farmland'};
    }
    if(a.type==='plant') {
      const crop=CROPS.find(c=>c.item===a.item);
      if(!crop || b.name!=='farmland' || bot.blockAt(p.offset(0,1,0))?.name!=='air') throw new Error('Planting requires empty farmland');
      await equip(a.item);await bot.placeBlock(b,new Vec3(0,1,0));signal.throwIfAborted();
      const result=bot.blockAt(p.offset(0,1,0));
      return {blockChanged:result?.name===crop.block};
    }
    if(a.type==='fertilize') {
      const age=Number(b.getProperties().age);
      if(!CROPS.some(c=>c.block===b.name) || age>=cropAge(bot.registry,b.name)) throw new Error('The crop does not need bone meal');
      await equip('bone_meal');await bot.activateBlock(b);await delay(150,undefined,{signal});
      return {blockChanged:Number(bot.blockAt(p)?.getProperties().age)>age};
    }
    if(a.type==='harvest-crop') {
      if(!CROPS.some(c=>c.block===b.name) || Number(b.getProperties().age)<cropAge(bot.registry,b.name)) throw new Error('Harvest only mature crops');
      await bot.dig(b,true);signal.throwIfAborted();
      const changed=bot.blockAt(p)?.name!==b.name;
      if(changed) {
        const state={kind:'farm',position:a.position,lastCrop:b.name,seed:CROPS.find(c=>c.block===b.name).item,needsReplant:true,observedAt:Date.now()};
        this.known.set(JSON.stringify(a.position),state);this.memory?.rememberStation(this.world,this.dimension,state);
      }
      return {blockChanged:changed};
    }
    throw new Error('Unknown farming action');
  }
}
