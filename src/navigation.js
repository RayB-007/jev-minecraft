import navigation from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';
const { GoalNear } = navigation.goals;
const vector = p => new Vec3(p.x,p.y,p.z);

// One destination, continuous local feedback. Model latency never interrupts a healthy route.
export async function travel(game, action, signal, { budgetMs = 8000, pollMs = 50, stuckMs = 1800 } = {}) {
  const bot=game.bot, start=bot.entity.position.clone();
  let target=vector(action.position);
  // Dropped items float and fall; their exact block is often not a valid foot
  // position. Get within pickup reach instead of demanding that airborne cell.
  const range=action.blockName?2:action.type==='collect'?1:action.type==='approach'?2:(action.range??1);
  let goal=new GoalNear(target.x,target.y,target.z,range);
  let pathStatus='pending', nodes=0, recovered=false, reached=false;
  let lastProgress=Date.now(), lastPosition=start.clone();
  const updated=r=>{pathStatus=r.status;nodes=r.path?.length??0;};
  const distanceBefore=start.distanceTo(target);
  bot.on('path_update',updated);
  game.setEmergency(false);
  bot.pathfinder.setGoal(goal);
  try {
    const deadline=Date.now()+budgetMs;
    while(Date.now()<deadline) {
      signal.throwIfAborted();
      if(!game.connected) throw new Error('Disconnected during travel');
      if(game.inDanger?.()) throw new Error('Travel interrupted by danger');
      const position=bot.entity.position;
      const entity=action.entityId && bot.entities?.[action.entityId];
      if(entity?.position && entity.position.distanceTo(target)>1 &&
        game.inView?.(entity.position.offset(0,0.5,0)) && game.visible?.(entity.position.offset(0,0.5,0))) {
        target=entity.position.clone();goal=new GoalNear(target.x,target.y,target.z,range);
        bot.pathfinder.setGoal(goal);
      }
      if(goal.isEnd(position.floored())) {reached=true;break;}
      if(position.distanceTo(lastPosition)>0.35) {lastPosition=position.clone();lastProgress=Date.now();}
      if(Date.now()-lastProgress>=stuckMs || pathStatus==='noPath' && nodes===0) {
        if(recovered) {pathStatus='noPath';break;}
        recovered=true;
        // A snow layer on a ledge can make the jump exceed the pathfinder's
        // step height. Clear only observed, reachable snow before recalculating.
        const feet=position.floored();
        for(let x=-1;x<=1;x++) for(let z=-1;z<=1;z++) for(let y=0;y<=2;y++) {
          const b=bot.blockAt?.(feet.offset(x,y,z));
          if(b?.name!=='snow' || !bot.canSeeBlock(b) || !bot.canDigBlock(b)) continue;
          signal.throwIfAborted();
          if(game.inDanger?.()) throw new Error('Snow clearance interrupted by danger');
          await bot.dig(b,true);
          signal.throwIfAborted();
        }
        game.recoveryUntil=Date.now()+15000;
        game.setEmergency(false);
        bot.pathfinder.setGoal(goal);
        pathStatus='recovering';lastProgress=Date.now();
      }
      game.navigationStatus={target:action.position,distance:+position.distanceTo(target).toFixed(1),recovered};
      await delay(pollMs,undefined,{signal});
    }
  } finally {
    bot.off('path_update',updated);
    // An emergency owns the controls after interrupting us.
    if(!game.inDanger?.()) bot.pathfinder.setGoal(null);
    game.navigationStatus=null;
  }
  const distanceAfter=bot.entity.position.distanceTo(target);
  if(!reached && (pathStatus==='noPath' || start.distanceTo(bot.entity.position)<0.3)) {
    game.blockedNavigation.set(JSON.stringify(action.position),Date.now()+60000);
    pathStatus='noPath';
  } else if(!reached) pathStatus='partial';
  else pathStatus='success';
  if(action.blockName && reached) {
    await bot.lookAt(target.offset(0.5,0.5,0.5),false);signal.throwIfAborted();
  }
  return {pathStatus,nodes,reached,distanceBefore,distanceAfter,recovered};
}
