import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Vec3} from 'vec3';

export const SMELTING=JSON.parse(readFileSync(new URL('./data/smelting-1.21.1.json',import.meta.url),'utf8')).recipes;
export const smeltingFor=item=>SMELTING.filter(r=>r.output===item);
const plain=p=>({x:p.x,y:p.y,z:p.z});
const stack=i=>i?{name:i.name,count:i.count}:null;
const count=(items,name)=>items.filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);

// One of these fuels can cook one item. Prefer planks to burning a whole log.
export function furnaceFuel(items,input) {
  const score=i=>i.name==='coal'?0:i.name==='charcoal'?1:i.name.endsWith('_planks')?2:3;
  return items.filter(i=>['coal','charcoal'].includes(i.name) || /_(planks|log|wood)$/.test(i.name))
    .filter(i=>!i.name.startsWith('crimson_') && !i.name.startsWith('warped_'))
    .filter(i=>count(items,i.name)>(i.name===input?1:0)).sort((a,b)=>score(a)-score(b))[0]?.name;
}

export class FurnaceSkill {
  constructor(game) {this.game=game;this.known=new Map();}
  attach(memory,world) {this.memory=memory;this.world=world;this.dimension=null;}
  observations() {
    const dimension=String(this.game.bot.game.dimension),p=this.game.bot.entity.position;
    if(this.dimension!==dimension) {
      this.dimension=dimension;
      this.known=new Map((this.memory?.stations(this.world,dimension)??[]).filter(s=>s.kind!=='farm').map(s=>[JSON.stringify(s.position),s]));
    }
    return [...this.known.values()].map(s=>({...s,distance:p.distanceTo(new Vec3(s.position.x,s.position.y,s.position.z)),
      status:'Last observed furnace contents; inspect again to verify completion'}));
  }
  remember(state) {
    this.known.set(JSON.stringify(state.position),state);
    this.memory?.rememberStation(this.world,this.dimension,state);
  }
  async perform(a,signal) {
    const bot=this.game.bot,p=new Vec3(a.position.x,a.position.y,a.position.z),block=bot.blockAt(p);
    if(block && block.name!=='furnace' && p.distanceTo(bot.entity.position)<=4.5 && this.game.visible(p.offset(0.5,0.5,0.5))) {
      this.known.delete(JSON.stringify(plain(p)));this.memory?.forgetStation(this.world,this.dimension,plain(p));
    }
    if(!block || block.name!=='furnace' || p.distanceTo(bot.entity.position)>4.5 || !bot.canSeeBlock(block))
      throw new Error('The observed furnace is no longer reachable');
    this.observations();
    const previous=this.known.get(JSON.stringify(plain(p)));
    const ui=await bot.openFurnace(block);
    let inputInserted=false,fuelInserted=false;
    const capture=()=>{
      const input=stack(ui.inputItem()),output=stack(ui.outputItem()),fuel=stack(ui.fuelItem());
      const recipe=input && SMELTING.find(r=>r.inputs.includes(input.name));
      return {position:plain(p),observedAt:Date.now(),input,output,fuel,fuelSeconds:ui.fuelSeconds??null,
        expectedOutput:output?.name??recipe?.output??null,
        readyAfter:recipe ? previous?.input?.name===input.name && previous.readyAfter ? previous.readyAfter :
          Date.now()+recipe.ticks*50*(1-(ui.progress??0)) : null};
    };
    const checkpoint=()=>this.remember(capture());
    try {
      signal.throwIfAborted();
      await delay(100,undefined,{signal});
      if(ui.outputItem()) {
        if(a.output && ui.outputItem().name!==a.output) throw new Error('The furnace contains a different output; reobserve before taking it');
        const output=ui.outputItem().name;await ui.takeOutput();signal.throwIfAborted();
        return {outputTaken:output};
      }
      if(a.type==='smelt' && !ui.inputItem()) {
        if(!SMELTING.some(r=>r.output===a.output && r.inputs.includes(a.input))) throw new Error('Unknown vanilla smelting recipe');
        const input=bot.inventory.items().find(i=>i.name===a.input);
        if(!input) throw new Error('Smelting input is no longer held');
        await ui.putInput(input.type,null,1);inputInserted=true;checkpoint();signal.throwIfAborted();
      }
      if(ui.inputItem() && a.input && ui.inputItem().name!==a.input) throw new Error('The furnace is processing a different input');
      if(!ui.inputItem()) return {empty:true};
      if(!ui.fuelItem() && !(ui.fuelSeconds>0)) {
        const name=a.fuel??furnaceFuel(bot.inventory.items());
        const fuel=bot.inventory.items().find(i=>i.name===name);
        if(!fuel || !furnaceFuel([fuel])) return {needsFuel:true};
        await ui.putFuel(fuel.type,null,1);fuelInserted=true;checkpoint();signal.throwIfAborted();
      }
      if(inputInserted || fuelInserted) return {inputInserted,fuelInserted,processing:true};
      // Checking is a short action. Cooking continues on the server between checks.
      const deadline=Date.now()+750;
      while(Date.now()<deadline && !ui.outputItem()) await delay(50,undefined,{signal});
      if(ui.outputItem()) {
        if(a.output && ui.outputItem().name!==a.output) throw new Error('Furnace output changed');
        const output=ui.outputItem().name;await ui.takeOutput();signal.throwIfAborted();return {outputTaken:output};
      }
      return {processing:true};
    } finally {
      try {checkpoint();} finally {ui.close();}
    }
  }
}
