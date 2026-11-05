import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Real Store and reward calculations; disk-backed isolated Vault, same adapter as integration tests.
const shim = `
export class TFile { constructor(path) { this.path=path;this.name=path.split('/').pop();this.basename=this.name.slice(0,-3);this.stat={mtime:Date.now()}; } }
export class TFolder {}
export function getFrontMatterInfo(s) { const end=s.indexOf('\\n---',4);return s.startsWith('---\\n')&&end>=0?{exists:true,frontmatter:s.slice(4,end),contentStart:end+5}:{exists:false,frontmatter:'',contentStart:0}; }
export const parseYaml=JSON.parse;
export const stringifyYaml=v=>JSON.stringify(v,null,2)+'\\n';
`;

test('rewards: actual completion snapshots, zero, original-period correction, undo, reopen, archive and existing facts', async t => {
 const root = await mkdtemp(join(tmpdir(), 'gvkit-rewards-'));
 t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T15:59:00Z') });
 try {
  await build({ stdin: { contents: `export {ArrangeStore} from './src/arrangeStore';export * from './src/arrangeRewards';export {TFile,TFolder} from 'obsidian';`, resolveDir: process.cwd() }, bundle:true, platform:'node', format:'esm', outfile:join(root,'store.mjs'), plugins:[{ name:'vault', setup(b) {
   b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'shim'}));
   b.onLoad({filter:/.*/,namespace:'shim'},()=>({contents:shim,loader:'js'}));
  }}] });
  const { ArrangeStore, TFile, TFolder, rewardTotal, rewardProgress, permanentThreshold } = await import(pathToFileURL(join(root,'store.mjs')).href);
  const entries = new Map<string, any>();
  for (const path of ['安排/待执行','安排/已完成','安排/历史','settings/gvkit']) { entries.set(path,new TFolder());await mkdir(join(root,path),{recursive:true}); }
  const vault = {
   getMarkdownFiles:()=>[...entries.values()].filter(f=>f instanceof TFile),
   getAbstractFileByPath:(path:string)=>entries.get(path)??null,
   read:(f:any)=>readFile(join(root,f.path),'utf8'),
   create:async(path:string,source:string)=>{await writeFile(join(root,path),source);const f=new TFile(path);entries.set(path,f);return f;},
   process:async(f:any,change:(s:string)=>string)=>{await writeFile(join(root,f.path),change(await vault.read(f)));f.stat.mtime=Date.now();},
   createFolder:async(path:string)=>{await mkdir(join(root,path),{recursive:true});entries.set(path,new TFolder());},
  };
  const app={vault,fileManager:{renameFile:async(f:any,path:string)=>{await rename(join(root,f.path),join(root,path));entries.delete(f.path);f.path=path;entries.set(path,f);}}};
  const store=new ArrangeStore(app);
  const legacy=await vault.create('安排/已完成/legacy.md','---\n'+JSON.stringify({gvid:'legacy',gvkit_arrange:true,title:'旧完成',completed_at:'2026-12-31T00:00:00Z'})+'\n---\n');
  await store.load();const legacyBytes=await vault.read(legacy);
  await store.enableRewards();assert.equal(store.rewards.length,0);assert.equal(await vault.read(legacy),legacyBytes);
  await store.setReward('legacy',5);assert.equal(store.rewards.length,0,'editing legacy completed notes never awards retroactively');
  const parent=await store.create('父',null), child=await store.create('细分',parent), zero=await store.create('零分',null);
  await store.setDailyGoal(child);await store.togglePin(zero);
  const before=store.facts(), order=[...store.state.order];
  await store.setReward(zero,0);assert.deepEqual(store.facts(),before);assert.deepEqual(store.state.order,order);
  const device=new ArrangeStore(app);await device.load();assert.equal(device.items.find((i:any)=>i.id===zero).rewardPoints,0);
  assert.equal(device.items.find((i:any)=>i.id===child).rewardPoints,1);
  await assert.rejects(store.complete(parent,true),/下级/);assert.equal(store.rewards.length,0);
  assert.equal(await store.complete(child,true),true);assert.equal(await store.complete(child,true),false);
  assert.deepEqual(store.rewards.map((r:any)=>r.points),[1]);assert.equal(store.facts().x,before.x+1);
  assert.equal(store.state.dailyGoal.id,child);assert.equal(store.items.find((i:any)=>i.id===parent).completedAt,null);
  await store.complete(zero,true);assert.equal(store.facts().x,before.x+2);assert.equal(store.rewards.reduce((s:number,r:any)=>s+r.points,0),1);
  await store.complete(parent,true);assert.equal(store.rewards.reduce((s:number,r:any)=>s+r.points,0),2);
  const at=store.items.find((i:any)=>i.id===child).completedAt;
  t.mock.timers.tick(120000); // next day, month and year in Shanghai, still Dec 31 UTC
  const factsBeforeCorrection=store.facts();
  await store.setReward(child,5);assert.equal(store.rewards.find((r:any)=>r.id===child).completedAt,at);
  assert.equal(rewardTotal(store.rewards,'day','2026-12-31','Asia/Shanghai'),6);
  assert.equal(rewardTotal(store.rewards,'day','2027-01-01','Asia/Shanghai'),0);
  assert.equal(rewardTotal(store.rewards,'month','2026-12-01','Asia/Shanghai'),6);
  assert.equal(rewardTotal(store.rewards,'year','2026-01-01','Asia/Shanghai'),6);
  assert.equal(rewardTotal(store.rewards,'year','2027-01-01','Asia/Shanghai'),0);
  assert.deepEqual(store.facts(),factsBeforeCorrection,'reward corrections do not alter original completion stats');
  await store.complete(child,false);assert.equal(rewardTotal(store.rewards,'permanent','2027-01-01','Asia/Shanghai'),1);
  await store.complete(child,true);assert.equal(rewardTotal(store.rewards,'permanent','2027-01-01','Asia/Shanghai'),6);
  assert.equal(rewardTotal(store.rewards,'day','2027-01-01','Asia/Shanghai'),5);
  const instance=await store.create('另一次真实重复实例',null);await store.complete(instance,true);
  await store.setReward(child,8);assert.equal(store.rewards.find((r:any)=>r.id===instance).points,1);
  await store.setReward(child,0);assert.equal(rewardTotal(store.rewards,'permanent','2027-01-01','Asia/Shanghai'),2);
  await store.setReward(child,8);
  // A rule/field edit outside the explicit correction action must not rewrite earned history.
  const childFile=entries.get(store.items.find((i:any)=>i.id===child).path);
  await vault.process(childFile,s=>s.replace('"reward_points": 8','"reward_points": 2'));
  await device.load();assert.equal(device.rewards.find((r:any)=>r.id===child).points,8);
  await store.archive(child);await device.load();assert.equal(device.rewards.find((r:any)=>r.id===child).points,8);
  assert.equal(device.facts().x,store.facts().x);
  const snapshot=JSON.stringify(device.rewards);await device.load();assert.equal(JSON.stringify(device.rewards),snapshot);
  assert.deepEqual(device.state.dailyGoal,store.state.dailyGoal);
  // Later reload without metadata cache still includes real older reward records.
  t.mock.timers.tick(40*86400000);await device.load();assert.equal(device.rewards.find((r:any)=>r.id===child).points,8);
  // Formula and exact thresholds from the approved effects, not copied implementation assertions.
  assert.equal(rewardProgress(12,'day').fill,.5);assert.equal(rewardProgress(15,'day').fill,.55);
  assert.equal(rewardProgress(18,'day').name,'出色');assert.equal(rewardProgress(42,'week').level,4);
  assert.equal(rewardProgress(42,'week').next,60);assert.equal(rewardProgress(100,'day').fill,1);
  assert.equal(rewardProgress(1280,'permanent').level,28);assert.equal(rewardProgress(1280,'permanent').next,1305);
  assert.equal(rewardProgress(1305,'permanent').level,29);
  for (const [n,p] of [[40,2460],[41,2580],[42,2700],[100,9660],[500,57660]]) {
   assert.equal(permanentThreshold(n),p);assert.equal(rewardProgress(p,'permanent').level,n);
   assert.equal(permanentThreshold(n+1)-p,120);
  }
 } finally {t.mock.timers.reset();await rm(root,{recursive:true,force:true});}
});
