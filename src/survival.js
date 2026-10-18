// Sensorimotor safety, not a progression script. Runs independently of model latency.
export class Survival {
  constructor(game, { onInterrupt = () => {}, onEvent = () => {}, now = Date.now } = {}) {
    Object.assign(this, { game, onInterrupt, onEvent, now });
    this.active = false;
    this.revision = 0;
    this.responses = 0;
    this.lastAttack = -Infinity;
    this.lastLook = -Infinity;
    this.lastDamage = -Infinity;
    this.lastThreatAt = -Infinity;
    this.health = game.bot?.health ?? 20;
    this.seen = new Map();
    this.healthChanged = () => {
      const health = game.bot.health;
      if (health < this.health && !game.isStarvationDamage?.()) { this.lastDamage = this.now(); game.lastDamageAt=Date.now(); game.setEmergency?.(true); this.onInterrupt(); game.stop(); this.motion=null; }
      this.health = health;
    };
    this.tick = this.tick.bind(this);
  }
  start() {
    this.game.bot?.on('physicsTick', this.tick);
    this.game.bot?.on('health', this.healthChanged);
    this.game.inDanger = () => this.active || this.now() - this.lastDamage < 2500;
  }
  stop() {
    this.game.bot?.off('physicsTick', this.tick); this.game.bot?.off('health', this.healthChanged);
    this.active = false; this.game.inDanger = undefined; this.game.stop();
  }
  tick() {
    const game = this.game, bot = game.bot;
    if (!game.ready || !game.connected || !bot.entity || bot.health <= 0 || !game.senseThreats) return;
    const observed = game.senseThreats();
    for (const e of observed) this.seen.set(e.id, { ...e, seenAt: this.now() });
    for (const [id, e] of this.seen) if (this.now() - e.seenAt > 1800) this.seen.delete(id);
    // Retain last observed positions briefly across occlusion; never track unseen live positions.
    const threats = [...this.seen.values()].map(e => ({ ...e, distance: Math.hypot(
      bot.entity.position.x-e.position.x, bot.entity.position.y-e.position.y, bot.entity.position.z-e.position.z) }));
    // Mineflayer converts Minecraft's 300 air ticks to a 0–20 breath scale.
    const water = Boolean(bot.entity.isInWater && (bot.oxygenLevel ?? 20) <= 8);
    const ranged = new Set(['skeleton', 'stray', 'witch', 'pillager', 'blaze', 'ghast']);
    const threat = threats.find(e => e.distance < (this.active ? 9 : e.name === 'creeper' ? 8 : ranged.has(e.name) ? 8 : 7));
    if (threat) {
      if(observed.some(e=>e.id===threat.id)) this.lastThreatAt=this.now();
      this.lastThreat=threat;
    }
    if (!threat && !water) {
      if (this.active && this.now() - Math.max(this.lastDamage, this.lastThreatAt) >= 1200) {
        this.active=false;this.motion=null;game.survivalStatus=null;game.stop();game.setEmergency?.(false);
      } else if(this.active && this.lastThreat) game.escapeThreat?.(this.lastThreat);
      return;
    }
    if (!this.active) {
      this.active = true; this.revision++; this.responses++;
      game.setEmergency?.(true);
      // Cancel the obsolete decision/action before taking ownership of controls.
      game.stop(); this.onInterrupt();
      this.onEvent({ event: 'survival-reaction', reason: water ? 'low-oxygen' : `nearby-${threat.name}`,
        distance: threat?.distance, oxygen:bot.oxygenLevel, at: this.now() });
    }
    if (water) { game.survivalStatus={mode:'Surfacing for air'};bot.setControlState('jump', true); return; }
    const weapons=(bot.inventory?.items() || []).filter(i=>/_(sword|axe)$/.test(i.name)).sort((a,b)=>{
      const score=i=>(i.name.endsWith('_sword')?10:5)+['wooden','golden','stone','iron','diamond','netherite'].indexOf(i.name.split('_')[0]);
      return score(b)-score(a);
    });
    const weapon=weapons[0];
    const overpowering=new Set(['creeper','warden','ravager','piglin_brute','hoglin','ender_dragon']);
    const fight=Boolean(!ranged.has(threat.name) && !overpowering.has(threat.name) && threats.length===1 &&
      weapon && bot.health>=10 && threat.distance<=7.5);
    if(fight) {
      game.survivalStatus={mode:`Fighting ${threat.name}`,distance:threat.distance};
      if(threat.distance>2.9) {
        if(this.motion!=='combat-approach') {game.stop();this.motion='combat-approach';}
        game.approachThreat?.(threat);
      } else {
        if(this.motion!=='melee') {game.stop();this.motion='melee';}
        const dx=bot.entity.position.x-threat.position.x,dz=bot.entity.position.z-threat.position.z;
        const away=Math.abs(dx)>Math.abs(dz)?(dx>0?'east':'west'):(dz>0?'south':'north');
        bot.setControlState('forward',false);bot.setControlState('sprint',false);
        bot.setControlState('back',threat.distance<1.8 && game.safeStep(away));
        this.defend(threat,weapon);
        if(!this.attacking && bot.inventory?.slots?.[45]?.name==='shield' && !bot.usingHeldItem) bot.activateItem?.(true);
      }
      return;
    }
    game.survivalStatus={mode:`Retreating from ${threat.name}`,distance:threat.distance};
    if(this.retreatAttack) return;
    const candidates = ['north', 'south', 'east', 'west'].flatMap(direction => {
      const jump = !game.safeStep(direction) && game.safeJump(direction);
      if (!jump && !game.safeStep(direction)) return [];
      const [dx, dz] = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[direction];
      const p = bot.entity.position.offset(dx * 2, 0, dz * 2);
      const safety = Math.min(...threats.map(e => Math.hypot(p.x - e.position.x, p.z - e.position.z)));
      return [{ direction, jump, p, safety, score: safety + (this.direction === direction ? 0.35 : 0) }];
    }).sort((a, b) => b.score - a.score);
    const escape = candidates[0];
    if (escape && escape.safety > threat.distance + 0.15) {
      if(this.motion!=='flee-manual') {game.stop();this.motion='flee-manual';}
      this.direction = escape.direction;
      if (this.now() - this.lastLook > 200) {
        this.lastLook = this.now();
        void bot.lookAt(escape.p.offset(0, 1.62, 0), false).catch(() => {});
      }
      bot.setControlState('forward', true);
      bot.setControlState('sprint', bot.food > 6);
      bot.setControlState('jump', escape.jump);
    } else {
      if(this.motion!=='flee-path') {game.stop();this.motion='flee-path';}
      game.escapeThreat?.(threat);
    }
    // Knock back an enemy that catches up while retreating; running without
    // defending lets faster mobs land repeated uncontested hits.
    if (threat.distance <= 3 && this.now() - this.lastAttack >= 650 &&
      (threat.name!=='creeper' || !escape)) {
      this.defend(threat,weapon,true);
    }
  }
  defend(threat,weapon,retreat=false) {
    const bot=this.game.bot,target=bot.entities[threat.id];
    const cooldown=weapon?.name.endsWith('_axe')?1050:650;
    if(!target || this.attacking || this.now()-this.lastAttack<cooldown) return;
    this.lastAttack=this.now();this.attacking=true;
    if(retreat) {this.retreatAttack=true;this.game.stop();this.motion=null;}
    void (async()=>{
      if(bot.usingHeldItem) bot.deactivateItem?.();
      if(weapon && bot.heldItem?.type!==weapon.type) await bot.equip(weapon,'hand');
      if(!this.active || !this.game.connected || bot.health<=0) return;
      await bot.lookAt(target.position.offset(0,1,0),false);
      if(this.active && this.game.connected && target.position.distanceTo(bot.entity.position)<=3 &&
        (!this.game.visible || this.game.visible(target.position.offset(0,1,0)))) bot.attack(target);
    })().catch(()=>{}).finally(()=>{
      this.attacking=false;
      if(retreat) {this.retreatAttack=false;this.lastLook=-Infinity;}
    });
  }
}
