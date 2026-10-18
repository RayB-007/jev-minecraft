import { Minecraft } from '../src/minecraft.js';
import { evaluate } from '../src/evaluation.js';
import { mkdirSync, writeFileSync } from 'node:fs';

// Connection/control test only. No Jev request, training, mining, commands, or invented rewards.
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30000);
let game;
try {
  game = await Minecraft.connect({ host: process.env.MC_HOST || '127.0.0.1',
    port: Number(process.env.MC_PORT || 25565), username: 'JevSetupCheck', auth: 'offline',
    version: process.env.MC_VERSION || '1.21.1' }, controller.signal);
  await Promise.race([
    game.bot.waitForChunksToLoad(),
    new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Chunk load timed out')), { once: true }))
  ]);
  const before = game.observe();
  const action = game.actions(before).find(a => a.type === 'look');
  if (!action || before.blocks.length === 0) throw new Error('No usable world observation after login');
  const result = await game.execute(action, { signal: controller.signal });
  const after = game.observe();
  const outcome = evaluate(before, after, action, result);
  if (!result.ok || !outcome.success) throw new Error('Look action did not produce a verified effect');
  const report = { at: new Date().toISOString(), environment: 'real-minecraft-java-server', version: game.bot.version,
    address: '127.0.0.1:25565', mode: game.bot.game.gameMode, health: after.health, food: after.food,
    visibleBlocks: after.blocks.length, visibleBlockTypes: [...new Set(after.blocks.map(b => b.name))],
    offeredActions: game.actions(after).length, connectionVerified: true, perceptionVerified: true,
    lookActionVerified: true, modelCalled: false, trainingRecorded: false };
  mkdirSync('data', { recursive: true }); writeFileSync('data/server-smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { clearTimeout(timer); game?.close(); }
