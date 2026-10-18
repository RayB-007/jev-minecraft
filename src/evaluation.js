import { inventoryCounts } from './state.js';

export const REWARD_VERSION = 'v4-verified-skills';

export function evaluate(before, after, action, result, novel = false) {
  const a = inventoryCounts(before), b = inventoryCounts(after);
  const gains = Object.entries(b).filter(([k, n]) => n > (a[k] ?? 0)).map(([item, n]) => ({ item, count: n - (a[item] ?? 0) }));
  const health = after.health - before.health, food = after.food - before.food;
  const death = after.deaths > before.deaths;
  const moved = Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z) > 0.35;
  const target = action.position && after.blocks.find(b => b.position.x === action.position.x && b.position.y === action.position.y && b.position.z === action.position.z);
  let success = false;
  if (result.ok && !death) {
    if (['move', 'jump', 'navigate', 'approach'].includes(action.type)) success = moved && result.pathStatus!=='noPath';
    if (action.type === 'collect') success = gains.some(g => !action.item || g.item === action.item);
    if (action.type === 'look') success = Math.abs(after.yaw - before.yaw) > 0.01 || Math.abs((after.pitch ?? 0) - (before.pitch ?? 0)) > 0.01;
    if (action.type === 'dig') success = result.blockChanged === true;
    if (action.type === 'harvest') success = result.blockChanged === true;
    if (['till','plant','fertilize','harvest-crop'].includes(action.type)) success=result.blockChanged===true;
    if (action.type === 'craft') success = result.inventoryConserved!==false && (b[action.item] ?? 0) > (a[action.item] ?? 0);
    if (action.type === 'eat') success = food > 0;
    if (action.type === 'equip') success = after.heldItem === action.item;
    if (action.type === 'wear') success = after.equipment?.[action.slot]===action.item && before.equipment?.[action.slot]!==action.item;
    if (['smelt','furnace-check'].includes(action.type)) success = gains.some(g=>g.item===action.output) ||
      action.type==='smelt' && (result.inputInserted && (a[action.input]??0)>(b[action.input]??0) || result.fuelInserted && (a[action.fuel]??0)>(b[action.fuel]??0));
    if (action.type === 'place') success = result.blockChanged === true;
    if (action.type === 'attack') success = result.hitObserved === true;
    if (action.type === 'interact') success = result.windowOpened === true;
    if (action.type === 'wait') success = true;
    if (action.type === 'sleep') success = result.sleepStarted === true;
  }
  // New item types are rewarded only once per run (the agent passes credited gains).
  // No positive reward for simply issuing a command, moving in circles, or model self-evaluation.
  const newItems = gains.filter(g => !before.creditedItems?.includes(g.item));
  const pending=Boolean(result.ok && result.processing && !success && !death);
  const reward = Math.max(-20, Math.min(10,
    health * 0.6 + Math.max(0, food) * 0.3 + (result.inventoryConserved===false ? -3 : Math.min(3, newItems.length)) +
    (novel ? 0.02 : 0) + Math.min(2, Math.max(0, (after.recipes?.length ?? 0) - (before.recipes?.length ?? 0)) * 0.15) -
    (death ? 20 : 0) - (!success && !pending ? 0.8 : 0) - (action.type === 'wait' ? 0.6 : 0.03)));
  const productive = success && (['dig', 'harvest', 'craft', 'collect', 'place', 'eat', 'sleep','till','plant','fertilize','harvest-crop'].includes(action.type) ||
    ['smelt','furnace-check'].includes(action.type) && gains.some(g=>g.item===action.output));
  return { reward, success, pending,productive, death, rewardVersion: REWARD_VERSION,
    changes: { gains, newItems, health, food, novel, moved, targetStillVisible: Boolean(target) } };
}
