export function compareRuns(runs) {
  const groups = new Map();
  for (const run of runs.filter(r => r.metrics?.steps > 0)) {
    const key=JSON.stringify([run.mode,run.metrics.controllerVersion??'legacy',run.metrics.rewardVersion??'unversioned']);
    const group = groups.get(key) ?? [];
    group.push(run); groups.set(key, group);
  }
  return [...groups].map(([, rows]) => {
    const mean = fn => rows.reduce((sum, r) => sum + fn(r.metrics), 0) / rows.length;
    return { mode:rows[0].mode,controllerVersion:rows[0].metrics.controllerVersion??'legacy',rewardVersion:rows[0].metrics.rewardVersion??'unversioned',runs: rows.length, worlds: new Set(rows.map(r => r.world)).size,
      meanLongestLifeSeconds: mean(m => m.longestLifeSeconds), meanDeaths: mean(m => m.deaths),
      meanVerifiedActionRate: mean(m => m.verifiedActions / m.steps),
      meanGoalCompletions: mean(m => m.goalCompletions),
      meanGrossItemsPerMinute: mean(m => Object.values(m.resourceGains).reduce((n, x) => n + x, 0) / Math.max(m.elapsedSeconds / 60, 1 / 60)),
      verifiedCompletions: rows.filter(r => r.metrics.completionVerified).length,
      caveat: 'Descriptive run averages; worlds and budgets must be matched externally before attributing differences to learning.' };
  });
}
