// Controlled adapter verification in a separate Minecraft world. Fixture supplies
// and accelerated crop growth are NOT autonomous gameplay or learning evidence.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,appendFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {Minecraft} from '../src/minecraft.js';
import {Memory} from '../src/memory.js';
import {evaluate} from '../src/evaluation.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const folder=resolve(root,'data/skill-fixtures',new Date().toISOString().replaceAll(':','-'));
mkdirSync(folder,{recursive:true});
assert.match(readFileSync(resolve(root,'server/eula.txt'),'utf8'),/eula=true/);
writeFileSync(resolve(folder,'eula.txt'),'eula=true\n');
writeFileSync(resolve(folder,'server.properties'),[
 'server-ip=127.0.0.1','server-port=25566','online-mode=false','enable-rcon=false','max-players=1',
 'gamemode=survival','difficulty=normal','spawn-protection=0','level-type=minecraft:flat',
 'generate-structures=false','view-distance=3','simulation-distance=3','level-name=fixture'
].join('\n')+'\n');
const server=spawn(process.env.JEV_JAVA??'/usr/bin/java',['-Xms256M','-Xmx1G','-jar',resolve(root,'server/server-1.21.1.jar'),'nogui'],{cwd:folder,stdio:['pipe','pipe','pipe']});
let output='',serverExited=false;
server.on('exit',()=>{serverExited=true;});
for(const stream of [server.stdout,server.stderr]) stream.on('data',data=>{
 const text=String(data);output=(output+text).slice(-20000);appendFileSync(resolve(folder,'server.log'),text);
});
const consoleCommand=command=>server.stdin.write(command+'\n');
const receipt={type:'controlled-skill-fixture',mode:process.argv.includes('--craft-only')?'craft-and-farm':'full',notAnAutonomousBenchmark:true,folder,steps:[],passed:false};
let game,memory;
try {
 console.log('Starting isolated survival skill fixture at 127.0.0.1:25566.');
 const deadline=Date.now()+90000;
 while(!output.includes('Done (')) {
  if(serverExited || Date.now()>deadline) throw new Error('Fixture server failed to start; inspect its server.log');
  await delay(250);
 }
 consoleCommand('gamerule doMobSpawning false');consoleCommand('gamerule doDaylightCycle false');consoleCommand('time set day');
 game=await Minecraft.connect({host:'127.0.0.1',port:25566,username:'JevSkillTest',auth:'offline',version:'1.21.1'});
 memory=new Memory(resolve(folder,'experience.sqlite'));
 game.furnaces.attach(memory,'skill-fixture');game.farming.attach(memory,'skill-fixture');
 for(const [name,n] of [['crafting_table',1],['cobblestone',32],['coal',4],['raw_iron',4],['beef',1],['oak_log',8],['wooden_hoe',1],['carrot',2],['bone_meal',16]])
  consoleCommand(`give JevSkillTest minecraft:${name} ${n}`);
 if(process.argv.includes('--craft-only')) consoleCommand('give JevSkillTest minecraft:iron_ingot 4');
 const waitItems=Date.now()+10000;
 while(!game.bot.inventory.items().some(i=>i.name==='bone_meal')) {if(Date.now()>waitItems) throw new Error('Fixture items did not arrive');await delay(100);}
 await delay(500);
 const bot=game.bot,p=bot.entity.position.floored();
 async function step(action,{pending=false}={}) {
  game.observe();const before=game.observe();
  const result=await game.execute(action);const after=game.observe();
  const evaluation=evaluate(before,after,action,result);
  receipt.steps.push({action,result,evaluation,inventory:after.inventory,craftGrid:bot.inventory.slots.slice(0,5).map(i=>i?{name:i.name,count:i.count}:null),cursor:bot.inventory.selectedItem?{name:bot.inventory.selectedItem.name,count:bot.inventory.selectedItem.count}:null});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.ok(evaluation.success || pending && evaluation.pending,JSON.stringify({action,result,evaluation}));
  console.log(JSON.stringify({action:action.type,item:action.item??action.output,verified:evaluation.success,pending:evaluation.pending}));
  return {result,after};
 }
 async function place(item,position) {
  await bot.lookAt(position.offset(0.5,0.5,0.5),true);game.observe();
  const action=game.placementAt(position,item);assert.ok(action,`No placement for ${item}`);await step(action);
 }
 const table=p.offset(2,0,0),furnace=p.offset(2,0,1);
 await place('crafting_table',table);
 await bot.lookAt(table.offset(0.5,0.5,0.5),true);game.observe();
 await step({type:'craft',item:'furnace'});await place('furnace',furnace);
 async function smelt(input,output) {
  await bot.lookAt(furnace.offset(0.5,0.5,0.5),true);
  await step({type:'smelt',input,output,fuel:'coal',position:furnace},{pending:true});
  const until=Date.now()+25000;
  while(Date.now()<until) {
   const {result}=await step({type:'furnace-check',input,output,position:furnace},{pending:true});
   if(result.outputTaken===output) return;
  }
  throw new Error(`No real furnace output for ${input}`);
 }
 if(!process.argv.includes('--craft-only')) {
  for(let n=0;n<4;n++) await smelt('raw_iron','iron_ingot');
  await smelt('beef','cooked_beef');
 }
 else await game.furnaces.perform({type:'furnace-check',position:furnace},new AbortController().signal);
 const packets=[];const originalWrite=bot._client.write.bind(bot._client);
 bot._client.write=(name,packet)=>{if(name==='window_click') packets.push({direction:'out',name,packet});return originalWrite(name,packet);};
 bot._client.on('packet',(packet,meta)=>{if(['set_slot','window_items'].includes(meta.name)) packets.push({direction:'in',name:meta.name,packet});});
 receipt.inventoryTrace=packets;
 await bot.lookAt(table.offset(0.5,0.5,0.5),true);game.observe();
 for(let n=0;n<3;n++) await step({type:'craft',item:'oak_planks'});
 await step({type:'craft',item:'stick'});await step({type:'craft',item:'iron_pickaxe'});
 await step({type:'craft',item:'shield'});await step({type:'wear',item:'shield',slot:'off-hand'});
 await step({type:'craft',item:'torch'});
 await bot.lookAt(table.offset(0.5,0.5,0.5),true);
 const torchAction=game.actions(game.observe(),{kind:'build',target:'torch'}).find(a=>a.type==='place' && a.face?.y===0);
 assert.ok(torchAction,'No observed wall support for a torch');await step(torchAction);
 const soil=p.offset(-2,-1,0),crop=soil.offset(0,1,0),water=p.offset(-3,-1,1);
 consoleCommand(`setblock ${water.x} ${water.y} ${water.z} minecraft:water`);await delay(300);
 await bot.lookAt(soil.offset(0.5,1,0.5),true);game.observe();
 await step({type:'till',item:'wooden_hoe',position:soil});await step({type:'plant',item:'carrot',position:soil});
 for(let n=0;n<8 && Number(bot.blockAt(crop).getProperties().age)<7;n++) await step({type:'fertilize',item:'bone_meal',position:crop});
 assert.equal(Number(bot.blockAt(crop).getProperties().age),7);
 const carrotsBefore=bot.inventory.items().filter(i=>i.name==='carrot').reduce((n,i)=>n+i.count,0);
 await step({type:'harvest-crop',position:crop});await delay(300);
 for(let n=0;n<4;n++) {
  const o=game.observe(),drop=o.entities.find(e=>e.item==='carrot');if(!drop) break;
  await step({type:'collect',item:'carrot',entityId:drop.id,position:drop.position},{pending:false});
 }
 assert.ok(bot.inventory.items().filter(i=>i.name==='carrot').reduce((n,i)=>n+i.count,0)>carrotsBefore);
 await step({type:'plant',item:'carrot',position:soil});
 receipt.final=game.observe();receipt.passed=true;
 console.log(receipt.mode==='full'?'Verified actual smelting, cooking, iron-tool crafting, shield equipment, and crop replanting in the isolated fixture.':'Verified crafting, shield equipment and farming; smelting was skipped in this debug mode.');
} catch(error) {
 receipt.error=error.stack;console.error(error.stack);process.exitCode=1;
} finally {
 game?.close();memory?.close();
 writeFileSync(resolve(folder,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 writeFileSync(resolve(root,'data/skills-smoke-latest.json'),JSON.stringify({folder,passed:receipt.passed,receipt:resolve(folder,'receipt.json')},null,2)+'\n');
 if(!serverExited) {
  consoleCommand('stop');
  const until=Date.now()+20000;while(!serverExited && Date.now()<until) await delay(100);
  if(!serverExited) server.kill('SIGTERM');
 }
 console.log(`Fixture receipt: ${folder}/receipt.json`);
}
