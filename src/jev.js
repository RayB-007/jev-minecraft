import { setTimeout as delay } from 'node:timers/promises';
import { GOAL } from './state.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const unit = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

export function validateChoice(answer, ids) {
  if (answer?.type !== 'choice' || !ids.includes(answer.choice) || !unit(answer.confidence)) throw new Error('Invalid Jev choice');
  const probs = answer.probabilities;
  if (!probs || Object.keys(probs).length !== ids.length || ids.some(id => !unit(probs[id]))) throw new Error('Invalid Jev probability distribution');
  if (Math.abs(Object.values(probs).reduce((a, b) => a + b, 0) - 1) > 0.02) throw new Error('Jev probabilities must sum to one');
  return answer;
}

export class Jev {
  constructor({ apiKey = process.env.TYPESAFE_API_KEY, model = process.env.JEV_MODEL || 'jev-latest',
    fetchImpl = fetch, timeoutMs = 8000, retries = 1, requestImpl } = {}) {
    if (!apiKey && !requestImpl) throw new Error('Set TYPESAFE_API_KEY for the typesafe provider, or use JEV_PROVIDER=openjev.');
    Object.assign(this, { apiKey, model, fetchImpl, timeoutMs, retries, requestImpl });
  }
  async request(state, questions, signal) {
    if (this.requestImpl) return this.requestImpl(state, questions, signal);
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(ENDPOINT, { method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]) });
      if ((response.status === 429 || response.status === 529 || response.status >= 500) && attempt < this.retries) {
        await response.body?.cancel();
        await delay(300 * 2 ** attempt, undefined, { signal });
        continue;
      }
      // Never log request credentials or arbitrary server error bodies.
      if (!response.ok) throw new Error(`TypeSafe API HTTP ${response.status}`);
      const data = await response.json();
      if (!data.answers) throw new Error('TypeSafe response missing answers');
      return data;
    }
  }
  async chooseGoal(observation, goals, memory, signal) {
    if (goals.length === 1) return { goal: goals[0], noModel: true };
    const response = await this.request({ objective: GOAL, observation, experience: memory }, {
      goal: { type: 'choice', instructions: 'Select the most useful attainable prerequisite toward survival, useful tools, food, a safe house, a bed and efficient dragon progression. Eat when hungry, avoid duplicate tools and arbitrary dirt collection. Prioritize urgent needs and recipe dependencies that unlock real capabilities. Use experience to avoid failed approaches. No fixed walkthrough. Only supplied observations are known.',
        criteria: Object.fromEntries(goals.map(g => [g.id, g.description])) }
    }, signal);
    const answer = validateChoice(response.answers.goal, goals.map(g => g.id));
    return { goal: goals.find(g => g.id === answer.choice), answer, model: response.model, usage: response.usage };
  }
  async decide(observation, goal, actions, memory, signal) {
    if (actions.length === 1) return { action: { type: 'choice', choice: actions[0].id,
      probabilities: { [actions[0].id]: 1 }, confidence: 1, calibrated: false },
      danger: { noul: 0 }, replan: { noul: 0 }, noModel: true, model: 'single-available-control' };
    const response = await this.request({ objective: GOAL, observation, currentGoal: goal,
      experience: memory, availableActions: actions }, {
      action: { type: 'choice', instructions: 'Choose one short action toward the current goal. Survival first. Use visible geometry, equipment and experience. Missing information is unknown. Looking can gather information. Movement can approach resources and collect drops. Avoid repeating failures.',
        criteria: Object.fromEntries(actions.map(a => [a.id, a.description])) },
      danger: { type: 'noul', instructions: 'Does the observed situation require an immediate survival response?' },
      replan: { type: 'noul', instructions: 'Is the current goal already achieved, blocked, or inappropriate given the observation and recent outcomes?' }
    }, signal);
    validateChoice(response.answers.action, actions.map(a => a.id));
    if (response.answers.danger?.type !== 'noul' || response.answers.replan?.type !== 'noul' ||
      !unit(response.answers.danger.noul) || !unit(response.answers.replan.noul)) throw new Error('Invalid Jev noul response');
    return { ...response.answers, model: response.model, usage: response.usage };
  }
}
