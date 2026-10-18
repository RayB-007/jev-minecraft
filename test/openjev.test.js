import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenJev, localEndpoint } from '../src/openjev.js';
import { Agent } from '../src/agent.js';
import { Memory } from '../src/memory.js';
import { fixture } from '../src/benchmark.js';

test('local decisions send no credentials and use no hosted fallback', async () => {
  let calls = 0;
  const model = new OpenJev({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:8767/v1/systemone');
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ provider: 'openjev-local', calibrated: false, model: 'local-test', usage: {},
      answers: { goal: { type: 'choice', choice: 'gather', confidence: 0.01, calibrated: false,
        probabilities: { gather: 0.55, explore: 0.45 } } } });
  } });
  const result = await model.chooseGoal({}, [{ id: 'gather', description: 'Gather wood' }, { id: 'explore', description: 'Explore' }], {});
  assert.equal(result.goal.id, 'gather'); assert.equal(calls, 1);
});

test('the local transport refuses remote servers and never falls back after failure', async () => {
  for (const address of ['https://api.typesafe.ai', 'http://example.com', 'http://user:pass@127.0.0.1:8767'])
    assert.throws(() => localEndpoint(address), /loopback/);
  let calls = 0;
  const model = new OpenJev({ fetchImpl: async () => { calls++; throw new Error('local process down'); } });
  await assert.rejects(model.request({}, {}), /local process down/);
  assert.equal(calls, 1);
});

test('uncalibrated local score concentration does not trigger the hosted low-confidence look loop', async () => {
  let turns = 0;
  const state = fixture(), memory = new Memory();
  const game = { connected: true, observe: () => structuredClone(state), stop() {},
    actions: () => [{ id: 'mine', type: 'dig', position: { x: 1, y: 64, z: 0 }, blockName: 'oak_log', description: 'Mine' },
      { id: 'look', type: 'look', description: 'Look' }],
    async execute(action) { if (action.type === 'look') turns++; return { ok: true, blockChanged: true }; } };
  const model = { async chooseGoal(_, goals) { return { goal: goals[0] }; }, async decide() {
    return { action: { probabilities: { mine: 0.55, look: 0.45 }, confidence: 0.01, calibrated: false },
      danger: { noul: 0 }, replan: { noul: 0 }, model: 'local-test' };
  } };
  await new Agent({ game, model, memory, world: 'test', logger: () => {} }).run({ steps: 1 });
  assert.equal(turns, 0);
  memory.close();
});
