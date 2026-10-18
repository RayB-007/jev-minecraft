import { Jev, validateChoice } from './jev.js';
import { GAMEPLAY_KNOWLEDGE } from './knowledge.js';

export function compactState(state) {
  const o = state.observation || {};
  return { objective: state.objective, goal: state.currentGoal, gameplayKnowledge: GAMEPLAY_KNOWLEDGE,
    player: { health: o.health, hunger: o.food, condition: o.semantics, dimension: o.dimension,
      inventory: o.inventory, holding: o.heldItem,equipment:o.equipment },
    workstations:(o.furnaces??[]).slice(0,2),farm:o.farm?{ripe:o.farm.ripe.length,growing:o.farm.crops.length,empty:o.farm.empty.length}:undefined,
    surroundings: [...new Set((o.blocks || []).map(b => b.name))],
    enemies: (o.entities || []).filter(e => e.kind === 'hostile').map(e => ({ name: e.name, distance: e.distance })),
    experience: (state.experience?.recent || []).slice(-3).map(e => ({ action: e.action?.description,
      success: e.evaluation?.success, reward: e.evaluation?.reward })) };
}

export function localEndpoint(value = process.env.OPENJEV_URL || 'http://127.0.0.1:8767') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('OpenJev must use an unauthenticated loopback HTTP endpoint');
  return url.origin;
}

export class OpenJev extends Jev {
  constructor({ url, fetchImpl = fetch, timeoutMs = 45000 } = {}) {
    const endpoint = localEndpoint(url);
    super({ apiKey: null, requestImpl: async (state, questions, signal) => {
      const response = await fetchImpl(`${endpoint}/v1/systemone`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Criteria already describe the actions. Avoid encoding the same menu twice.
        body: JSON.stringify({ state: compactState(state), questions }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
      if (!response.ok) throw new Error(`Local OpenJev HTTP ${response.status}; inspect data/openjev.log`);
      const result = await response.json();
      if (result.provider !== 'openjev-local' || result.calibrated !== false || !result.answers)
        throw new Error('Invalid local OpenJev response');
      return result;
    } });
    this.endpoint = endpoint;
  }
  async decide(observation, goal, actions, memory, signal) {
    if (actions.length === 1) return super.decide(observation, goal, actions, memory, signal);
    const response = await this.request({ observation, currentGoal: goal, experience: memory }, {
      action: { type: 'choice', instructions: `Which action makes observable progress toward ${goal.description || goal.id}?`,
        criteria: Object.fromEntries(actions.map(a => [a.id, a.description])) }
    }, signal);
    const action = validateChoice(response.answers.action, actions.map(a => a.id));
    return { action, danger: { noul: Number(observation.entities?.some(e => e.kind === 'hostile' && e.distance < 6)) || 0 },
      replan: { noul: 0, calibrated: false }, model: response.model, usage: response.usage };
  }
}

export function providerName() {
  const provider = process.env.JEV_PROVIDER || 'openjev';
  if (!['openjev', 'typesafe'].includes(provider)) throw new Error('JEV_PROVIDER must be openjev or typesafe');
  return provider;
}

export function createModel() { return providerName() === 'openjev' ? new OpenJev() : new Jev(); }
