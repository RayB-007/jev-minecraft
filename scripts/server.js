import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = resolve(root, 'server');
const label = 'local.jev.minecraft';
const domain = `gui/${process.getuid()}`;
const job = `${domain}/${label}`;
const plist = resolve(server, 'launchd.plist');
const java = process.env.JEV_JAVA || '/usr/bin/java';
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const command = process.argv[2] || 'status';
const call = args => spawnSync('launchctl', args, { encoding: 'utf8' });
const state = () => call(['print', job]);

if (process.platform !== 'darwin') throw new Error('This local server launcher uses macOS launchd. Run the jar manually on other platforms.');
if (command === 'start') {
  if (!existsSync(java)) throw new Error('Java runtime missing. Set JEV_JAVA to a Java 21+ executable.');
  if (!existsSync(resolve(server, 'server-1.21.1.jar'))) throw new Error('Minecraft server jar missing from server/.');
  const loaded = state();
  if (loaded.status === 0) {
    if (!/^\s*pid = \d+/m.test(loaded.stdout)) {
      const restarted = call(['kickstart', job]);
      if (restarted.status !== 0) throw new Error(restarted.stderr.trim());
      console.log('Restarting the stopped Minecraft server job.');
    } else console.log('Minecraft server is already running.');
    process.exit(0);
  }
  mkdirSync(server, { recursive: true });
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(java)}</string><string>-Xms512M</string><string>-Xmx2G</string><string>-jar</string><string>server-1.21.1.jar</string><string>nogui</string></array>
<key>WorkingDirectory</key><string>${xml(server)}</string>
<key>StandardOutPath</key><string>${xml(resolve(server, 'console.log'))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(server, 'console.log'))}</string>
<key>RunAtLoad</key><true/>
<key>ExitTimeOut</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n`);
  const result = call(['bootstrap', domain, plist]);
  if (result.status !== 0) throw new Error(`Could not start server: ${result.stderr.trim()}`);
  console.log('Minecraft server is starting at 127.0.0.1:25565. Logs: server/console.log');
} else if (command === 'stop') {
  if (state().status !== 0) { console.log('Minecraft server is not loaded.'); process.exit(0); }
  const result = call(['bootout', job]);
  if (result.status !== 0) throw new Error(result.stderr.trim());
  const deadline = Date.now() + 30000;
  while (state().status === 0 && Date.now() < deadline) await delay(100);
  if (state().status === 0) throw new Error('Minecraft is still saving; wait before restarting it.');
  console.log('Server stop requested; Minecraft saves the world during shutdown.');
} else if (command === 'status') {
  const result = state();
  const pid = result.stdout.match(/^\s*pid = (\d+)/m)?.[1];
  const running = result.stdout.match(/^\s*state = (.+)/m)?.[1];
  console.log(JSON.stringify({ loaded: result.status === 0, state: running ?? 'not loaded', pid: pid ?? null,
    address: '127.0.0.1:25565', version: '1.21.1', log: resolve(server, 'console.log') }, null, 2));
} else throw new Error('Use start, stop or status.');
