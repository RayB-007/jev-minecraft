import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { Memory } from './memory.js';
import { benchmark } from './benchmark.js';
import { compareRuns } from './report.js';
import { createModel, providerName, localEndpoint } from './openjev.js';
import { Hud } from './hud.js';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

function integer(value, fallback, min, max, name) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

async function main() {
  const command = process.argv[2] ?? 'play';
  const db = process.env.JEV_DB || 'data/experience.sqlite';
  if (command === 'benchmark') {
    const report = benchmark();
    mkdirSync('data', { recursive: true }); writeFileSync('data/benchmark.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2)); return;
  }
  if (command === 'report') {
    if (!existsSync(db)) { console.log('No gameplay runs recorded yet.'); return; }
    const memory = new Memory(db);
    try {
      const runs = memory.runs();
      console.log(JSON.stringify({ runs, comparison: compareRuns(runs) }, null, 2));
    } finally { memory.close(); }
    return;
  }
  const host = process.env.MC_HOST || 'localhost';
  const port = integer(process.env.MC_PORT, 25565, 1, 65535, 'MC_PORT');
  if (command === 'doctor') {
    const provider = providerName();
    let localModel = null;
    if (provider === 'openjev') {
      try { const r = await fetch(`${localEndpoint()}/health`, { signal: AbortSignal.timeout(2000) }); localModel = await r.json(); }
      catch { localModel = { ready: false, hint: 'Run npm run openjev:start' }; }
    }
    const reachable = await new Promise(resolve => {
      const socket = createConnection({ host, port });
      const done = value => { socket.destroy(); resolve(value); };
      socket.setTimeout(1500); socket.once('connect', () => done(true));
      socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
    });
    console.log(JSON.stringify({ node: process.version, provider, apiKeyRequired: provider === 'typesafe',
      ...(provider === 'typesafe' ? { typesafeKeyConfigured: Boolean(process.env.TYPESAFE_API_KEY) } : { localModel }),
      minecraft: { host, port, tcpReachable: reachable },
      note: 'TCP reachability does not verify Minecraft protocol or authentication.' }, null, 2)); return;
  }
  if (command !== 'play') throw new Error('Commands: play, benchmark, report, doctor');
  const model = createModel();
  const { Minecraft } = await import('./minecraft.js');
  const { Agent } = await import('./agent.js');
  const auth = process.env.MC_AUTH || 'offline';
  if (!['offline', 'microsoft'].includes(auth)) throw new Error('MC_AUTH must be offline or microsoft');
  const steps = integer(process.env.JEV_STEPS, 300, 1, 1000000, 'JEV_STEPS');
  const mode = process.env.JEV_MODE || 'adaptive';
  if (!['adaptive', 'baseline', 'evaluate'].includes(mode)) throw new Error('JEV_MODE must be adaptive, baseline or evaluate');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let game, memory, hud;
  try {
    game = await Minecraft.connect({ host, port, username: process.env.MC_USERNAME || 'Jev', auth,
      ...(process.env.MC_VERSION ? { version: process.env.MC_VERSION } : {}) }, controller.signal);
    memory = new Memory(db);
    hud = new Hud(game, resolve('data/hud.json'));
    const world = process.env.JEV_WORLD || `${host}:${port}`;
    game.exploration.attach(memory,world);
    game.furnaces.attach(memory,world);
    game.farming.attach(memory,world);
    game.shelter.persist(resolve('data/houses',`${createHash('sha256').update(world).digest('hex').slice(0,16)}.json`));
    game.setActivity = activity => { hud.activity = activity; };
    console.log(JSON.stringify({event:'controller-ready',automaticNavigationDigging:game.bot.pathfinder.movements.canDig,
      escapeDigging:game.navigation.escape.canDig,workNavigationClearing:'foliage-only',
      blockedRouteRecovery:'Ordinary terrain only, with a pickaxe; never ores or tree trunks; disabled during escape',
      objective:'Survive; collect starter wood; make useful tools, food, a house and bed; progress toward the dragon.'}));
    const agent = new Agent({ game, model, memory, world,
      learning: mode !== 'baseline', training: mode === 'adaptive' });
    console.log(JSON.stringify(await agent.run({ steps, signal: controller.signal }), null, 2));
  } finally {
    hud?.close(); game?.close(); memory?.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
