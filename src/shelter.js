import { Vec3 } from 'vec3';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const dangerous=new Set(['lava','fire','magma_block','powder_snow','water','cactus']);
export const buildingMaterial = name => name.endsWith('_planks') || ['cobblestone','cobbled_deepslate','stone','dirt'].includes(name);
const point=p=>new Vec3(p.x,p.y,p.z);
const plain=p=>({x:p.x,y:p.y,z:p.z});
export class Shelter {
  constructor(game) { this.game=game; }
  persist(path) {
    this.path=path;
    try {const data=JSON.parse(readFileSync(path,'utf8'));if(data.dimension===String(this.game.bot.game.dimension)) {this.anchor=data.anchor;this.lastSurvey=data.lastSurvey;}}catch{/* New world project. */}
  }
  survey() {
    const bot=this.game.bot,p=bot.entity.position.floored();
    if(!String(bot.game.dimension).includes('overworld')) return;
    for(let r=0;r<=3;r++) for(let dx=-r;dx<=r;dx++) for(let dz=-r;dz<=r;dz++) {
      const a=p.offset(dx-1,0,dz-1);
      let clear=true;
      for(let x=0;x<4 && clear;x++) for(let z=0;z<4 && clear;z++) {
        const ground=bot.blockAt(a.offset(x,-1,z));
        if(!ground || ground.boundingBox!=='block' || dangerous.has(ground.name) || !bot.canSeeBlock(ground)) {clear=false;break;}
        for(let y=0;y<=2;y++) {
          const b=bot.blockAt(a.offset(x,y,z));
          if(!b || (b.boundingBox!=='empty' && b.name!=='snow') || dangerous.has(b.name)) clear=false;
        }
      }
      if(clear) {
        this.anchor=plain(a);
        if(this.path) {mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path,JSON.stringify({dimension:String(bot.game.dimension),anchor:this.anchor}));}
        return;
      }
    }
  }
  observe(inventory) {
    if(!this.anchor) this.survey();
    if(!this.anchor) return {available:false};
    const bot=this.game.bot,a=point(this.anchor), positions=[];
    for(let y=0;y<2;y++)for(let x=0;x<4;x++)for(let z=0;z<4;z++) {
      if(x!==0 && x!==3 && z!==0 && z!==3) continue;
      if(x===1 && z===0) continue; // Actual two-block doorway, fitted after the shell.
      positions.push(a.offset(x,y,z));
    }
    for(let x=0;x<4;x++)for(let z=0;z<4;z++)positions.push(a.offset(x,2,z));
    if([...positions,a.offset(1,0,0)].some(p=>!bot.blockAt(p)))
      return {available:true,anchor:this.anchor,observed:false,remaining:null,complete:false,...this.lastSurvey,status:'Past survey; house chunks are currently unobserved'};
    const missing=positions.filter(p=>!bot.blockAt(p)?.shapes?.some(s=>s[0]===0 && s[1]===0 && s[2]===0 && s[3]===1 && s[4]===1 && s[5]===1));
    const door=bot.blockAt(a.offset(1,0,0))?.name.endsWith('_door') || false;
    const snapshot={remaining:missing.length,complete:missing.length===0 && door,door};
    if(JSON.stringify(snapshot)!==JSON.stringify(this.lastSurvey)) {
      this.lastSurvey=snapshot;
      if(this.path) writeFileSync(this.path,JSON.stringify({dimension:String(bot.game.dimension),anchor:this.anchor,lastSurvey:snapshot}));
    }
    return {available:true,anchor:this.anchor,observed:true,...snapshot,
      entrance:plain(a.offset(1,0,-1)),workPosition:plain(a.offset(1,0,1)),
      missing:missing.map(plain),doorPosition:plain(a.offset(1,0,0)),
      materialCount:inventory.filter(i=>buildingMaterial(i.name)).reduce((n,i)=>n+i.count,0)};
  }
  actions(o) {
    const s=o.shelter;
    if(!s?.available || s.complete) return [];
    const bot=this.game.bot,materials=o.inventory.filter(i=>buildingMaterial(i.name));
    const actions=[];
    if(!s.remaining && !s.door) {
      for(const offset of [0,1]) {
        const p=point(s.doorPosition).offset(0,offset,0), b=bot.blockAt(p);
        if(b && b.name!=='air' && !b.name.endsWith('_door') && b.diggable && bot.canSeeBlock(b) && bot.canDigBlock(b))
          actions.push({type:'dig',position:plain(p),blockName:b.name,clearObstruction:b.name==='snow',description:'Clear the surveyed house doorway so its door can be fitted.'});
      }
      for(const item of o.inventory.filter(i=>i.name.endsWith('_door') && i.name!=='iron_door')) {
      const a=this.game.placementAt(s.doorPosition,item.name);
      if(a) actions.push({...a,yaw:Math.PI,description:'Fit the house doorway with a door.'});
      }
      if(!actions.length) actions.push({type:'navigate',position:s.entrance||plain(point(s.anchor).offset(1,0,-1)),range:0,
        description:'Walk to the house entrance to finish fitting the door.'});
      return actions;
    }
    // Work from the room, rather than standing behind an already-built wall.
    const work=s.workPosition||plain(point(s.anchor).offset(1,0,1));
    const p=bot.entity.position, a=point(s.anchor);
    const inside=p.x>=a.x+1 && p.x<a.x+3 && p.z>=a.z+1 && p.z<a.z+3 && Math.abs(p.y-a.y)<0.5;
    if(!inside) return [{type:'navigate',position:work,range:0,description:'Enter the house footprint before constructing its walls and roof.'}];
    for(const p of s.missing)for(const item of materials.slice(0,2)) {
      const obstruction=bot.blockAt(point(p));
      if(obstruction?.name==='snow' && bot.canSeeBlock(obstruction) && bot.canDigBlock(obstruction)) {
        if(!actions.some(a=>a.type==='dig' && a.position.x===p.x && a.position.y===p.y && a.position.z===p.z))
          actions.push({type:'dig',position:p,blockName:'snow',clearObstruction:true,description:'Clear the snow occupying a required house block before building.'});
        continue;
      }
      const a=this.game.placementAt(p,item.name);
      if(a) actions.push({...a,description:`Build a missing house wall or roof block using ${item.name}.`});
    }
    if(!actions.length) actions.push({type:'navigate',position:work,range:0,description:'Reposition inside the house to reach the next required block.'});
    return actions.slice(0,8);
  }
}
