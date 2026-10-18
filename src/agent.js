import { contextOf, cellOf, goalsFor, goalDone, CONTROLLER_VERSION } from './state.js';
import { rankActions } from './memory.js';
import { evaluate, REWARD_VERSION } from './evaluation.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Survival } from './survival.js';

export class Agent {
  constructor({ game, model, memory, world, learning = true, training = learning, logger = console.log }) {
    Object.assign(this, { game, model, memory, world, learning, training, logger });
    this.shortTerm = [];
    this.creditedItems = new Set();
  }
  async run({ steps = 300, signal } = {}) {
    const run = this.memory.startRun(this.world, this.learning ? (this.training ? 'adaptive' : 'evaluate') : 'baseline');
    const metrics = { steps: 0, verifiedActions: 0, failures: 0, deaths: 0, goalCompletions: 0,
      totalReward: 0, novelCells: 0, resourceGains: {}, milestones: [], modelCalls: 0, modelMs: 0,
      inputTokens: 0, longestLifeSeconds: 0, controllerVersion:CONTROLLER_VERSION, rewardVersion: REWARD_VERSION, completionVerified: false };
    metrics.emergencyResponses = 0; metrics.idleActions = 0; metrics.progressActions = 0;
    let pendingDecision;
    const survival = new Survival(this.game, { onInterrupt: () => pendingDecision?.abort(new Error('Survival interrupt')),
      onEvent: event => { metrics.emergencyResponses++; this.logger(JSON.stringify(event)); } });
    survival.start();
    const started = Date.now(), milestones = new Set();
    let lifeStarted = started;
    let trackedDeaths=this.game.deaths??0;
    const recordDeath=()=>{
      metrics.longestLifeSeconds=Math.max(metrics.longestLifeSeconds,(Date.now()-lifeStarted)/1000);
      lifeStarted=Date.now();trackedDeaths=this.game.deaths??trackedDeaths+1;
    };
    this.game.bot?.on('death',recordDeath);
    let goal = null, goalStart = null, goalAge = 0, consecutiveErrors = 0, status = 'completed-budget';
    let currentProject=null,lastDeaths;
    const stalledGoals=new Map(),unproductiveAttempts=new Map();
    try {
      const initial = this.game.observe();
      lastDeaths=initial.deaths;
      if (this.learning) this.game.loadMemory?.(this.memory.landmarks(this.world, initial));
      this.memory.visit(`${this.world}:${run}`, cellOf(initial));
      for (const i of initial.inventory) this.creditedItems.add(i.name);
      for (let step = 0; step < steps && !signal?.aborted; step++) {
        while ((survival.active || this.game.inDanger?.() || this.game.bot?.isSleeping) && this.game.connected && (this.game.bot?.health ?? 20) > 0 && !signal?.aborted)
          await delay(25, undefined, { signal });
        if (!this.game.connected) { status = 'disconnected'; break; }
        if (this.game.ready === false || this.game.bot?.health <= 0) await this.game.waitReady?.(signal);
        const before = this.game.observe();
        let candidates=this.game.goals?.(before) ?? goalsFor(before);
        candidates=candidates.filter(g=>(stalledGoals.get(g.id)??0)<=Date.now());
        if(!candidates.length) candidates=[{id:'explore',kind:'explore',description:'Find a new workable position after a stalled task.'}];
        if(before.deaths!==lastDeaths) {currentProject=null;goal=null;lastDeaths=before.deaths;}
        const continuing=currentProject && candidates.filter(g=>g.project===currentProject);
        if(continuing?.length) candidates=continuing;
        if(goal && !candidates.some(g=>g.id===goal.id)) goal=null;
        before.creditedItems = [...this.creditedItems];
        const context = contextOf(before);
        this.memory.rememberWorld(this.world, before);
        const experience = this.learning ? { recent: this.shortTerm.slice(-5),
          relevant: this.memory.recent(context, 6, true), strategies: this.memory.values(context),
          knownLocations: this.memory.landmarks(this.world, before) } : { recent: this.shortTerm.slice(-5) };
        let decision, actions;
        const decisionController = new AbortController();
        pendingDecision = decisionController;
        const reactionRevision = survival.revision;
        const combined = AbortSignal.any([decisionController.signal, ...(signal ? [signal] : [])]);
        // Interrupt in-flight model requests as soon as damage arrives.
        const damage = () => { if (this.game.bot?.health < before.health && !this.game.isStarvationDamage?.()) decisionController.abort(); };
        this.game.bot?.on('health', damage);
        try {
          const t = Date.now();
          if (!goal || goalAge >= 8) {
            const planned = await this.model.chooseGoal(before, candidates, experience, combined);
            metrics.modelCalls += planned.noModel ? 0 : 1; metrics.inputTokens += planned.usage?.input_tokens ?? 0;
            goal = planned.goal; goalStart = before; goalAge = 0;
            currentProject=goal.project || null;
          }
          actions = this.game.actions(before, goal, this.shortTerm);
          this.game.setActivity?.(goal.description || goal.id);
          const targetKey = a => JSON.stringify([a.type, a.position, a.entityId, a.direction, a.item]);
          // Cool down a repeatedly failing exact target, rather than retrying it indefinitely.
          actions = actions.filter(a => this.shortTerm.slice(-4).filter(e =>
            !e.evaluation.success && !e.evaluation.pending && targetKey(e.action) === targetKey(a)).length < 2);
          if (!actions.length) {
            // A blocked target is a gameplay planning failure, not a broken model provider.
            goal = { id: 'explore', kind: 'explore', description: 'Find a different reachable route or a new resource.' };
            goalStart = before; goalAge = 0;
            actions = this.game.actions(before, goal, this.shortTerm);
          }
          if (!actions.length) throw new Error('No currently usable actions');
          decision = await this.model.decide(before, goal, actions, experience, combined);
          metrics.modelCalls += decision.noModel ? 0 : 1; metrics.inputTokens += decision.usage?.input_tokens ?? 0;
          metrics.modelMs += Date.now() - t;
          consecutiveErrors = 0;
        } catch (e) {
          if (!survival.active) this.game.stop(); goal = null;
          if (signal?.aborted) { status = 'stopped'; break; }
          if (combined.aborted || survival.active || reactionRevision !== survival.revision) { goal = null; consecutiveErrors = 0; continue; }
          this.logger(JSON.stringify({ event: 'decision-error', error: e.message }));
          if (++consecutiveErrors >= 3) throw new Error('Three consecutive decision failures; stopped before acting on guesses');
          await delay(200, undefined, { signal }); continue;
        } finally { this.game.bot?.off('health', damage); }

        const fresh = this.game.observe();
        if (fresh.health < before.health && !this.game.isStarvationDamage?.() || fresh.deaths !== before.deaths || fresh.dimension !== before.dimension ||
          Math.hypot(fresh.position.x - before.position.x, fresh.position.z - before.position.z) > 0.5) { goal = null; continue; }
        if (combined.aborted || survival.active) { goal = null; continue; }

        const ranked = rankActions(actions, decision.action.probabilities, this.learning ? this.memory.values(context) : [],
          { learning: this.learning, explore: this.training && decision.danger.noul < 0.5 });
        let selected = ranked[0];
        // Low confidence gathers information instead of attempting an uncertain irreversible action.
        if (decision.action.calibrated !== false && decision.action.confidence < 0.25 && decision.danger.noul < 0.5)
          selected = ranked.find(r => r.action.type === 'look') ?? selected;
        const action = selected.action;
        this.game.setActivity?.(action.description);
        const result = await this.game.execute(action, { signal: combined });
        this.game.exploration?.outcome(action,result);
        // A disconnected client has no reliable post-action observation. Never fabricate a reward.
        if (signal?.aborted) { status = 'stopped'; break; }
        if ((!this.game.connected || result.fatal) && !result.terminalObservation) {
          metrics.deaths = this.game.deaths ?? metrics.deaths;
          metrics.failures++;
          status = result.fatal ? 'execution-interrupted' : 'disconnected'; break;
        }
        const after = result.terminalObservation ?? this.game.observe();
        const novel = this.memory.visit(`${this.world}:${run}`, cellOf(after));
        const evaluation = evaluate(before, after, action, result, novel);
        let reflection=reactionRevision===survival.revision?this.game.planner?.outcome?.(goal,action,result,before,after):undefined;
        if(['craft','build','shelter','wear','till','plant','fertilize','harvest-crop','gather'].includes(goal.kind) && !evaluation.pending && reactionRevision===survival.revision) {
          const attempts=evaluation.productive?0:(unproductiveAttempts.get(goal.id)??0)+1;
          unproductiveAttempts.set(goal.id,attempts);
          if(attempts>=8) {
            stalledGoals.set(goal.id,Date.now()+60000);unproductiveAttempts.delete(goal.id);
            metrics.stalledTasks=(metrics.stalledTasks??0)+1;
            reflection={replan:true,reason:`Eight actions without a productive result on ${goal.id}; leave this task for 60 seconds and find another approach.`};
          }
        }
        if(reflection?.replan) evaluation.reward=Math.max(-20,evaluation.reward-1.5);
        const record = { step, goal, action, before, after, result, evaluation, decision, reflection,rank: selected };
        record.interruptedBySurvival = reactionRevision !== survival.revision;
        this.memory.record(run, before, record, this.training && !record.interruptedBySurvival && !evaluation.pending);
        if (action.type === 'dig' && result.blockChanged) this.memory.forgetBlock(this.world, after.dimension, action.position);
        for (const i of after.inventory) this.creditedItems.add(i.name);
        this.shortTerm.push({ action, result, evaluation }); this.shortTerm = this.shortTerm.slice(-8);
        metrics.steps++; metrics.verifiedActions += Number(evaluation.success); metrics.failures += Number(!evaluation.success && !evaluation.pending);
        metrics.processingChecks=(metrics.processingChecks??0)+Number(evaluation.pending);
        metrics.skillOutcomes??={};
        if(['smelt','furnace-check','wear','till','plant','fertilize','harvest-crop'].includes(action.type)) {
          const skill=metrics.skillOutcomes[action.type]??={attempts:0,verified:0,pending:0,failures:0};
          skill.attempts++;skill.verified+=Number(evaluation.success);skill.pending+=Number(evaluation.pending);skill.failures+=Number(!evaluation.success&&!evaluation.pending);
        }
        metrics.idleActions += Number(['wait', 'look'].includes(action.type));
        metrics.progressActions += Number(evaluation.productive);
        metrics.deaths = after.deaths; metrics.totalReward += evaluation.reward; metrics.novelCells += Number(novel);
        if (after.deaths>trackedDeaths) {recordDeath();trackedDeaths=after.deaths;}
        for (const g of evaluation.changes.gains) metrics.resourceGains[g.item] = (metrics.resourceGains[g.item] ?? 0) + g.count;
        for (const i of after.inventory) if (/(pickaxe|iron_ingot|diamond|obsidian|blaze_rod|ender_pearl|ender_eye)/.test(i.name)) milestones.add(`observed-item:${i.name}`);
        if (/nether|the_end/.test(after.dimension)) milestones.add(`entered:${after.dimension}`);
        if (goalDone(goal, goalStart, after)) { metrics.goalCompletions++; goal = null; }
        if(reflection?.replan) {goal=null;currentProject=null;}
        if (evaluation.changes.health < 0) goal = null;
        if (goalAge >= 3 && !evaluation.success && !evaluation.pending) goal = null;
        goalAge++;
        this.logger(JSON.stringify({ event: 'step', run, step, goal: record.goal.id, action: action.description,
          reward: evaluation.reward, verified: evaluation.success, health: after.health, food: after.food,
          confidence: decision.action.confidence, model: decision.model }));
        if (result.fatal) { status = 'execution-interrupted'; break; }
      }
      if (signal?.aborted) status = 'stopped';
    } catch (e) {
      status = signal?.aborted ? 'stopped' : 'error';
      if (!signal?.aborted) throw e;
    } finally {
      metrics.elapsedSeconds = (Date.now() - started) / 1000;
      metrics.deaths = Math.max(metrics.deaths, this.game.deaths ?? 0);
      metrics.longestLifeSeconds = Math.max(metrics.longestLifeSeconds, (Date.now() - lifeStarted) / 1000);
      metrics.milestones = [...milestones];
      metrics.exploration=this.game.exploration?.stats();
      this.game.bot?.off('death',recordDeath);
      this.memory.finishRun(run, status, metrics);
      survival.stop();
    }
    return { run, status, metrics };
  }
}
