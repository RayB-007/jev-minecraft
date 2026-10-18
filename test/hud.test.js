import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hud } from '../src/hud.js';
test('spectator HUD exports the actual nine hotbar slots and selection, then clears online status',()=>{
 const directory=mkdtempSync(join(tmpdir(),'jev-hud-')),path=join(directory,'hud.json');
 try{
 const bot=new EventEmitter();bot.username='Jev';bot.health=17;bot.food=12;bot.quickBarSlot=2;
 const slots=[];slots[9]={name:'diamond',count:1};slots[38]={name:'wooden_pickaxe',count:1};
 bot.inventory={slots};
 const hud=new Hud({bot,connected:true,ready:true},path);
 const snapshot=JSON.parse(readFileSync(path));
 assert.equal(snapshot.slots.length,9);assert.equal(snapshot.slots[2].name,'wooden_pickaxe');
 assert.equal(snapshot.slots.some(i=>i?.name==='diamond'),false);assert.equal(snapshot.selected,2);
 assert.equal(snapshot.health,17);hud.close();assert.equal(JSON.parse(readFileSync(path)).online,false);
 assert.equal(bot.listenerCount('physicsTick'),0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
