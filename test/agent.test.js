import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agent.js';
import { Memory } from '../src/memory.js';
import { fixture } from '../src/benchmark.js';
import { contextOf } from '../src/state.js';

class Game {
  constructor() { this.state = fixture(); this.connected = true; this.executions = 0; this.bot = new EventEmitter(); this.bot.health = 20; }
  observe() { return structuredClone(this.state); }
  actions() { return [{ id: 'mine', type: 'dig', blockName: 'oak_log', position: { x: 1, y: 64, z: 0 }, description: 'Mine an oak log' }]; }
  async execute() { this.executions++; this.state.inventory = [{ name: 'oak_log', count: this.executions }]; return { ok: true, blockChanged: true }; }
  stop() { this.stopped = true; }
}

function model(game) {
  return {
    async chooseGoal(o, goals) { return { goal: goals.find(g => g.kind === 'gather'), usage: { input_tokens: 10 } }; },
    async decide(o) {
      // The next call must receive feedback from the previous execution.
      assert.equal(o.inventory[0]?.count ?? 0, game.executions);
      return { action: { probabilities: { mine: 1 }, confidence: 1 }, danger: { noul: 0 }, replan: { noul: 0 }, model: 'test-double' };
    }
  };
}

test('the whole loop observes after every action and records measured feedback', async () => {
  const memory = new Memory(), game = new Game();
  const agent = new Agent({ game, model: model(game), memory, world: 'test-world', logger: () => {} });
  const report = await agent.run({ steps: 3 });
  assert.equal(game.executions, 3);
  assert.equal(report.metrics.verifiedActions, 3);
  assert.equal(report.metrics.goalCompletions, 3);
  assert.equal(report.metrics.resourceGains.oak_log, 3);
  assert.equal(report.metrics.completionVerified, false);
  assert.equal(memory.runs()[0].status, 'completed-budget');
  assert.equal(memory.db.prepare('SELECT COUNT(*) AS n FROM experiences').get().n, 3);
  assert.equal(game.stopped, true);
  memory.close();
});

test('successful looking cannot keep an unproductive building goal alive indefinitely',async()=>{
 const memory=new Memory(),game=new Game();
 const blocked={id:'build:torch',kind:'build',target:'torch'};
 game.goals=()=>[blocked];
 game.actions=(o,g)=>[{id:'look',type:'look',yaw:o.yaw+1,description:'Inspect a support'}];
 game.execute=async()=>{game.state.yaw=(game.state.yaw??0)+1;return {ok:true};};
 game.state.yaw=0;
 const provider={async chooseGoal(o,goals){return {goal:goals[0],noModel:true};},async decide(){return {noModel:true,action:{probabilities:{look:1},confidence:1},danger:{noul:0}};}};
 const report=await new Agent({game,model:provider,memory,world:'stall-test',logger:()=>{}}).run({steps:10});
 assert.equal(report.metrics.stalledTasks,1);
 const records=memory.db.prepare('SELECT record FROM experiences ORDER BY id').all().map(r=>JSON.parse(r.record));
 assert.equal(records[8].goal.kind,'explore');
 assert.match(records[7].reflection.reason,/Eight actions/);
 memory.close();
});

test('a state change during inference invalidates the pending action', async () => {
  const memory = new Memory(), game = new Game(), provider = model(game);
  provider.decide = async () => { game.state.health--; return { action: { probabilities: { mine: 1 }, confidence: 1 }, danger: { noul: 0 }, replan: { noul: 0 } }; };
  const agent = new Agent({ game, model: provider, memory, world: 'test', logger: () => {} });
  await agent.run({ steps: 2 });
  assert.equal(game.executions, 0);
  memory.close();
});

test('model failure stops with no guessed gameplay and leaves an error receipt', async () => {
  const memory = new Memory(), game = new Game(), provider = model(game);
  provider.chooseGoal = async () => { throw new Error('provider unavailable'); };
  const agent = new Agent({ game, model: provider, memory, world: 'test', logger: () => {} });
  await assert.rejects(agent.run({ steps: 4 }), /Three consecutive/);
  assert.equal(game.executions, 0);
  assert.equal(memory.runs()[0].status, 'error');
  memory.close();
});

test('damage cancellation is not counted as a failed model service', async () => {
  const memory = new Memory(), game = new Game(), provider = model(game);
  let interrupted = 0;
  const choose = provider.chooseGoal;
  provider.chooseGoal = async (...args) => {
    if (interrupted++ < 3) {
      game.bot.health--; game.state.health = game.bot.health;
      game.bot.emit('health');
      args[3].throwIfAborted();
    }
    return choose(...args);
  };
  const report = await new Agent({ game, model: provider, memory, world: 'damage', logger: () => {} }).run({ steps: 5 });
  assert.equal(report.status, 'completed-budget');
  assert.equal(game.executions, 2);
  memory.close();
});

test('cancellation releases controls and never starts an action', async () => {
  const memory = new Memory(), game = new Game(), controller = new AbortController();
  controller.abort();
  const agent = new Agent({ game, model: model(game), memory, world: 'test', logger: () => {} });
  const result = await agent.run({ steps: 3, signal: controller.signal });
  assert.equal(result.status, 'stopped'); assert.equal(game.executions, 0); assert.equal(game.stopped, true);
  memory.close();
});

test('a repeated replan signal cannot discard every other action and leave the player idle', async () => {
  const memory = new Memory(), game = new Game(), provider = model(game), decide = provider.decide;
  provider.decide = async (...args) => ({ ...await decide(...args), replan: { noul: 1 } });
  const result = await new Agent({ game, model: provider, memory, world: 'test', logger: () => {} }).run({ steps: 4 });
  assert.equal(result.metrics.steps, 4);
  assert.equal(game.executions, 4);
  memory.close();
});

test('trained-policy evaluation records outcomes without updating policy or retrieving previous evaluation episodes', async () => {
  const memory = new Memory(), game = new Game();
  const agent = new Agent({ game, model: model(game), memory, world: 'held-out', learning: true, training: false, logger: () => {} });
  const report = await agent.run({ steps: 2 });
  assert.equal(report.metrics.steps, 2);
  assert.equal(memory.runs()[0].mode, 'evaluate');
  assert.deepEqual(memory.values(contextOf(fixture())), []);
  assert.equal(memory.recent(contextOf(fixture()), 6, true).length, 0);
  memory.close();
});
