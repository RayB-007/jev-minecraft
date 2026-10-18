import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { Survival } from '../src/survival.js';
import { goalsFor } from '../src/state.js';
import { fixture } from '../src/benchmark.js';
import { setTimeout as delay } from 'node:timers/promises';

function environment() {
  const bot = new EventEmitter(), controls = {};
  Object.assign(bot, { health: 20, food: 20, oxygenLevel: 300,
    entity: { position: new Vec3(0, 64, 0) }, entities: {},
    clearControlStates() { for (const key of Object.keys(controls)) controls[key] = false; },
    setControlState(key, value) { controls[key] = value; },
    async lookAt() {}, attack() { bot.attacks = (bot.attacks ?? 0) + 1; } });
  const threat = { id: 7, name: 'husk', position: new Vec3(2, 64, 0), distance: 2 };
  bot.entities[7] = threat;
  const game = { bot, connected: true, ready: true, stop() { bot.clearControlStates(); },
    senseThreats: () => [threat], safeStep: direction => direction === 'west', safeJump: () => false };
  return { game, bot, controls };
}

test('nearby threats interrupt a slow decision and start retreat before inference completes', async () => {
  const { game, bot, controls } = environment(), decision = new AbortController();
  bot.entities[7].name = 'creeper';
  const survival = new Survival(game, { onInterrupt: () => decision.abort() });
  let modelCompleted = false;
  const modelWork = delay(200).then(() => { modelCompleted = true; });
  survival.start();
  await delay(10); bot.emit('physicsTick');
  assert.equal(decision.signal.aborted, true);
  assert.equal(modelCompleted, false);
  assert.equal(controls.forward, true);
  assert.equal(controls.sprint, true);
  survival.stop();
  assert.equal(bot.listenerCount('physicsTick'), 0);
  await modelWork;
});

test('cornered defense obeys melee cooldown and releases controls when the threat leaves', async () => {
  const { game, bot, controls } = environment();
  game.safeStep = () => false;
  let now = 1000;
  const survival = new Survival(game, { now: () => now });
  survival.tick(); await delay(0);
  survival.tick(); await delay(0);
  assert.equal(bot.attacks, 1);
  now += 700; survival.tick(); await delay(0);
  assert.equal(bot.attacks, 2);
  game.senseThreats = () => [];
  now += 2000;
  survival.tick();
  assert.equal(survival.active, false);
  assert.equal(Boolean(controls.forward), false);
});

test('an armed healthy player approaches a lone zombie rather than fleeing indefinitely',()=>{
  const {game,bot}=environment();
  bot.entities[7].position.x=5;
  bot.inventory={items:()=>[{name:'stone_sword',type:1}]};
  let approached=false;game.approachThreat=()=>{approached=true;};
  const survival=new Survival(game);survival.tick();
  assert.equal(approached,true);assert.match(game.survivalStatus.mode,/Fighting/);
});

test('a defensive retreat hit releases forward movement before turning to face the enemy',async()=>{
 const {game,bot,controls}=environment();
 let releaseLook;bot.lookAt=()=>new Promise(resolve=>{releaseLook=resolve;});
 const survival=new Survival(game);survival.tick();
 assert.equal(survival.retreatAttack,true);assert.equal(Boolean(controls.forward),false);
 survival.tick();assert.equal(Boolean(controls.forward),false);
 releaseLook();await delay(0);assert.equal(bot.attacks,1);
});

test('a shield is raised between melee attacks and released before the next swing',async()=>{
 const {game,bot}=environment();const sword={name:'stone_sword',type:1};
 bot.inventory={items:()=>[sword],slots:{45:{name:'shield'}}};bot.heldItem=sword;
 bot.activateItem=offHand=>{assert.equal(offHand,true);bot.usingHeldItem=true;};
 bot.deactivateItem=()=>{bot.usingHeldItem=false;};
 let now=1000;const survival=new Survival(game,{now:()=>now});
 survival.tick();await delay(0);assert.equal(bot.attacks,1);
 now+=100;survival.tick();assert.equal(bot.usingHeldItem,true);
 now+=700;survival.tick();await delay(0);assert.equal(bot.usingHeldItem,false);assert.equal(bot.attacks,2);
});

test('a healthy player is given progression and exploration goals instead of an impossible healing goal', () => {
  assert.equal(goalsFor(fixture()).some(g => g.kind === 'survive'), false);
  assert.equal(goalsFor({ ...fixture(), health: 5 }).some(g => g.kind === 'survive'), true);
  assert.equal(goalsFor(fixture()).some(g => g.kind === 'gather'), true);
});

test('water safety uses Mineflayer breath units: 20 is full air, 8 is urgent',()=>{
 const {game,bot,controls}=environment();game.senseThreats=()=>[];
 bot.entity.isInWater=true;bot.oxygenLevel=20;
 const survival=new Survival(game);survival.tick();assert.equal(survival.active,false);
 bot.oxygenLevel=8;survival.tick();assert.equal(survival.active,true);
 assert.equal(controls.jump,true);
});

test('retreat continues until a safe separation instead of oscillating at the activation radius', () => {
  const { game } = environment();
  let now=1000;
  const survival = new Survival(game,{now:()=>now});
  survival.tick();
  game.bot.entity.position.x=-4;
  survival.tick();
  assert.equal(survival.active, true);
  assert.equal(survival.responses, 1);
  game.bot.entity.position.x=-8;
  now+=1300;
  survival.tick();
  assert.equal(survival.active, false);
});
