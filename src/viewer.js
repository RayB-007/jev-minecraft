import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Rcon } from 'rcon-client';

export const VIEWER = 'JevViewer';

export function playerName(name) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('Player names must be 1–16 letters, digits or underscores');
  return name;
}

export function installSpectatorPack(root, target) {
  playerName(target);
  if (target === VIEWER) throw new Error('MC_USERNAME must differ from the viewer name');
  const server = resolve(root, 'server');
  const properties = readFileSync(`${server}/server.properties`, 'utf8');
  const level = properties.split(/\r?\n/).find(line => line.startsWith('level-name='))?.slice('level-name='.length) || 'world';
  const world = resolve(server, level);
  if (!world.startsWith(server + sep)) throw new Error('Viewer requires a world inside the local server directory');
  const pack = resolve(world, 'datapacks/jev_spectator');
  const files = {
    'pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: 'JevViewer is a passive spectator camera; AI gameplay is unchanged.' } }),
    'data/minecraft/tags/function/tick.json': JSON.stringify({ values: ['jev_viewer:tick'] }),
    'data/jev_viewer/function/tick.mcfunction': [
      'execute as @a[name=JevViewer,gamemode=!spectator] run gamemode spectator @s',
      `execute as @a[name=JevViewer,gamemode=spectator] if entity @a[name=${target},limit=1] run spectate ${target} @s`,
      ''
    ].join('\n')
  };
  let changed = false;
  for (const [name, contents] of Object.entries(files)) {
    const path = resolve(pack, name);
    try { if (readFileSync(path, 'utf8') === contents) continue; } catch { /* First installation. */ }
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, contents); changed = true;
  }
  return changed;
}

export async function connectConsole(root) {
  const properties = Object.fromEntries(readFileSync(`${root}/server/server.properties`, 'utf8').split(/\r?\n/)
    .filter(line => line && !line.startsWith('#')).map(line => {
      const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
    }));
  if (properties['server-ip'] !== '127.0.0.1' || properties['enable-rcon'] !== 'true' || !properties['rcon.password'])
    throw new Error('The local viewer console is not configured; see README.md');
  return Rcon.connect({ host: '127.0.0.1', port: Number(properties['rcon.port'] || 25575),
    password: properties['rcon.password'], timeout: 3000 });
}

export async function followAgent(consoleClient, target, { initialize = false } = {}) {
  playerName(target);
  if (target === VIEWER) throw new Error('MC_USERNAME must differ from the viewer name');
  const listing = await consoleClient.send('list');
  const names = listing.split(':').slice(1).join(':').split(',').map(n => n.trim());
  if (!names.includes(VIEWER)) return { viewerJoined: false, following: false };
  if (initialize) await consoleClient.send(`gamemode spectator ${VIEWER}`);
  if (!names.includes(target)) return { viewerJoined: true, following: false };
  const answer = await consoleClient.send(`spectate ${target} ${VIEWER}`);
  return { viewerJoined: true, following: /now spectating|already spectating/i.test(answer) };
}
