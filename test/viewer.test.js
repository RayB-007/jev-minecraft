import test from 'node:test';
import assert from 'node:assert/strict';
import { followAgent, playerName, installSpectatorPack } from '../src/viewer.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the viewer becomes a spectator and follows the separate AI player', async () => {
  const commands = [];
  const consoleClient = { async send(command) {
    commands.push(command);
    if (command === 'list') return 'There are 2 of a max of 4 players online: JevViewer, Jev';
    if (command.startsWith('spectate')) return 'JevViewer is now spectating Jev';
    return 'Set own game mode to Spectator Mode';
  } };
  const result = await followAgent(consoleClient, 'Jev', { initialize: true });
  assert.deepEqual(result, { viewerJoined: true, following: true });
  assert.deepEqual(commands, ['list', 'gamemode spectator JevViewer', 'spectate Jev JevViewer']);
});

test('camera supervision waits for players and does not change the AI game mode', async () => {
  const commands = [];
  const consoleClient = { async send(c) { commands.push(c); return 'There are 1 of a max of 4 players online: JevViewer'; } };
  const result = await followAgent(consoleClient, 'Jev', { initialize: true });
  assert.equal(result.viewerJoined, true); assert.equal(result.following, false);
  assert.deepEqual(commands, ['list', 'gamemode spectator JevViewer']);
  commands.length = 0;
  consoleClient.send = async c => { commands.push(c); return 'There are 0 of a max of 4 players online:'; };
  assert.equal((await followAgent(consoleClient, 'Jev')).viewerJoined, false);
  assert.deepEqual(commands, ['list']);
});

test('camera commands reject malformed player names and self-spectating', async () => {
  for (const name of ['Jev\nop Jev', '@a', '', 'a'.repeat(17)]) assert.throws(() => playerName(name));
  const consoleClient = { async send() { throw new Error('Must not send any command'); } };
  await assert.rejects(followAgent(consoleClient, 'JevViewer'), /differ/);
  await assert.rejects(followAgent(consoleClient, '@a'), /Player names/);
});

test('spectator rules persist on the server and restrict mode changes to the viewer', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-camera-'));
  try {
    mkdirSync(join(root, 'server'));
    writeFileSync(join(root, 'server/server.properties'), 'level-name=world\n');
    assert.equal(installSpectatorPack(root, 'Jev'), true);
    assert.equal(installSpectatorPack(root, 'Jev'), false);
    const pack = join(root, 'server/world/datapacks/jev_spectator');
    const tick = readFileSync(join(pack, 'data/jev_viewer/function/tick.mcfunction'), 'utf8');
    const modeCommands = tick.split('\n').filter(line => line.includes('gamemode spectator'));
    assert.equal(modeCommands.length, 1);
    assert.match(modeCommands[0], /as @a\[name=JevViewer,gamemode=!spectator\]/);
    assert.match(tick, /run spectate Jev @s/);
    assert.deepEqual(JSON.parse(readFileSync(join(pack, 'data/minecraft/tags/function/tick.json'), 'utf8')).values, ['jev_viewer:tick']);
    assert.throws(() => installSpectatorPack(root, '@a'), /Player names/);
    writeFileSync(join(root, 'server/server.properties'), 'level-name=../../outside\n');
    assert.throws(() => installSpectatorPack(root, 'Jev'), /inside/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
