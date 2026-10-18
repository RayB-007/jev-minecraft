import { Memory, rankActions } from './memory.js';
import { contextOf } from './state.js';
import { evaluate } from './evaluation.js';

export function random(seed) {
  let n = seed >>> 0;
  return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
}

export function fixture(hasTool = false) {
  return { at: 0, dimension: 'overworld', health: 20, food: 20, deaths: 0,
    position: { x: 0, y: 64, z: 0 }, yaw: 0, heldItem: hasTool ? 'wooden_pickaxe' : null,
    inventory: hasTool ? [{ name: 'wooden_pickaxe', count: 1 }] : [], creditedItems: [],
    blocks: [{ name: 'oak_log', diggable: true, drops: ['oak_log'], position: { x: 1, y: 64, z: 0 } }],
    entities: [], recipes: [], safeDirections: ['north'] };
}

const actions = [
  { id: 'stone', type: 'dig', blockName: 'stone', description: 'Try mining stone' },
  { id: 'wood', type: 'dig', blockName: 'oak_log', description: 'Try mining wood' }
];
const prior = { stone: 0.6, wood: 0.4 };

function transition(before, action, rng) {
  const hasTool = before.inventory.some(i => i.name.endsWith('_pickaxe'));
  // A tiny controlled test environment, deliberately NOT a Minecraft emulator.
  const appropriate = action.id === (hasTool ? 'stone' : 'wood');
  const succeeds = rng() < (appropriate ? 0.92 : 0.08);
  const after = structuredClone(before);
  if (succeeds) after.inventory.push({ name: action.id === 'stone' ? 'cobblestone' : 'oak_log', count: 1 });
  const result = { ok: succeeds, blockChanged: succeeds };
  return { after, result, evaluation: evaluate(before, after, action, result) };
}

export function benchmark({ trainEpisodes = 300, testEpisodes = 200, seed = 42 } = {}) {
  const memory = new Memory();
  const run = memory.startRun('synthetic-training', 'adaptive');
  const trainRng = random(seed);
  for (let i = 0; i < trainEpisodes; i++) {
    const before = fixture(i % 2 === 0);
    const ranked = rankActions(actions, prior, memory.values(contextOf(before)));
    // Explicit exploration during training, disabled during held-out evaluation.
    const action = trainRng() < 0.2 ? actions[Math.floor(trainRng() * actions.length)] : ranked[0].action;
    const outcome = transition(before, action, trainRng);
    memory.record(run, before, { action, ...outcome });
  }
  const results = { frozen: [], adaptive: [] };
  for (const mode of Object.keys(results)) {
    const testRng = random(seed + 10000);
    for (let i = 0; i < testEpisodes; i++) {
      const before = fixture(i % 2 === 0), learning = mode === 'adaptive';
      const action = rankActions(actions, prior, learning ? memory.values(contextOf(before)) : [], { learning, explore: false })[0].action;
      results[mode].push(transition(before, action, testRng).evaluation);
    }
  }
  const summarize = xs => ({ successRate: xs.filter(x => x.success).length / xs.length,
    meanReward: xs.reduce((n, x) => n + x.reward, 0) / xs.length });
  const report = { environment: 'synthetic-contextual-resource-choice', decisionProvider: 'fixed-test-prior; no Jev API call',
    proves: 'Outcome learning changes choices across repeated contexts.',
    doesNotProve: 'Minecraft gameplay, Jev performance, long-horizon skill acquisition, or dragon completion.',
    seed, trainEpisodes, testEpisodes, evaluationLearning: false,
    frozen: summarize(results.frozen), adaptive: summarize(results.adaptive) };
  memory.close();
  return report;
}
