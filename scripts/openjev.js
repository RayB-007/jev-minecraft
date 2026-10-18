import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = resolve(root, 'data');
const domain = `gui/${process.getuid()}`;
const label = 'local.jev.openjev';
const job = `${domain}/${label}`;
const python = resolve(root, '.venv-openjev/bin/python');
const command = process.argv[2] || 'status';
const call = args => spawnSync('launchctl', args, { encoding: 'utf8' });
const state = () => call(['print', job]);
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

if (process.platform !== 'darwin') throw new Error('The installed local OpenJev service uses macOS MLX and launchd.');
if (command === 'start') {
  if (!existsSync(python)) throw new Error('Install the local Python environment first; see README.md.');
  const loaded = state();
  if (loaded.status === 0) {
    if (!/^\s*pid = \d+/m.test(loaded.stdout)) {
      const restarted = call(['kickstart', job]);
      if (restarted.status !== 0) throw new Error(restarted.stderr.trim());
      console.log('Restarting the stopped OpenJev job.');
    } else console.log('Local OpenJev is already running.');
    process.exit(0);
  }
  mkdirSync(data, { recursive: true });
  const plist = resolve(data, 'openjev.plist');
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(python)}</string><string>-u</string><string>${xml(resolve(root, 'scripts/openjev_server.py'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>StandardOutPath</key><string>${xml(resolve(data, 'openjev.log'))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(data, 'openjev.log'))}</string>
<key>RunAtLoad</key><true/>
<key>ExitTimeOut</key><integer>60</integer>
<key>EnvironmentVariables</key><dict><key>HF_HUB_OFFLINE</key><string>1</string></dict>
</dict></plist>\n`);
  const result = call(['bootstrap', domain, plist]);
  if (result.status !== 0) throw new Error(result.stderr.trim());
  console.log('Local OpenJev is loading at 127.0.0.1:8767. Run npm run doctor to check readiness.');
} else if (command === 'stop') {
  if (state().status !== 0) { console.log('OpenJev is not loaded.'); process.exit(0); }
  const result = call(['bootout', job]);
  if (result.status !== 0) throw new Error(result.stderr.trim());
  const deadline = Date.now() + 30000;
  while (state().status === 0 && Date.now() < deadline) await delay(100);
  if (state().status === 0) throw new Error('OpenJev is still stopping; wait before restarting it.');
  console.log('OpenJev stopped.');
} else if (command === 'status') {
  const result = state();
  console.log(JSON.stringify({ loaded: result.status === 0,
    state: result.stdout.match(/^\s*state = (.+)/m)?.[1] ?? 'not loaded',
    pid: result.stdout.match(/^\s*pid = (\d+)/m)?.[1] ?? null,
    endpoint: 'http://127.0.0.1:8767', log: resolve(data, 'openjev.log') }, null, 2));
} else throw new Error('Use start, stop or status.');
