// Goal-directed recipe prerequisites, derived from registry recipes and observed resources.
// No world seed, hidden resources, or ordered Minecraft walkthrough.
import {SMELTING,smeltingFor,furnaceFuel} from './furnace.js';
import {CROPS} from './farming.js';
const ANIMALS = { sheep: ['mutton'], cow: ['beef'], pig: ['porkchop'], chicken: ['chicken'], rabbit: ['rabbit'],salmon:['salmon'],cod:['cod'] };
const WOOL = ['white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black'].map(c=>`${c}_wool`);
const count = (o, name) => o.inventory.filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);
const tier = name => ['wooden','golden','stone','iron','diamond','netherite'].indexOf(name.split('_')[0]);
export class Planner {
  constructor(registry,{now=Date.now}={}) {
    this.registry = registry;this.now=now;this.huntEpisodes=new Map();this.huntBlocked=new Map();
  }
  availableAnimals(o) {return o.entities.filter(e=>ANIMALS[e.name] && (this.huntBlocked.get(e.id)??0)<=this.now());}
  station(name,path) {
    const near=this.o.blocks.find(b=>b.name===name && b.distance<=4);
    if(near) return {cost:0,position:near.position};
    if(count(this.o,name)) return {cost:1,next:{id:`build:${name}`,kind:'build',target:name,description:`Place the held ${name} on safe ground.`}};
    const known=(this.o.knownResources??[]).find(b=>b.name===name && b.distance<=16 && !b.routeBlocked);
    if(known) return {cost:2+known.distance/4,next:{id:`station:${name}`,kind:'station',target:name,position:known.position,description:`Return to the observed ${name}.`}};
    return this.plan(name,1,path);
  }
  fuelPlan(path=new Set(),input) {
    const fuel=furnaceFuel(this.o.inventory,input);
    if(fuel) return {cost:0,fuel};
    if(input?.endsWith('_log') && count(this.o,input)===1) {
      const extra=this.plan(input,2,path);
      if(extra.next && extra.cost<100) return extra;
    }
    const options=['coal',...this.registry.itemsArray.filter(i=>i.name.endsWith('_planks') && !/^(crimson|warped)_/.test(i.name)).map(i=>i.name)]
      .map(item=>this.plan(item,1,path)).filter(p=>p.next && p.cost<100).sort((a,b)=>a.cost-b.cost);
    return options[0]??{cost:1000};
  }
  furnaceGoal(job) {
    if(job.distance>4) return {id:'station:furnace',kind:'station',target:'furnace',position:job.position,priority:145,description:'Return to the furnace to inspect the actual cooking result.'};
    if(job.input && !job.fuel && !(job.fuelSeconds>0)) {
      const fuel=this.fuelPlan(new Set([job.expectedOutput]));
      if(fuel.next) return {...fuel.next,priority:145,project:'Refuel the pending furnace'};
    }
    return {id:`furnace:${JSON.stringify(job.position)}`,kind:'furnace-check',input:job.input?.name,
      target:job.output?.name??job.expectedOutput,position:job.position,priority:145,description:'Inspect the furnace and take verified output; cooking may still be in progress.'};
  }
  outcome(goal,action,result,before,after) {
    if(goal.kind!=='hunt') return;
    const gained=(goal.drops??[]).some(item=>count(after,item)>count(before,item));
    if(gained || result.hitObserved) {this.huntEpisodes.delete(goal.entityId);return;}
    const started=this.huntEpisodes.get(goal.entityId)??this.now();
    this.huntEpisodes.set(goal.entityId,started);
    if(this.now()-started<40000) return;
    this.huntEpisodes.delete(goal.entityId);this.huntBlocked.set(goal.entityId,this.now()+60000);
    return {replan:true,reason:`No hit or relevant drop during 40 seconds pursuing ${goal.target}; search for a different food source.`};
  }
  goals(o) {
    this.o=o; this.memo=new Map();
    if(this.life!==o.deaths) {this.life=o.deaths;this.woodReady=false;}
    this.resources=[...o.blocks.filter(b=>b.harvestable && b.drops?.length),...(o.knownResources||[])];
    const projects=[];
    const pending=(o.furnaces??[]).find(s=>s.distance<=16 && (s.input || s.output));
    if(pending && (o.food>=12 || this.registry.foodsByName?.[pending.expectedOutput] && o.food>=4)) return [this.furnaceGoal(pending)];
    const cookable=o.inventory.flatMap(i=>SMELTING.filter(r=>r.inputs.includes(i.name) &&
      (this.registry.foodsByName?.[r.output]?.foodPoints??0)>(this.registry.foodsByName?.[i.name]?.foodPoints??0)).map(r=>({recipe:r,count:i.count})));
    if(o.food>=14 && o.food<18 && cookable.length) {
      const p=this.plan(cookable[0].recipe.output,1);
      if(p.next && p.cost<=5) return [{...p.next,priority:150,project:'Cook food while hunger permits',description:`Cook held food for better nutrition: ${p.next.description}`}];
    }
    if(o.food<18 && o.inventory.some(i=>this.registry.foodsByName?.[i.name]))
      return [{id:'survive',kind:'survive',priority:150,description:'Eat available food now to restore hunger and allow health recovery before doing more work.'}];
    const loot=o.entities.filter(e=>e.name==='item' && e.item &&
      (this.registry.foodsByName?.[e.item] || /_(pickaxe|sword|axe|helmet|chestplate|leggings|boots)$/.test(e.item) && !count(o,e.item) ||
        (e.item.endsWith('_wool') && count(o,e.item)<3) || ['wheat','coal','raw_iron','bone','wheat_seeds','beetroot_seeds'].includes(e.item) && count(o,e.item)<16))
      .sort((a,b)=>a.distance-b.distance);
    if(loot.length) return [{id:`pickup:${loot[0].id}`,kind:'pickup',target:loot[0].item,entityId:loot[0].id,
      priority:150,description:`Collect the actually observed ${loot[0].item} instead of crafting or searching for a replacement.`}];
    const reserves=o.inventory.reduce((n,i)=>n+(this.registry.foodsByName?.[i.name]?.foodPoints||0)*i.count,0);
    if(o.farm?.ripe.length && reserves<16) {
      const b=o.farm.ripe[0],crop=CROPS.find(c=>c.block===b.name);
      return [{id:`harvest:${b.name}`,kind:'harvest-crop',target:crop.produce,position:b.position,priority:150,description:'Harvest the observed mature crop and collect its actual produce.'}];
    }
    for(const food of ['bread','mushroom_stew','beetroot_soup']) {
      if(count(o,food) || o.food>=18 && reserves>=8) continue;
      const p=this.plan(food,1);
      if(p.next && p.cost<=5) return [{...p.next,priority:148,project:`Prepare ${food}`,description:`Prepare food from available ingredients: ${p.next.description}`}];
    }
    if(o.food<16 || o.health<10 && o.food<18) {
      const animals=this.availableAnimals(o);
      if(animals.length) return animals.map(e=>this.hunt(e,`Obtain food from the observed ${e.name} to prevent starvation and recover health`,150));
      const edible=this.resources.find(b=>b.drops.some(item=>this.registry.foodsByName?.[item]));
      if(edible) return [{id:`gather:${edible.name}`,kind:'gather',target:edible.name,drops:edible.drops,description:'Collect the observed edible resource to recover before more work.'}];
      const field=o.farm?.remembered.find(s=>s.crop && s.distance<=24 && this.now()-s.observedAt>120000);
      if(field) return [{id:'station:crop',kind:'station',target:field.crop,position:field.position,priority:145,description:'Revisit the known food plot and check its actual crop maturity.'}];
      return [{id:'search:food',kind:'explore',target:'food',targets:Object.keys(ANIMALS),priority:150,description:'Search new surface territory for animals or edible plants before more work. Do not keep circling an exhausted area.'}];
    }
    const logs=o.inventory.filter(i=>/_(log|stem)$/.test(i.name)).reduce((n,i)=>n+i.count,0);
    const planks=o.inventory.filter(i=>i.name.endsWith('_planks')).reduce((n,i)=>n+i.count,0);
    this.woodReady ||= logs*4+planks>=16 || (logs*4+planks>=7 && count(o,'stick')>=2) || o.inventory.some(i=>i.name.endsWith('_pickaxe'));
    if(!this.woodReady) {
      const trees=this.resources.filter(b=>b.drops.some(item=>/_(log|stem)$/.test(item)))
        .sort((a,b)=>(a.diggable?0:10)+(a.distance||0)-(b.diggable?0:10)-(b.distance||0));
      if(trees[0]) return [{id:`gather:${trees[0].name}`,kind:'gather',target:trees[0].name,drops:trees[0].drops,
        desiredCount:4,description:`Collect starter wood first (${logs}/4 logs, ${planks} planks). Mine an observed reachable trunk and pick up its drops. Then use real recipes for tools and shelter.`}];
      return [{id:'explore',kind:'explore',description:'Find a reachable tree for starter wood. Avoid repeating blocked routes and do not collect unrelated dirt.'}];
    }
    const add=(item,quantity,reason,priority)=>{
      const p=this.plan(item,quantity);
      if(p.next && p.cost<100) projects.push({...p.next,priority,project:reason,
        description:`${reason}: ${p.next.description}`});
    };
    for(const option of cookable) add(option.recipe.output,Math.min(3,option.count),'Cook food to build a nutritious reserve',118);
    // These are desired capabilities, not a fixed execution sequence. Recipe/resource
    // availability and current equipment determine which prerequisites are attainable.
    for(const [family,priority] of [['pickaxe',95],['sword',90],['axe',80]]) {
      const owned=o.inventory.filter(i=>i.name.endsWith(`_${family}`));
      const best=Math.max(-1,...owned.map(i=>tier(i.name)));
      const candidates=this.registry.itemsArray.filter(i=>i.name.endsWith(`_${family}`) && tier(i.name)>best && !i.name.startsWith('golden'))
        .map(i=>({name:i.name,p:this.plan(i.name,1)})).filter(p=>p.p.next && p.p.cost<100)
        .sort((a,b)=>(a.p.cost/(tier(a.name)+2))-(b.p.cost/(tier(b.name)+2)));
      const needsFirstWeapon=family==='sword' && !owned.length && o.inventory.some(i=>i.name.endsWith('_pickaxe'));
      if(candidates.length) add(candidates[0].name,1,`Obtain or improve a ${family} for efficient survival and progression`,needsFirstWeapon?110:priority);
    }
    const equipment=o.equipment??{};
    for(const [slot,suffix] of [['head','helmet'],['torso','chestplate'],['legs','leggings'],['feet','boots'],['off-hand','shield']]) {
      const owned=o.inventory.filter(i=>suffix==='shield'?i.name==='shield':i.name.endsWith(`_${suffix}`)).sort((a,b)=>tier(b.name)-tier(a.name));
      const worn=equipment[slot];
      if(owned[0] && (!worn || suffix!=='shield' && tier(owned[0].name)>tier(worn)))
        projects.push({id:`wear:${owned[0].name}`,kind:'wear',target:owned[0].name,slot,priority:140,description:`Equip ${owned[0].name} in ${slot} for protection.`});
    }
    if(!count(o,'shield') && !equipment['off-hand']) add('shield',1,'Obtain a shield for blocking attacks',100);
    if(!equipment.torso && !o.inventory.some(i=>i.name.endsWith('_chestplate'))) add('iron_chestplate',1,'Obtain armor before more dangerous exploration',92);
    const homeNear=o.shelter?.anchor && Math.hypot(o.position.x-o.shelter.anchor.x,o.position.z-o.shelter.anchor.z)<8;
    if((o.light?.sky===0 && o.position.y<60 || homeNear && o.semantics?.daylight==='night') && !o.blocks.some(b=>b.name==='torch' || b.name==='wall_torch')) {
      if(count(o,'torch')) projects.push({id:'build:torch',kind:'build',target:'torch',priority:110,description:'Light the current work area with a torch.'});
      else add('torch',4,'Make lighting for a dark work area',105);
    }
    const beds=o.blocks.filter(b=>b.name.endsWith('_bed'));
    const ownedBed=o.inventory.some(i=>i.name.endsWith('_bed'));
    if(!beds.length && !ownedBed) {
      const choices=this.registry.itemsArray.filter(i=>i.name.endsWith('_bed')).map(i=>({name:i.name,p:this.plan(i.name,1)})).sort((a,b)=>a.p.cost-b.p.cost);
      if(choices[0]) add(choices[0].name,1,'Make a bed for a safe respawn point and sleeping through the night',85);
      if(!choices[0]?.p.next || choices[0].p.cost>=100)
        projects.push({id:'search:sheep',kind:'explore',target:'sheep',priority:65,project:'Find wool for a bed',description:'Search new surface terrain for sheep and wool. Stay above ground and avoid revisiting the same mining area.'});
    }
    if(ownedBed && !beds.length) {
      const item=o.inventory.find(i=>i.name.endsWith('_bed')).name;
      projects.push({id:`build:${item}`,kind:'build',target:item,priority:86,description:'Place your bed in a safe two-block space in the Overworld.'});
    }
    if(beds.length && o.semantics?.daylight==='night' && o.dimension.includes('overworld'))
      projects.push({id:'sleep',kind:'sleep',priority:120,description:'Use the nearby bed to sleep safely and set your respawn point.'});
    if(o.shelter?.available && o.shelter.observed!==false && !o.shelter.complete) {
      if(o.shelter.materialCount < Math.min(8,o.shelter.remaining)) {
        const materials=this.registry.itemsArray.filter(i=>i.name.endsWith('_planks') || i.name==='cobblestone')
          .map(i=>({name:i.name,p:this.plan(i.name,Math.min(8,o.shelter.remaining))})).sort((a,b)=>a.p.cost-b.p.cost);
        if(materials[0]) add(materials[0].name,Math.min(8,o.shelter.remaining),'Collect building supplies for a compact enclosed house',72);
      } else projects.push({id:'shelter',kind:'shelter',priority:78,description:'Build the remaining walls and roof at your surveyed house site. Keep the doorway clear.'});
      if(o.shelter.remaining===0 && !o.shelter.door) {
        const doors=this.registry.itemsArray.filter(i=>i.name.endsWith('_door') && i.name!=='iron_door')
          .map(i=>({name:i.name,p:this.plan(i.name,1)})).sort((a,b)=>a.p.cost-b.p.cost);
        if(doors[0]) {
          const homeDistance=Math.hypot(o.position.x-o.shelter.anchor.x,o.position.z-o.shelter.anchor.z);
          const doorPriority=homeDistance<=16 || o.inventory.some(i=>i.name.endsWith('_sword'))?125:85;
          if(count(o,doors[0].name)) projects.push({id:'shelter',kind:'shelter',priority:doorPriority,project:'Secure the house',description:'Fit a door to finish the enclosed house before starting another project.'});
          else add(doors[0].name,1,'Secure the house with a door',125);
        }
      }
    }
    const food=o.inventory.some(i=>this.registry.foodsByName?.[i.name]);
    if(food && o.food<19) projects.push({id:'survive',kind:'survive',priority:130,description:'Eat available food before continuing work.'});
    if(reserves<8) for(const e of this.availableAnimals(o))
      projects.push(this.hunt(e,`Stock food from the observed ${e.name} before hunger becomes an emergency`,o.food<18?135:105));
    if(o.food>=16) {
      const seed=CROPS.find(c=>count(o,c.item)>0);
      if(seed && o.farm?.empty.length) projects.push({id:`plant:${seed.item}`,kind:'plant',target:seed.item,position:o.farm.empty[0].position,priority:100,description:'Plant a held seed or crop in observed empty farmland for renewable food.'});
      else if(seed && o.farm?.tillable.length) {
        const hoe=o.inventory.find(i=>i.name.endsWith('_hoe'));
        if(hoe) projects.push({id:'till',kind:'till',target:hoe.name,position:o.farm.tillable[0].position,priority:95,description:'Till observed clear ground near water to start a renewable food plot.'});
        else add('wooden_hoe',1,'Prepare a hoe for the observed irrigated farm site',75);
      }
      const replant=o.farm?.needsReplant?.find(s=>count(o,s.seed)>0);
      if(replant && !o.farm.empty.length) projects.push({id:'station:farmland',kind:'station',target:'farmland',
        position:{...replant.position,y:replant.position.y-1},priority:100,description:'Inspect the harvested plot before replanting it.'});
      if(count(o,'bone_meal') && o.farm?.crops.some(b=>!o.farm.ripe.includes(b))) {
        const crop=o.farm.crops.find(b=>!o.farm.ripe.includes(b));
        projects.push({id:'fertilize',kind:'fertilize',target:'bone_meal',position:crop.position,priority:100,description:'Use held bone meal to grow an observed immature food crop.'});
      }
      else if(count(o,'bone') && o.farm?.crops.length) add('bone_meal',3,'Prepare fertilizer for the growing food plot',95);
    }
    // Infrastructure already owned should be placed rather than crafted repeatedly.
    for(const f of o.facilities||[]) if(f.owned && !f.nearby)
      projects.push({id:`build:${f.name}`,kind:'build',target:f.name,priority:120,description:`Place your ${f.name} to unlock its functions.`});
    const selected=new Map();
    for(const p of projects.sort((a,b)=>b.priority-a.priority)) {
      if(!selected.has(p.id)) selected.set(p.id,p);
      else if(p.project && !selected.get(p.id).project) selected.get(p.id).project=p.project;
    }
    const urgency=Math.max(0,...[...selected.values()].map(g=>g.priority));
    // Compare similarly urgent capabilities, rather than letting an easy house
    // task displace missing basic tools or a real food emergency.
    const goals=[...selected.values()].filter(g=>g.priority>=urgency-5).slice(0,12);
    if(!goals.length) {
      // If prerequisites are unknown, explore instead of farming arbitrary dirt.
      goals.push({id:'explore',kind:'explore',description:'Find useful exposed resources, animals, a safe house site, or a route to missing crafting ingredients.'});
    }
    return goals;
  }
  hunt(e,reason,priority=80) {
    return {id:`hunt:${e.id}`,kind:'hunt',entityId:e.id,target:e.name,drops:[...(ANIMALS[e.name]||[]),...(e.name==='sheep'?WOOL:[])],priority,description:reason};
  }
  plan(item,quantity,trail=new Set()) {
    const o=this.o, key=`${item}:${quantity}`;
    if(count(o,item)>=quantity) return {cost:0};
    if(trail.has(item) || trail.size>7) return {cost:1000};
    if(this.memo.has(key)) return this.memo.get(key);
    const path=new Set([...trail,item]);
    const known=this.resources.filter(b=>b.drops.includes(item)).sort((a,b)=>(a.distance||0)-(b.distance||0));
    let best={cost:1000};
    const pending=(o.furnaces??[]).find(s=>s.distance<=16 && (s.output?.name===item || s.expectedOutput===item && s.input));
    if(pending) return {cost:1,next:this.furnaceGoal(pending)};
    if(known.length) best={cost:2+Math.min(30,known[0].distance||0)/4+quantity-count(o,item),next:{
      id:`gather:${known[0].name}`,kind:'gather',target:known[0].name,drops:[item],desiredCount:quantity,
      description:`Collect ${Math.max(1,quantity-count(o,item))} more ${item} from observed ${known[0].name}; pick up the drops.`}};
    if(item.endsWith('_wool')) {
      const sheep=this.availableAnimals(o).find(e=>e.name==='sheep');
      if(sheep) best={cost:8,next:this.hunt(sheep,'Obtain wool from a visible sheep; verify the actual wool color and drops')};
    }
    const id=this.registry.itemsByName[item]?.id;
    for(const recipe of smeltingFor(item)) for(const input of recipe.inputs) {
      if(!this.registry.itemsByName[input]) continue;
      const material=this.plan(input,quantity-count(o,item),path);
      if(material.cost>=100) continue;
      const fuel=this.fuelPlan(path,input);
      if(fuel.cost>=100) continue;
      const station=this.station('furnace',path);
      const cost=2+material.cost+fuel.cost+station.cost;
      if(cost>=best.cost) continue;
      const next=material.next??fuel.next??station.next??{id:`smelt:${item}`,kind:'smelt',target:item,input,
        fuel:fuel.fuel,position:station.position,description:`Smelt ${input} into ${item} in the observed furnace, then verify its output.`};
      best={cost,next};
    }
    for(const raw of this.registry.recipes?.[id]||[]) {
      const ingredients=raw.ingredients||raw.inShape?.flat()||[];
      const needed=new Map(), batches=Math.ceil((quantity-count(o,item))/raw.result.count);
      for(const ingredient of ingredients) {
        const id=typeof ingredient==='number'?ingredient:ingredient?.id;
        if(id===null || id===undefined || id<0) continue;
        const name=this.registry.items[id]?.name;
        if(name) needed.set(name,(needed.get(name)||0)+(typeof ingredient==='object'?(ingredient.count||1):1)*batches);
      }
      if(!needed.size) continue;
      let cost=1,next;
      for(const [name,n]of needed) {const p=this.plan(name,n,path);cost+=p.cost;next ||= p.next;}
      // Gather missing inputs before returning to a crafting station. Requiring
      // the table first makes leaving it to mine immediately cancel the mining goal.
      if(next) {
        if(cost<best.cost) best={cost,next};
        continue;
      }
      const needsTable=(raw.inShape?.length>2 || raw.inShape?.some(row=>row.length>2) || raw.ingredients?.length>4);
      if(needsTable && !o.blocks.some(b=>b.name==='crafting_table' && b.distance<=4)) {
        if(count(o,'crafting_table')) {cost+=1;next={id:'build:crafting_table',kind:'build',target:'crafting_table',description:'Place your crafting table near safe ground.'};}
        else if((o.knownResources||[]).some(b=>b.name==='crafting_table' && b.distance<=8 && !b.routeBlocked)) {
          const table=o.knownResources.find(b=>b.name==='crafting_table' && b.distance<=8 && !b.routeBlocked);
          cost+=2+table.distance/4;
          next={id:'station:crafting_table',kind:'station',target:'crafting_table',position:table.position,description:'Return to the already observed crafting table instead of making a duplicate.'};
        }
        else {const p=this.plan('crafting_table',1,path);cost+=p.cost;next=p.next;}
      }
      if(!next) {
        if(!o.recipes.some(r=>r.name===item)) continue; // Recipe feasibility comes from the real client.
        next={id:`craft:${item}`,kind:'craft',target:item,description:`Craft ${item} from available ingredients.`};
      }
      if(cost<best.cost) best={cost,next};
    }
    this.memo.set(key,best); return best;
  }
}
