import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRuns } from '../src/report.js';

test('gameplay comparison excludes empty runs and reports rates under the correct modes', () => {
  const metrics = { steps: 10, longestLifeSeconds: 60, deaths: 0, verifiedActions: 8,
    goalCompletions: 2, resourceGains: { oak_log: 4 }, elapsedSeconds: 120, completionVerified: false };
  const result = compareRuns([{ mode: 'adaptive', world: 'a', metrics }, { mode: 'baseline', world: 'b', metrics: { ...metrics, verifiedActions: 4 } },
    { mode: 'adaptive', world: 'c', metrics: { ...metrics, steps: 0 } }]);
  assert.equal(result[0].runs, 1);
  assert.equal(result[0].meanGrossItemsPerMinute, 2);
  assert.equal(result[0].meanVerifiedActionRate, 0.8);
  assert.equal(result[1].meanVerifiedActionRate, 0.4);
  assert.equal(result[0].verifiedCompletions, 0);
  assert.deepEqual(compareRuns([]), []);
});

test('controller and reward revisions are reported separately rather than mixing incompatible metrics',()=>{
 const metrics={steps:1,longestLifeSeconds:1,deaths:0,verifiedActions:1,goalCompletions:1,resourceGains:{},elapsedSeconds:1};
 const rows=[{mode:'adaptive',world:'a',metrics},{mode:'adaptive',world:'a',metrics:{...metrics,controllerVersion:5}}];
 const groups=compareRuns(rows);assert.equal(groups.length,2);
 assert.equal(groups[0].controllerVersion,'legacy');assert.equal(groups[1].controllerVersion,5);
});
