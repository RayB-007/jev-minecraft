import test from 'node:test';
import assert from 'node:assert/strict';
import registry from 'prismarine-registry';
import { Planner } from '../src/planner.js';
import { fixture } from '../src/benchmark.js';
const r=registry('1.21.1');
function state(overrides={}) {return {...fixture(),blocks:[
{name:'spruce_log',position:{x:2,y:64,z:0},distance:2,diggable:true,harvestable:true,drops:['spruce_log']},
{name:'grass_block',position:{x:1,y:63,z:0},distance:1,diggable:true,harvestable:true,drops:['dirt']}
],knownResources:[],entities:[],recipes:[],shelter:{available:false},...overrides};}

test('recipe prerequisites favor useful observed materials rather than arbitrary dirt gathering',()=>{
 const goals=new Planner(r).goals(state());
 assert.ok(goals.some(g=>g.id==='gather:spruce_log'));
 assert.equal(goals.some(g=>g.id==='gather:grass_block'),false);
 assert.equal(goals.length,1);
 assert.equal(goals[0].desiredCount,4);
});
test('collected starter wood enables a real planks recipe instead of unnecessary exploration',()=>{
 const goals=new Planner(r).goals(state({inventory:[{name:'spruce_log',count:4}],recipes:[{name:'spruce_planks',count:4}]}));
 assert.ok(goals.some(g=>g.id==='craft:spruce_planks'));
});
test('crafting prerequisites place an owned table instead of repeatedly making it',()=>{
 const goals=new Planner(r).goals(state({inventory:[{name:'wooden_pickaxe',count:1},{name:'crafting_table',count:1},{name:'spruce_planks',count:3}],recipes:[{name:'stick',count:4}],facilities:[{name:'crafting_table',owned:1,nearby:false}]}));
 assert.ok(goals.some(g=>g.id==='build:crafting_table'));
 assert.equal(goals.some(g=>g.id==='craft:crafting_table'),false);
});
test('bed planning uses actual wool color and a feasible recipe',()=>{
 const goals=new Planner(r).goals(state({inventory:[{name:'wooden_pickaxe',count:1},{name:'blue_wool',count:3},{name:'spruce_planks',count:3}],
 blocks:[{name:'crafting_table',position:{x:1,y:64,z:0},distance:1,drops:['crafting_table']}],recipes:[{name:'blue_bed',count:1}]}));
 assert.ok(goals.some(g=>g.id==='craft:blue_bed'));
 assert.equal(goals.some(g=>g.id==='craft:white_bed'),false);
});
test('missing resources lead to exploration rather than imagined mining targets',()=>{
 const goals=new Planner(r).goals(state({blocks:[]}));
 assert.deepEqual(goals.map(g=>g.kind),['explore']);
});
test('available food takes precedence over work while hungry',()=>{
 const goals=new Planner(r).goals(state({health:3,food:12,inventory:[{name:'rotten_flesh',count:1}]}));
 assert.deepEqual(goals.map(g=>g.kind),['survive']);
});

test('lack of food triggers a search before starvation rather than another tool project',()=>{
 const goals=new Planner(r).goals(state({food:15,inventory:[{name:'stone_pickaxe',count:1}]}));
 assert.equal(goals.length,1);assert.equal(goals[0].id,'search:food');
});

test('visible dropped equipment is recovered instead of restarting the wood and tool sequence',()=>{
 const goals=new Planner(r).goals(state({inventory:[],entities:[{id:42,name:'item',item:'stone_pickaxe',distance:6}]}));
 assert.equal(goals[0].kind,'pickup');assert.equal(goals[0].target,'stone_pickaxe');
});

test('a pursuit without hits or food eventually replans instead of chasing the same animal forever',()=>{
 let now=1000;const p=new Planner(r,{now:()=>now});
 const o=state({food:12,entities:[{id:42,name:'rabbit',distance:15}],inventory:[]});
 const goal=p.goals(o)[0];assert.equal(goal.kind,'hunt');
 assert.equal(p.outcome(goal,{type:'approach'},{ok:true},o,o),undefined);
 now+=41000;assert.equal(p.outcome(goal,{type:'approach'},{ok:true},o,o).replan,true);
 assert.equal(p.goals(o)[0].id,'search:food');
 now+=61000;assert.equal(p.goals(o)[0].kind,'hunt');
});

test('missing stone is gathered before revisiting the crafting table for an upgrade',()=>{
 const o=state({inventory:[{name:'wooden_pickaxe',count:1},{name:'stick',count:4}],
 blocks:[{name:'stone',position:{x:4,y:63,z:0},distance:4,diggable:true,harvestable:true,drops:['cobblestone']}],
 knownResources:[{name:'crafting_table',position:{x:12,y:64,z:0},distance:12,drops:['crafting_table']}]});
 const planner=new Planner(r);planner.goals(o);
 const upgrade=planner.plan('stone_pickaxe',1);
 assert.equal(upgrade.next.kind,'gather');assert.equal(upgrade.next.target,'stone');
});

test('a distant or blocked table does not prevent crafting a local workbench',()=>{
 for(const table of [{distance:25},{distance:5,routeBlocked:true}]) {
  const o=state({inventory:[{name:'spruce_planks',count:16},{name:'stick',count:4}],
   knownResources:[{name:'crafting_table',position:{x:25,y:64,z:0},drops:['crafting_table'],...table}],
   recipes:[{name:'crafting_table',count:1}]});
  const goals=new Planner(r).goals(o);
  assert.ok(goals.some(g=>g.id==='craft:crafting_table'));
  assert.equal(goals.some(g=>g.kind==='station'),false);
 }
});
