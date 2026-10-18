import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { travel } from '../src/navigation.js';

function environment() {
  const bot = new EventEmitter();
  bot.entity = {position: new Vec3(0,64,0)};
  const goals=[];
  bot.pathfinder = {setGoal(goal) {goals.push(goal);}};
  return {bot,goals,connected:true,setEmergency() {},blockedNavigation:new Map()};
}

test('navigation holds one route across a slow journey instead of restarting every second',async()=>{
  const game=environment();
  const movement=setInterval(()=>{game.bot.entity.position.x+=0.1;},50);
  try {
    const result=await travel(game,{position:{x:3,y:64,z:0},range:0},new AbortController().signal,{budgetMs:2200,pollMs:10});
    assert.equal(result.reached,true);
    assert.equal(game.goals.filter(Boolean).length,1);
    assert.ok(result.distanceAfter<1);
  } finally {clearInterval(movement);}
});

test('interrupted work releases its listener and preserves emergency control ownership',async()=>{
  const game=environment(),controller=new AbortController();
  const operation=travel(game,{position:{x:10,y:64,z:0}},controller.signal,{pollMs:5});
  game.inDanger=()=>true;controller.abort();
  await assert.rejects(operation);
  assert.equal(game.goals.includes(null),false);
  assert.equal(game.bot.listenerCount('path_update'),0);
});

test('an immobile route tries recovery once and then marks the destination blocked',async()=>{
  const game=environment();
  const result=await travel(game,{position:{x:10,y:64,z:0}},new AbortController().signal,{budgetMs:500,pollMs:5,stuckMs:20});
  assert.equal(result.pathStatus,'noPath');assert.equal(result.recovered,true);
  assert.equal(game.goals.filter(Boolean).length,2);
  assert.equal(game.blockedNavigation.size,1);
});

test('pursuit updates a moving target only while it is actually visible',async()=>{
 for(const visible of [true,false]) {
  const game=environment();game.bot.entities={1:{position:new Vec3(7,64,0)}};
  game.inView=()=>visible;game.visible=()=>visible;
  game.bot.pathfinder.setGoal=goal=>{game.goals.push(goal);if(goal) game.bot.entity.position=new Vec3(goal.x,goal.y,goal.z);};
  const result=await travel(game,{type:'approach',entityId:1,position:{x:4,y:64,z:0}},new AbortController().signal);
  assert.equal(result.reached,true);assert.equal(game.bot.entity.position.x,visible?7:4);
 }
});
