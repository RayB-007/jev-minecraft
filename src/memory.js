import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contextOf, strategyOf } from './state.js';

export class Memory {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, world TEXT, mode TEXT, started INTEGER, ended INTEGER, status TEXT, metrics TEXT);
      CREATE TABLE IF NOT EXISTS experiences (id INTEGER PRIMARY KEY, run TEXT, context TEXT, strategy TEXT, reward REAL, success INTEGER, record TEXT);
      CREATE TABLE IF NOT EXISTS values_v1 (context TEXT, strategy TEXT, n INTEGER, mean REAL, failures INTEGER, PRIMARY KEY(context,strategy));
      CREATE TABLE IF NOT EXISTS cells (world TEXT, cell TEXT, PRIMARY KEY(world,cell));
      CREATE TABLE IF NOT EXISTS exploration_cells (world TEXT, dimension TEXT, cell TEXT, visits INTEGER, seen INTEGER,
        PRIMARY KEY(world,dimension,cell));
      CREATE TABLE IF NOT EXISTS terrain_dangers (world TEXT, dimension TEXT, cell TEXT, cost REAL, seen INTEGER,
        PRIMARY KEY(world,dimension,cell));
      CREATE TABLE IF NOT EXISTS station_memory (world TEXT, dimension TEXT, position TEXT, state TEXT,
        PRIMARY KEY(world,dimension,position));
      CREATE TABLE IF NOT EXISTS landmarks (world TEXT, dimension TEXT, x INTEGER, y INTEGER, z INTEGER,
        name TEXT, seen INTEGER, PRIMARY KEY(world,dimension,x,y,z));`);
  }
  startRun(world, mode) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,NULL,?,NULL)').run(id, world, mode, Date.now(), 'running');
    return id;
  }
  stations(world,dimension) {
    return this.db.prepare('SELECT state FROM station_memory WHERE world=? AND dimension=?').all(world,dimension).map(r=>JSON.parse(r.state));
  }
  rememberStation(world,dimension,state) {
    this.db.prepare(`INSERT INTO station_memory VALUES (?,?,?,?) ON CONFLICT(world,dimension,position)
      DO UPDATE SET state=excluded.state`).run(world,dimension,JSON.stringify(state.position),JSON.stringify(state));
  }
  forgetStation(world,dimension,position) {
    this.db.prepare('DELETE FROM station_memory WHERE world=? AND dimension=? AND position=?').run(world,dimension,JSON.stringify(position));
  }
  finishRun(id, status, metrics) {
    this.db.prepare('UPDATE runs SET ended=?,status=?,metrics=? WHERE id=?').run(Date.now(), status, JSON.stringify(metrics), id);
  }
  values(context) {
    return this.db.prepare('SELECT strategy,n,mean,failures FROM values_v1 WHERE context=?').all(context);
  }
  recent(context, limit = 6, trainingOnly = false) {
    return this.db.prepare(`SELECT record FROM experiences WHERE context=?
      AND (?=0 OR run IN (SELECT id FROM runs WHERE mode='adaptive')) ORDER BY id DESC LIMIT ?`).all(context, Number(trainingOnly), limit)
      .map(row => { const e = JSON.parse(row.record); return { action: e.action, reward: e.evaluation.reward,
        verified: e.evaluation.success, error: e.result.error, changes: e.evaluation.changes }; });
  }
  record(run, before, record, learning = true) {
    const context = contextOf(before), strategy = strategyOf(record.action), { reward, success } = record.evaluation;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO experiences(run,context,strategy,reward,success,record) VALUES (?,?,?,?,?,?)')
        .run(run, context, strategy, reward, Number(success), JSON.stringify(record));
      if (learning) this.db.prepare(`INSERT INTO values_v1 VALUES (?,?,1,?,?) ON CONFLICT(context,strategy) DO UPDATE SET
        mean=mean+(excluded.mean-mean)/(n+1), n=n+1, failures=failures+excluded.failures`)
        .run(context, strategy, reward, Number(!success));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  visit(world, cell) {
    return this.db.prepare('INSERT OR IGNORE INTO cells VALUES (?,?)').run(world, cell).changes > 0;
  }
  explorationCells(world,dimension) {
    const load=()=>this.db.prepare('SELECT cell,visits,seen FROM exploration_cells WHERE world=? AND dimension=?').all(world,dimension);
    let cells=load();
    if(!cells.length) {
      // Migrate actual past observations so upgrading does not forget the ground
      // that earlier sessions already searched. Never infer unseen terrain.
      const rows=this.db.prepare(`SELECT json_extract(record,'$.after.position') AS position,
        json_extract(record,'$.after.at') AS seen FROM experiences WHERE run IN (SELECT id FROM runs WHERE world=?)
        AND json_extract(record,'$.after.dimension')=? ORDER BY id DESC LIMIT 2000`).all(world,dimension).reverse();
      let previous;
      const map=new Map();
      for(const row of rows) {
        const p=JSON.parse(row.position),cell=`${Math.floor(p.x/4)},${Math.floor(p.z/4)}`;
        if(cell===previous) continue;previous=cell;
        const entry={cell,visits:(map.get(cell)?.visits??0)+1,seen:row.seen??0};map.set(cell,entry);
      }
      for(const entry of map.values()) this.recordExploration(world,dimension,entry);
      cells=load();
    }
    return cells;
  }
  recordExploration(world,dimension,entry) {
    this.db.prepare(`INSERT INTO exploration_cells VALUES (?,?,?,?,?) ON CONFLICT(world,dimension,cell)
      DO UPDATE SET visits=excluded.visits,seen=excluded.seen`).run(world,dimension,entry.cell,entry.visits,entry.seen);
  }
  terrainDangers(world,dimension) {
    return this.db.prepare('SELECT cell,cost,seen FROM terrain_dangers WHERE world=? AND dimension=?').all(world,dimension);
  }
  recordDanger(world,dimension,entry) {
    this.db.prepare(`INSERT INTO terrain_dangers VALUES (?,?,?,?,?) ON CONFLICT(world,dimension,cell)
      DO UPDATE SET cost=excluded.cost,seen=excluded.seen`).run(world,dimension,entry.cell,entry.cost,entry.seen);
  }
  rememberWorld(world, observation) {
    const insert = this.db.prepare(`INSERT INTO landmarks VALUES (?,?,?,?,?,?,?) ON CONFLICT(world,dimension,x,y,z)
      DO UPDATE SET name=excluded.name,seen=excluded.seen`);
    for (const b of observation.blocks) insert.run(world, observation.dimension, b.position.x, b.position.y, b.position.z, b.name, observation.at);
  }
  forgetBlock(world, dimension, p) {
    this.db.prepare('DELETE FROM landmarks WHERE world=? AND dimension=? AND x=? AND y=? AND z=?').run(world, dimension, p.x, p.y, p.z);
  }
  landmarks(world, observation) {
    const p = observation.position;
    return this.db.prepare(`WITH nearby AS (SELECT *, (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) AS distance FROM landmarks
      WHERE world=? AND dimension=?), ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY distance) AS n FROM nearby)
      SELECT name,x,y,z,seen,'past observation; may have changed' AS status FROM ranked WHERE n<=2 ORDER BY distance LIMIT 32`)
      .all(p.x, p.x, p.y, p.y, p.z, p.z, world, observation.dimension);
  }
  runs() { return this.db.prepare('SELECT * FROM runs ORDER BY started').all().map(r => ({ ...r, metrics: r.metrics ? JSON.parse(r.metrics) : null })); }
  close() { this.db.close(); }
}

export function rankActions(actions, probabilities, values, { learning = true, explore = true } = {}) {
  const stats = new Map(values.map(v => [v.strategy, v]));
  const total = values.reduce((n, v) => n + v.n, 0);
  return actions.map(action => {
    const v = stats.get(strategyOf(action));
    // Bounded prior, empirical outcome value, and modest upper-confidence exploration.
    const prior = probabilities[action.id] ?? 0;
    const learned = learning && v ? 0.55 * Math.tanh(v.mean / 3) : 0;
    const bonus = learning && explore ? 0.12 * Math.sqrt(Math.log(total + 2) / ((v?.n ?? 0) + 1)) : 0;
    return { action, score: prior + learned + bonus, prior, evidence: v ?? null };
  }).sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id));
}
