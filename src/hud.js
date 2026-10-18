import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export class Hud {
  constructor(game, path) {
    Object.assign(this, { game, path, activity: 'Observing', last: 0 });
    mkdirSync(dirname(path), { recursive: true });
    this.tick = () => { if (Date.now()-this.last >= 100) this.write(); };
    game.bot.on('physicsTick', this.tick);
    this.write();
  }
  write(online = this.game.connected && this.game.ready) {
    const bot = this.game.bot;
    this.last = Date.now();
    const snapshot = { at: this.last, online: Boolean(online), player: bot.username, health: bot.health,
      food: bot.food, selected: bot.quickBarSlot ?? 0, activity: this.game.survivalStatus?.mode || (this.game.inDanger?.() ? 'Recovering after damage' : this.activity),
      position:bot.entity?.position, navigation:this.game.navigationStatus, survival:this.game.survivalStatus,
      oxygen:bot.oxygenLevel,exploration:this.game.exploration?.stats(),heading:this.game.exploration?.heading,
      slots: Array.from({ length: 9 }, (_, i) => {
        const item = bot.inventory.slots?.[36+i];
        return item ? { name: item.name, count: item.count } : null;
      }) };
    writeFileSync(`${this.path}.tmp`, JSON.stringify(snapshot));
    renameSync(`${this.path}.tmp`, this.path);
  }
  close() { this.game.bot.off('physicsTick', this.tick); this.write(false); }
}
