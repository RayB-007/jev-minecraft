import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectConsole, followAgent, installSpectatorPack, playerName } from '../src/viewer.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const controller = new AbortController();
let agent, consoleClient, stopRequested = false;
const stop = () => { stopRequested = true; controller.abort(); agent?.kill('SIGINT'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);

function run(program, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: 'inherit', signal: controller.signal });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${program} exited ${code ?? signal}`)));
  });
}

async function waitFor(label, check, seconds = 90) {
  const until = Date.now() + seconds * 1000;
  while (!controller.signal.aborted && Date.now() < until) {
    try { const value = await check(); if (value) return value; } catch { /* Service is still loading. */ }
    await delay(1000, undefined, { signal: controller.signal });
  }
  throw new Error(`${label} did not become ready; inspect its log in data/ or server/`);
}

async function main() {
  const target = playerName(process.env.MC_USERNAME || 'Jev');
  const viewer = process.env.JEV_VIEWER !== 'false';
  if (viewer && ((process.env.MC_HOST && !['localhost', '127.0.0.1'].includes(process.env.MC_HOST)) || Number(process.env.MC_PORT || 25565) !== 25565))
    throw new Error('Automatic viewing is configured for the local 127.0.0.1:25565 server. Use npm run start:headless for other servers.');
  if (viewer) {
    await run(process.execPath, [resolve(root, 'scripts/server.js'), 'start']);
    consoleClient = await waitFor('Minecraft server', () => connectConsole(root));
    consoleClient.on('error', () => {});
    if (installSpectatorPack(root, target)) {
      await consoleClient.send('reload');
      await waitFor('Spectator camera rules', async () => /jev_spectator/.test(await consoleClient.send('datapack list enabled')));
    }
  }
  if ((process.env.JEV_PROVIDER || 'openjev') === 'openjev') {
    await run(process.execPath, [resolve(root, 'scripts/openjev.js'), 'start']);
    await waitFor('Local OpenJev', async () => {
      const r = await fetch('http://127.0.0.1:8767/health', { signal: AbortSignal.timeout(2000) });
      return r.ok && (await r.json()).ready;
    });
  }
  if (viewer) {
    console.log('Opening a spectator-only Minecraft window. It will show Jev’s camera.');
    await run(resolve(root, '.venv-openjev/bin/python'), [resolve(root, 'scripts/viewer.py'), 'launch']);
    await waitFor('Minecraft viewer', async () => {
      const state = await followAgent(consoleClient, target, { initialize: true });
      return state.viewerJoined;
    });
    console.log('Viewer joined in spectator mode. Starting the AI player.');
  }
  agent = spawn(process.execPath, [resolve(root, 'src/cli.js'), 'play'], { cwd: root, env: process.env, stdio: 'inherit' });
  let following = false, busy = false;
  const timer = viewer ? setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await followAgent(consoleClient, target, { initialize: !following });
      if (state.following && !following) console.log('Minecraft is now showing Jev’s point of view.');
      following = state.following;
    } catch { following = false; }
    finally { busy = false; }
  }, 2000) : null;
  try {
    const code = await new Promise((resolvePromise, reject) => {
      agent.once('error', reject); agent.once('exit', (code, signal) => resolvePromise(signal ? 0 : code));
    });
    process.exitCode = code ?? 0;
  } finally { if (timer) clearInterval(timer); }
}

main().catch(error => {
  if (!stopRequested) { console.error(error.message); process.exitCode = 1; }
}).finally(async () => {
  await consoleClient?.end();
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
});
