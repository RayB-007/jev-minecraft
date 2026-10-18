import test from 'node:test';
import assert from 'node:assert/strict';
import registry from 'prismarine-registry';
import {EventEmitter} from 'node:events';
import {Vec3} from 'vec3';
import {Planner} from '../src/planner.js';
import {SMELTING,FurnaceSkill,furnaceFuel} from '../src/furnace.js';
import {FarmingSkill} from '../src/farming.js';
import {Memory} from '../src/memory.js';
import {Agent} from '../src/agent.js';
import {evaluate} from '../src/evaluation.js';
import {fixture} from '../src/benchmark.js';
const r=registry('1.21.1');
const furnace={name:'furnace',distance:2,position:{x:2,y:64,z:0},harvestable:true,drops:['furnace']};
const state=extra=>({...fixture(),blocks:[furnace],knownResources:[],entities:[],recipes:[],shelter:{available:false},furnaces:[],...extra});

test('smelting knowledge comes from vanilla recipes, including wood tags and raw metals',()=>{
 assert.ok(SMELTING.some(s=>s.output==='iron_ingot' && s.inputs.includes('raw_iron')));
 assert.ok(SMELTING.some(s=>s.output==='charcoal' && s.inputs.includes('birch_log')));
 assert.equal(SMELTING.some(s=>s.output==='charcoal' && s.inputs.includes('crimson_stem')),false);
});
test('fuel selection preserves the sole smelting input and favors planks over whole logs',()=>{
 assert.equal(furnaceFuel([{name:'oak_log',count:1}],'oak_log'),undefined);
 assert.equal(furnaceFuel([{name:'oak_log',count:2}],'oak_log'),'oak_log');
 assert.equal(furnaceFuel([{name:'oak_log',count:1},{name:'oak_planks',count:1}]),'oak_planks');
 assert.equal(furnaceFuel([{name:'crimson_planks',count:64},{name:'warped_planks',count:64}]),undefined);
});
test('iron progression uses an observed furnace and held raw iron rather than inventing an ingot',()=>{
 const p=new Planner(r);p.goals(state({inventory:[{name:'stone_pickaxe',count:1},{name:'raw_iron',count:1},{name:'coal',count:1}]}));
 const plan=p.plan('iron_ingot',1);assert.equal(plan.next.kind,'smelt');assert.equal(plan.next.input,'raw_iron');
 assert.equal(plan.next.fuel,'coal');assert.deepEqual(plan.next.position,furnace.position);
});
test('a missing furnace is crafted from real available prerequisites before smelting',()=>{
 const p=new Planner(r);p.goals(state({blocks:[{name:'crafting_table',distance:1,position:{x:1,y:64,z:0}}],
 inventory:[{name:'stone_pickaxe',count:1},{name:'raw_iron',count:1},{name:'coal',count:1},{name:'cobblestone',count:8}],recipes:[{name:'furnace',count:1}]}));
 const plan=p.plan('iron_ingot',1);assert.equal(plan.next.kind,'craft');assert.equal(plan.next.target,'furnace');
});
test('cooking is preferred when a stove is available, but starvation still eats raw food immediately',()=>{
 for(const hunger of [16,6]) {
  const goals=new Planner(r).goals(state({food:hunger,inventory:[{name:'beef',count:1},{name:'coal',count:1}]}));
  assert.equal(goals[0].kind,hunger===16?'smelt':'survive');
 }
});
test('pending furnace contents survive memory retrieval and are checked before acquiring duplicate inputs',()=>{
 const memory=new Memory(),job={position:furnace.position,input:{name:'raw_iron',count:1},expectedOutput:'iron_ingot',fuelSeconds:40};
 memory.rememberStation('alpha','overworld',job);
 assert.equal(memory.stations('beta','overworld').length,0);
 assert.equal(memory.stations('alpha','the_nether').length,0);
 const goals=new Planner(r).goals(state({inventory:[],furnaces:memory.stations('alpha','overworld').map(s=>({...s,distance:2}))}));
 assert.equal(goals[0].kind,'furnace-check');assert.equal(goals[0].target,'iron_ingot');memory.close();
});
test('cooking checks require actual inventory output and pending work receives no imaginary success',()=>{
 const before=state({inventory:[]}),action={type:'furnace-check',output:'iron_ingot'};
 const waiting=evaluate(before,before,action,{ok:true,processing:true});assert.equal(waiting.pending,true);assert.equal(waiting.success,false);assert.equal(waiting.productive,false);
 assert.equal(evaluate(before,before,action,{ok:true,outputTaken:'iron_ingot'}).success,false);
 const after={...before,inventory:[{name:'iron_ingot',count:1}]};
 assert.equal(evaluate(before,after,action,{ok:true,outputTaken:'iron_ingot'}).productive,true);
});

test('a crafted output does not reward losing unrelated ingredients',()=>{
 const before=state({inventory:[{name:'oak_log',count:8}]}),after=state({inventory:[{name:'oak_planks',count:4}]});
 const e=evaluate(before,after,{type:'craft',item:'oak_planks'},{ok:true,inventoryConserved:false});
 assert.equal(e.success,false);assert.equal(e.productive,false);assert.ok(e.reward<0);
});
test('waiting for server-side cooking does not teach the learner that the skill failed',async()=>{
 const memory=new Memory();let n=0;
 const game={connected:true,bot:new EventEmitter(),observe:()=>state({inventory:n>=4?[{name:'iron_ingot',count:1}]:[]}),stop(){},
 goals:()=>[{id:'check',kind:'furnace-check',target:'iron_ingot'}],
 actions:()=>[{id:'a0',type:'furnace-check',output:'iron_ingot',description:'Inspect the actual output'}],
 async execute(){n++;return n<4?{ok:true,processing:true}:{ok:true,outputTaken:'iron_ingot'};}};
 const model={async chooseGoal(o,goals){return {goal:goals[0],noModel:true};},async decide(){return {action:{probabilities:{a0:1},confidence:1},danger:{noul:0},noModel:true};}};
 const result=await new Agent({game,model,memory,world:'fixture',logger:()=>{}}).run({steps:4});
 assert.equal(result.metrics.processingChecks,3);assert.equal(result.metrics.failures,0);assert.equal(result.metrics.progressActions,1);
 assert.equal(memory.db.prepare('SELECT sum(n) AS n FROM values_v1').get().n,1);memory.close();
});
test('equipment is selected for a real equipment slot and must be observed there to earn credit',()=>{
 const before=state({inventory:[{name:'stone_pickaxe',count:1},{name:'shield',count:1}],equipment:{'off-hand':null}});
 const goal=new Planner(r).goals(before)[0];assert.equal(goal.kind,'wear');assert.equal(goal.slot,'off-hand');
 const action={type:'wear',item:'shield',slot:'off-hand'};
 assert.equal(evaluate(before,before,action,{ok:true}).success,false);
 assert.equal(evaluate(before,{...before,equipment:{'off-hand':'shield'}},action,{ok:true}).success,true);
});
test('farming refuses to harvest an immature crop',async()=>{
 const bot={registry:r,entity:{position:new Vec3(0,64,0)},blockAt:p=>({name:'carrots',position:p,getProperties:()=>({age:3})}),canSeeBlock:()=>true};
 const farming=new FarmingSkill({bot});
 await assert.rejects(farming.perform({type:'harvest-crop',position:{x:1,y:64,z:0}},new AbortController().signal),/mature/);
});
test('the food planner harvests mature crops before wandering to find an animal',()=>{
 const b={name:'carrots',position:{x:1,y:64,z:0},age:7};
 const goal=new Planner(r).goals(state({food:12,inventory:[],farm:{ripe:[b]}}))[0];
 assert.equal(goal.kind,'harvest-crop');assert.equal(goal.target,'carrot');
});
test('an undefined unloaded path node has no invented danger score and cannot crash navigation',async()=>{
 const {Exploration}=await import('../src/exploration.js');assert.equal(new Exploration().risk(undefined),0);
});
