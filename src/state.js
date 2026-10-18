export const GOAL = 'Stay alive and complete Minecraft efficiently: secure food, useful materials and tools, establish a safe house and bed, and progress toward defeating the Ender Dragon. React to danger before doing work. Avoid pointless digging, wandering and duplicate equipment. Choose attainable prerequisites from current observations and experience; minimize wasted time and deaths.';

export const CONTROLLER_VERSION=6;

export function contextOf(o) {
  // Reusable context, deliberately excluding coordinates, ephemeral entity ids and world seed.
  return JSON.stringify({ controller: CONTROLLER_VERSION, dimension: o.dimension, health: o.health <= 6 ? 'critical' : o.health < 15 ? 'hurt' : 'healthy',
    food: o.food < 10 ? 'hungry' : 'fed', threat: o.entities.some(e => e.kind === 'hostile' && e.distance < 6),
    tool: o.inventory.some(i => i.name.endsWith('_pickaxe')), table: o.blocks.some(b => b.name === 'crafting_table') });
}

export function strategyOf(a) {
  // Stable action semantics prevent an LLM from renaming a failure out of memory.
  return [a.type, a.item ?? a.blockName ?? a.entityName ?? a.output ?? a.input ?? a.direction ?? ''].join(':');
}

export function cellOf(o) {
  return `${o.dimension}:${Math.floor(o.position.x / 8)},${Math.floor(o.position.y / 8)},${Math.floor(o.position.z / 8)}`;
}

export function inventoryCounts(o) {
  return Object.fromEntries(o.inventory.map(i => [i.name, i.count]));
}

export function goalsFor(o) {
  const goals = [];
  if (o.health < 18 || o.food < 16 || o.entities.some(e => e.kind === 'hostile' && e.distance < 8))
    goals.push({ id: 'survive', description: 'Restore missing health or hunger, or escape the observed enemy.', kind: 'survive' });
  const resources = [...o.blocks.filter(b => (b.harvestable ?? b.diggable) && b.drops?.length), ...(o.knownResources || [])];
  const names = [...new Set(resources.map(b => b.name))];
  for (const name of names.slice(0, 14)) goals.push({ id: `gather:${name}`, kind: 'gather', target: name,
    drops: resources.find(b => b.name === name)?.drops ?? [],
    description: `Collect ${resources.find(b => b.name === name)?.drops?.join('/') || name}. ${resources.find(b => b.name === name)?.diggable ? 'Within mining reach now.' : 'Approach its observed location first.'} Recipe uses: ${resources.find(b => b.name === name)?.uses?.join(', ') || 'none known'}. Verify inventory pickup.` });
  for (const recipe of o.recipes.slice(0, 64)) goals.push({ id: `craft:${recipe.name}`, kind: 'craft', target: recipe.name,
    description: `Craft ${recipe.name} using available ingredients and reachable crafting facilities.` });
  for (const facility of o.facilities || []) if (facility.owned && !facility.nearby)
    goals.push({ id: `build:${facility.name}`, kind: 'build', target: facility.name,
      description: `Place your ${facility.name} to enable its crafting, processing or storage functions.` });
  goals.push({ id: 'explore', description: names.length ? 'Explore for new resources instead of collecting the visible resources.' : 'Move to new reachable ground or inspect other directions to find resources.', kind: 'explore' });
  return goals;
}

export function goalDone(goal, before, after) {
  if (!goal) return false;
  if (goal.kind === 'survive') return after.health > before.health || after.food > before.food;
  if (goal.kind === 'sleep') return after.sleeping || before.semantics?.daylight==='night' && after.semantics?.daylight==='day';
  if (goal.kind === 'wear') return after.equipment?.[goal.slot]===goal.target;
  if(['till','plant','fertilize','harvest-crop'].includes(goal.kind)) {
    const a=before.blocks.find(b=>JSON.stringify(b.position)===JSON.stringify(goal.position));
    const b=after.blocks.find(b=>JSON.stringify(b.position)===JSON.stringify(goal.position));
    if(goal.kind==='plant') return (after.farm?.crops??[]).some(c=>c.position.x===goal.position.x && c.position.y===goal.position.y+1 && c.position.z===goal.position.z);
    return a?.name!==b?.name || (b?.age??0)>(a?.age??0);
  }
  if (goal.kind === 'shelter') return Boolean(after.shelter?.complete);
  if (goal.kind === 'station') return after.blocks.some(b=>b.name===goal.target && b.distance<=4);
  if (goal.kind === 'explore') return goal.target ? after.entities.some(e=>e.name===goal.target || goal.targets?.includes(e.name)) : cellOf(before) !== cellOf(after);
  if (goal.kind === 'build') {
    const matches=b=>b.name===goal.target || goal.target==='torch' && b.name==='wall_torch';
    return after.blocks.some(matches) && !before.blocks.some(matches);
  }
  const a = inventoryCounts(before), b = inventoryCounts(after);
  if (goal.kind === 'craft') return (b[goal.target] ?? 0) > (a[goal.target] ?? 0);
  if(goal.desiredCount) return (goal.drops??[goal.target]).some(k=>(b[k]??0)>=goal.desiredCount);
  return (goal.drops ?? [goal.target]).some(k => (b[k] ?? 0) > (a[k] ?? 0));
}
