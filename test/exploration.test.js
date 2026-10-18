import test from 'node:test';
import assert from 'node:assert/strict';
import {Exploration} from '../src/exploration.js';
import {Memory} from '../src/memory.js';

const observation=p=>({position:p,dimension:'overworld',yaw:0,frontiers:[],safeDirections:[],jumpDirections:[]});

test('search crosses new territory instead of repeating the same patch for 100 destinations',()=>{
 const search=new Exploration();let p={x:0,y:64,z:0},now=1000;
 search.now=()=>now;
 for(let n=0;n<100;n++) {
  const o=observation(p);
  o.frontiers=[[0,-7],[0,7],[7,0],[-7,0]].map(([x,z])=>({position:{x:p.x+x,y:64,z:p.z+z},surface:'grass_block'}));
  let action=search.actions(o)[0];
  while(action.type==='look') {search.outcome(action,{ok:true});o.yaw=action.yaw;action=search.actions(o)[0];}
  assert.equal(action.type,'navigate');
  p={...action.position};search.visit(p,'overworld');search.outcome(action,{ok:true,reached:true});now+=1000;
 }
 assert.ok(search.stats().maxDisplacement>300,JSON.stringify(search.stats()));
 assert.ok(search.stats().newGroundCells>=90);
});

test('visited terrain survives an explorer restart and remains world and dimension specific',()=>{
 const memory=new Memory(),a=new Exploration();a.attach(memory,'alpha');
 a.visit({x:0,y:64,z:0},'overworld');a.visit({x:8,y:64,z:0},'overworld');
 const b=new Exploration();b.attach(memory,'alpha');b.visit({x:0,y:64,z:0},'overworld');
 assert.equal(b.cells.get('2,0').visits,1);
 assert.equal(memory.explorationCells('beta','overworld').length,0);
 assert.equal(memory.explorationCells('alpha','the_nether').length,0);memory.close();
});

test('failed waypoints are avoided and survey turns only advance after an observed execution',()=>{
 const s=new Exploration(),o=observation({x:0,y:64,z:0});
 const a=s.actions(o)[0];s.actions(o);assert.equal(s.scansRemaining,4);
 s.outcome(a,{ok:false});assert.equal(s.scansRemaining,4);
 s.scansRemaining=0;o.frontiers=[{position:{x:7,y:64,z:0}},{position:{x:-7,y:64,z:0}}];
 const first=s.actions(o)[0];s.outcome(first,{ok:true,pathStatus:'noPath'});
 const second=s.actions(o)[0];assert.notDeepEqual(second.position,first.position);
});

test('actual harm is remembered across restarts, lowers route utility and decays over time',()=>{
 const memory=new Memory();let now=1000;
 const a=new Exploration({now:()=>now});a.attach(memory,'world');a.visit({x:0,y:64,z:0});
 a.harm({x:8,y:64,z:0},20);
 const b=new Exploration({now:()=>now});b.attach(memory,'world');b.visit({x:0,y:64,z:0});
 assert.equal(b.risk({x:8,y:64,z:0}),20);
 const o=observation({x:0,y:64,z:0});
 assert.ok(b.score({position:{x:-8,y:64,z:0}},o)>b.score({position:{x:8,y:64,z:0}},o));
 now+=900000;assert.ok(b.risk({x:8,y:64,z:0})<1);
 memory.close();
});

test('an exhausted corridor continues toward its travel bearing instead of ping-ponging between endpoints',()=>{
 const s=new Exploration(),o=observation({x:0,y:64,z:0});
 s.visit(o.position);s.visit({x:-8,y:64,z:0});s.visit(o.position);
 s.scansRemaining=0;s.heading={x:1,z:0};o.yaw=-Math.PI/2;
 o.frontiers=[{position:{x:-8,y:64,z:0}}];o.safeDirections=['east','west'];
 const a=s.actions(o)[0];assert.equal(a.type,'move');assert.equal(a.direction,'east');
});

test('an acknowledged but immobile step is cooled down so search tries a different direction',()=>{
 const s=new Exploration(),o=observation({x:0,y:64,z:0});s.visit(o.position);
 s.scansRemaining=0;s.heading={x:1,z:0};o.yaw=-Math.PI/2;o.safeDirections=['east','north'];
 const first=s.actions(o)[0];assert.equal(first.direction,'east');
 s.outcome(first,{ok:true,distanceMoved:0});
 const second=s.actions(o)[0];assert.equal(second.direction,'north');
});

test('a food search follows ground rather than treating a tree crown as unexplored terrain',()=>{
 const s=new Exploration(),o=observation({x:0,y:64,z:0});s.visit(o.position);s.scansRemaining=0;
 o.frontiers=[{position:{x:8,y:66,z:0},surface:'spruce_leaves'},{position:{x:6,y:64,z:0},surface:'grass_block'}];
 assert.deepEqual(s.actions(o)[0].position,{x:6,y:64,z:0});
});
