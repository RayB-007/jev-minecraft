import test from 'node:test';
import assert from 'node:assert/strict';
import { Jev, validateChoice } from '../src/jev.js';

const choice = { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.9, b: 0.1 } };
test('Jev uses the official endpoint, typed questions, and validates the response', async () => {
  let request;
  const model = new Jev({ apiKey: 'test-only', fetchImpl: async (url, opts) => {
    request = { url, ...opts, body: JSON.parse(opts.body) };
    return Response.json({ model: 'jev-test-fixture', answers: {
      action: choice, danger: { type: 'noul', noul: 0.1 }, replan: { type: 'noul', noul: 0.2 }
    } });
  } });
  const result = await model.decide({ health: 20 }, { id: 'explore' }, [{ id: 'a', description: 'Look' }, { id: 'b', description: 'Wait' }], {});
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.body.questions.action.type, 'choice');
  assert.equal(Object.keys(request.body.questions).length, 3);
  assert.equal(result.action.choice, 'a');
});

test('unlisted actions, malformed probabilities, and invalid confidence are rejected', () => {
  for (const bad of [{ ...choice, choice: 'shell' }, { ...choice, confidence: NaN },
    { ...choice, probabilities: { a: 1, b: 1 } }, { ...choice, probabilities: { a: 0.9, c: 0.1 } }])
    assert.throws(() => validateChoice(bad, ['a', 'b']));
});

test('rate limits have bounded retries and credentials never enter errors', async () => {
  let calls = 0;
  const model = new Jev({ apiKey: 'secret-must-not-appear', retries: 1,
    fetchImpl: async () => { calls++; return new Response('secret-must-not-appear', { status: 429 }); } });
  await assert.rejects(model.request({}, {}), { message: 'TypeSafe API HTTP 429' });
  assert.equal(calls, 2);
});

test('authentication failures are not retried and cancellation aborts requests', async () => {
  let calls = 0;
  const model = new Jev({ apiKey: 'test', fetchImpl: async (_, options) => {
    calls++; options.signal.throwIfAborted(); return new Response('', { status: 401 });
  } });
  await assert.rejects(model.request({}, {}), /401/); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(model.request({}, {}, controller.signal), { name: 'AbortError' });
});
