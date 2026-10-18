import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, rankActions } from '../src/memory.js';
import { evaluate } from '../src/evaluation.js';
import { contextOf, strategyOf, goalsFor, goalDone } from '../src/state.js';
import { benchmark, fixture } from '../src/benchmark.js';

test('an unreachable route does not earn navigation success merely for moving partway',()=>{
  const before=fixture(),after={...fixture(),position:{x:2,y:64,z:0}};
  const outcome=evaluate(before,after,{type:'navigate'},{ok:true,pathStatus:'noPath'});
  assert.equal(outcome.success,false);assert.ok(outcome.reward<0);
});

test('experience survives restart and changes action selection against a bad prior', () => {
  const folder = mkdtempSync(join(tmpdir(), 'jev-memory-'));
  try {
    const path = join(folder, 'experience.sqlite');
    let memory = new Memory(path);
    const before = fixture(), run = memory.startRun('world', 'adaptive');
    const bad = { id: 'bad', type: 'dig', blockName: 'stone' }, good = { id: 'good', type: 'dig', blockName: 'oak_log' };
    for (let i = 0; i < 10; i++) {
      memory.record(run, before, { action: bad, result: { error: 'No tool' }, evaluation: { reward: -4, success: false } });
      memory.record(run, before, { action: good, result: { ok: true }, evaluation: { reward: 4, success: true } });
    }
    memory.close(); memory = new Memory(path);
    const stats = memory.values(contextOf(before));
    assert.equal(stats.find(s => s.strategy === strategyOf(bad)).n, 10);
    const prior = { bad: 0.7, good: 0.3 };
    assert.equal(rankActions([bad, good], prior, stats, { explore: false })[0].action.id, 'good');
    assert.equal(rankActions([bad, good], prior, stats, { learning: false })[0].action.id, 'bad');
    assert.equal(memory.recent(contextOf(before)).length, 6);
    memory.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('frozen runs retain evidence without updating learned values', () => {
  const m = new Memory(), o = fixture(), run = m.startRun('a', 'frozen');
  m.record(run, o, { action: { type: 'wait' }, result: {}, evaluation: { reward: 1, success: true } }, false);
  assert.deepEqual(m.values(contextOf(o)), []);
  assert.equal(m.recent(contextOf(o)).length, 1);
  m.close();
});

test('strategies generalize across coordinates but contexts distinguish tools and health', () => {
  assert.equal(strategyOf({ type: 'dig', blockName: 'oak_log', position: { x: 1 } }), strategyOf({ type: 'dig', blockName: 'oak_log', position: { x: 20 } }));
  assert.notEqual(contextOf(fixture(false)), contextOf(fixture(true)));
  assert.notEqual(contextOf(fixture()), contextOf({ ...fixture(), health: 3 }));
});

test('world memory is isolated by world and dimension and reports staleness', () => {
  const m = new Memory(), o = fixture();
  m.rememberWorld('alpha', o);
  assert.equal(m.landmarks('alpha', o).length, 1);
  assert.match(m.landmarks('alpha', o)[0].status, /past observation/);
  assert.equal(m.landmarks('beta', o).length, 0);
  assert.equal(m.landmarks('alpha', { ...o, dimension: 'the_nether' }).length, 0);
  m.forgetBlock('alpha', o.dimension, o.blocks[0].position);
  assert.equal(m.landmarks('alpha', o).length, 0);
  m.close();
});

test('success requires observed effect, not an API acknowledgement', () => {
  const before = fixture();
  assert.equal(evaluate(before, before, { type: 'craft', item: 'oak_planks' }, { ok: true }).success, false);
  assert.equal(evaluate(before, before, { type: 'dig' }, { ok: true }).success, false);
  assert.equal(evaluate(before, before, { type: 'attack' }, { ok: true }).success, false);
  const after = { ...before, inventory: [{ name: 'oak_planks', count: 4 }] };
  assert.equal(evaluate(before, after, { type: 'craft', item: 'oak_planks' }, { ok: true }).success, true);
});

test('walking is not productive work and approaching loot is not collecting it',()=>{
  const before=fixture(),after={...before,position:{x:5,y:64,z:0}};
  assert.equal(evaluate(before,after,{type:'navigate'},{ok:true}).productive,false);
  assert.equal(evaluate(before,after,{type:'collect',item:'oak_log'},{ok:true}).success,false);
});

test('death outweighs item gains and disqualifies action success', () => {
  const before = fixture(), after = { ...before, deaths: 1, health: 0, inventory: [{ name: 'diamond', count: 3 }] };
  const e = evaluate(before, after, { type: 'dig' }, { ok: true, blockChanged: true }, true);
  assert.equal(e.success, false); assert.ok(e.reward <= -15);
});

test('repeated resource pickup cannot farm first-acquisition reward', () => {
  const before = { ...fixture(), creditedItems: ['oak_log'] };
  const after = { ...before, inventory: [{ name: 'oak_log', count: 10 }] };
  assert.ok(evaluate(before, after, { type: 'wait' }, { ok: true }).reward < 0);
});

test('goal completion distinguishes a relevant drop from unrelated loot', () => {
  const o = fixture(), g = goalsFor(o).find(g => g.kind === 'gather');
  assert.equal(goalDone(g, o, { ...o, inventory: [{ name: 'rotten_flesh', count: 1 }] }), false);
  assert.equal(goalDone(g, o, { ...o, inventory: [{ name: 'oak_log', count: 1 }] }), true);
});

test('held-out synthetic evaluation demonstrates improvement across seeds without evaluation updates', () => {
  for (const seed of [1, 42, 123]) {
    const report = benchmark({ seed });
    assert.equal(report.evaluationLearning, false);
    assert.ok(report.adaptive.successRate > report.frozen.successRate + 0.2, JSON.stringify(report));
    assert.match(report.doesNotProve, /Minecraft/);
  }
});
