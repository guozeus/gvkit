import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Production Store, real temporary Markdown; Vault.process serializes a file as Obsidian does.
const shim=`export class TFile {constructor(path){this.path=path;this.name=path.split('/').pop();this.basename=this.name.slice(0,-3);this.stat={mtime:Date.now()};}} export class TFolder {}
export function getFrontMatterInfo(s){const e=s.indexOf('\\n---',4);return s.startsWith('---\\n')&&e>=0?{exists:true,frontmatter:s.slice(4,e),contentStart:e+5}:{exists:false,frontmatter:'',contentStart:0}}
export const parseYaml=JSON.parse; export const stringifyYaml=v=>JSON.stringify(v,null,2)+'\\n';`;

test('repeat schedules and atomic per-occurrence Markdown completion, rewards, undo, reload and failures',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-12T04:00:00Z')});
 const root=await mkdtemp(join(tmpdir(),'gvkit-repeat-'));
 try {
  await build({stdin:{contents:`export {ArrangeStore} from './src/arrangeStore';export * from './src/arrangeRepeat';export {TFile,TFolder} from 'obsidian';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:join(root,'store.mjs'),plugins:[{name:'obsidian',setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:'shim',namespace:'shim'}));b.onLoad({filter:/.*/,namespace:'shim'},()=>({contents:shim,loader:'js'}));}}]});
  const {ArrangeStore,TFile,TFolder,repeatRule,nextRepeatDate}=await import(pathToFileURL(join(root,'store.mjs')).href);
  for(const [unit,interval,anchor,start,expected] of [
   ['day',1,'2026-12-31','2026-12-31','2027-01-01'],['day',3,'2026-12-30','2026-12-30','2027-01-02'],
   ['week',2,'2026-12-29','2026-12-29','2027-01-12'],['month',1,'2027-01-31','2027-01-31','2027-02-28'],
   ['month',1,'2027-01-31','2027-02-28','2027-03-31'],['month',2,'2026-12-31','2026-12-31','2027-02-28'],
   ['month',2,'2026-12-31','2027-02-28','2027-04-30'],['year',1,'2024-02-29','2027-02-28','2028-02-29'],
   ['year',2,'2024-02-29','2026-02-28','2028-02-29'],
  ] as const) assert.equal(nextRepeatDate(start,repeatRule({unit,interval,anchor})),expected);
  const week=repeatRule({unit:'week',interval:1,anchor:'2026-11-10',weekdays:[2,5]});
  assert.equal(nextRepeatDate('2026-11-10',week),'2026-11-13');assert.equal(nextRepeatDate('2026-11-13',week),'2026-11-17');
  const two=repeatRule({...week,interval:2});assert.equal(nextRepeatDate('2026-11-13',two),'2026-11-24');
  for(const interval of ['',0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>repeatRule({unit:'day',anchor:'2026-11-12',interval}));
  assert.throws(()=>repeatRule({unit:'week',anchor:'2026-11-12',interval:1,weekdays:[]}));
  const entries=new Map<string,any>(),queues=new Map<string,Promise<unknown>>();let fail=false;
  for(const path of ['安排/待执行','安排/已完成','安排/历史','settings/gvkit']) {entries.set(path,new TFolder());await mkdir(join(root,path),{recursive:true});}
  const vault:any={getMarkdownFiles:()=>[...entries.values()].filter(x=>x instanceof TFile),getAbstractFileByPath:(p:string)=>entries.get(p)??null,
   read:(f:any)=>readFile(join(root,f.path),'utf8'),create:async(p:string,s:string)=>{await writeFile(join(root,p),s,{flag:'wx'});const f=new TFile(p);entries.set(p,f);return f;},
   process:(f:any,fn:any)=>{const next=(queues.get(f.path)??Promise.resolve()).then(async()=>{if(fail&&f.path.includes('待执行')){fail=false;throw Error('isolated failure');}const s=fn(await vault.read(f));await writeFile(join(root,f.path),s);return s;});queues.set(f.path,next.catch(()=>{}));return next;}};
  const app={vault,fileManager:{renameFile:async(f:any,path:string)=>{await rename(join(root,f.path),join(root,path));entries.delete(f.path);f.path=path;entries.set(path,f);}}};
  const store=new ArrangeStore(app);await store.load();
  const id=await store.create('每日整理',null,'2026-11-12');await store.setReward(id,3);await store.togglePin(id);
  await store.setRepeat(id,{unit:'day',interval:1,anchor:'2026-11-12'},'2026-11-12');
  const order=[...store.state.order];assert.deepEqual(store.facts().x,0);
  assert.deepEqual(await Promise.all([store.complete(id,true),store.complete(id,true)]),[true,false]);
  let current=store.items.find((x:any)=>x.id===id);assert.equal(current.date,'2026-11-13');assert.equal(current.completedAt,null);assert.equal(current.pinned,true);assert.deepEqual(store.state.order,order);
  assert.equal(store.facts().x,1);assert.equal(store.facts().y,1);assert.equal(store.rewards.reduce((n:number,r:any)=>n+r.points,0),3);
  let first=store.items.find((x:any)=>x.occurrenceOf===id);assert.equal(first.date,'2026-11-12');assert.equal(first.rewardPoints,3);
  const firstId=first.id;const reload=new ArrangeStore(app);await reload.load();assert.equal(reload.facts().x,1);assert.equal(reload.items.find((x:any)=>x.id===id).date,'2026-11-13');
  // Two independent Store consumers of the same disk/Vault cannot complete the same due date twice.
  const outcomes=await Promise.all([store.complete(id,true),reload.complete(id,true)]);assert.equal(outcomes.filter(Boolean).length,1);
  await store.load();assert.equal(store.items.find((x:any)=>x.id===id).date,'2026-11-14');assert.equal(store.rewards.length,2);
  const second=store.items.find((x:any)=>x.occurrenceOf===id&&x.id!==firstId);
  await store.setReward(id,8);assert.equal(store.rewards[0].points,3,'future setting leaves prior awards intact');
  await store.complete(firstId,false);assert.equal(store.facts().x,1);assert.equal(store.rewards.length,1);assert.equal(store.rewards[0].id,second.id);assert.equal(store.items.find((x:any)=>x.id===id).date,'2026-11-12');
  assert.equal(store.items.find((x:any)=>x.id===second.id).completedAt,second.completedAt);
  await store.complete(id,true);assert.equal(store.items.find((x:any)=>x.id===id).date,'2026-11-14');assert.equal(store.rewards.length,2);assert.equal(store.rewards.find((r:any)=>r.id===firstId).points,3);
  // Failed atomic write retains both pending date and history. Retry adds exactly one completion.
  const file=entries.get(current.path),before=await vault.read(file);fail=true;
  await assert.rejects(store.complete(id,true),/isolated failure/);assert.equal(await vault.read(file),before);
  await store.complete(id,true);assert.equal(store.rewards.length,3);assert.equal(store.items.find((x:any)=>x.id===id).date,'2026-11-15');
  // Late completion advances one scheduled interval, retaining the still-overdue next period.
  const late=await store.create('逾期不跳',null,'2026-11-09');await store.setRepeat(late,{unit:'day',interval:1,anchor:'2026-11-09'},'2026-11-09');
  await store.load();assert.equal(store.items.find((x:any)=>x.id===late).date,'2026-11-09');await store.complete(late,true);assert.equal(store.items.find((x:any)=>x.id===late).date,'2026-11-10');
  // Change/disable does not erase history; final completion and undo still target their exact instance.
  const awards=store.rewards.filter((r:any)=>r.id!==store.rewards[store.rewards.length-1].id).length;
  await store.setRepeat(id,null,'2026-11-15');assert.equal(store.items.filter((x:any)=>x.occurrenceOf===id).length,3);
  await store.complete(id,true);assert.equal(store.items.find((x:any)=>x.id===id).completedAt,'2026-11-12T04:00:00.000Z');
  assert.equal(store.items.filter((x:any)=>x.id===id).length,1);assert.equal(store.items.filter((x:any)=>x.occurrenceOf===id).length,4);
  await store.complete(firstId,false);assert.equal(store.items.find((x:any)=>x.id===id).date,'2026-11-12');assert.equal(store.rewards.filter((r:any)=>r.id===second.id).length,1);
  await store.complete(id,true);assert.ok(store.items.find((x:any)=>x.id===id).completedAt);assert.equal(store.rewards.filter((r:any)=>r.id===firstId).length,1);
  const final=new ArrangeStore(app);await final.load();assert.equal(final.rewards.length,5);assert.equal(final.facts().x,5);
  const fields=JSON.parse((await vault.read(file)).split('---\n')[1]);assert.equal(fields.gvid,id);assert.equal(fields.repeat_history.length,4);assert.equal(fields.repeat,null);
  await t.test('F1 no-op rule/date confirmations preserve month/year anchors and cadence',async()=>{
   for(const [unit,interval,anchor,next,nextAfter] of [
    ['month',1,'2027-01-31','2027-02-28','2027-03-31'],['month',2,'2026-12-31','2027-02-28','2027-04-30'],
    ['year',1,'2024-02-29','2025-02-28','2026-02-28'],['year',2,'2024-02-29','2026-02-28','2028-02-29'],
   ] as const) {
    const series=await final.create('F1-'+unit+interval,null,anchor,undefined,{unit,interval,anchor});
    await final.complete(series,true);assert.equal(final.items.find((x:any)=>x.id===series).date,next);
    const f=entries.get(final.items.find((x:any)=>x.id===series).path),before=await vault.read(f);
    await final.setRepeat(series,{unit,interval,anchor:next},next);
    await final.setDate(series,next);assert.equal(await vault.read(f),before,'no-op must preserve the saved anchor and instance');
    await final.complete(series,true);assert.equal(final.items.find((x:any)=>x.id===series).date,nextAfter);
    assert.equal(final.items.find((x:any)=>x.id===series).repeat.anchor,anchor);
    if(unit==='year'&&interval===1){await final.complete(series,true);await final.complete(series,true);assert.equal(final.items.find((x:any)=>x.id===series).date,'2028-02-29');}
   }
  });
  await t.test('F2 editable dates keep independent instance identity, history, awards and same-date concurrency',async()=>{
   const series=await final.create('F2日期与身份',null,'2026-11-12',undefined,{unit:'day',interval:1,anchor:'2026-11-12'});
   await final.setReward(series,3);await final.complete(series,true);
   const old=final.items.find((x:any)=>x.occurrenceOf===series);const pendingId=final.items.find((x:any)=>x.id===series).repeatInstance;
   await final.setDate(old.id,'2026-11-11');await final.setDate(series,'2026-11-12');await final.setReward(series,5);
   assert.equal(final.items.find((x:any)=>x.id===series).repeatInstance,pendingId);
   assert.equal(await final.complete(series,true),true);
   const history=final.items.filter((x:any)=>x.occurrenceOf===series);assert.equal(history.length,2);assert.notEqual(history[0].occurrenceId,history[1].occurrenceId);
   assert.equal(final.items.find((x:any)=>x.id===old.id).date,'2026-11-11');assert.equal(final.rewards.find((x:any)=>x.id===old.occurrenceId).points,3);
   assert.equal(final.items.find((x:any)=>x.id===series).date,'2026-11-13');
   await final.complete(old.id,false);await final.complete(series,true);assert.equal(final.items.find((x:any)=>x.id===series).date,'2026-11-13');
   assert.equal(final.rewards.filter((x:any)=>x.id===old.occurrenceId).length,1);
   // Two undone instances may have the same edited date. Their identities, not date equality, guard a stale competing click.
   const second=final.items.find((x:any)=>x.occurrenceOf===series&&x.occurrenceId!==old.occurrenceId);
   await final.setDate(second.id,'2026-11-11');await final.complete(old.id,false);await final.complete(second.id,false);
   const other=new ArrangeStore(app);await other.load();
   const result=await Promise.all([final.complete(series,true),other.complete(series,true)]);assert.equal(result.filter(Boolean).length,1);
   await final.load();assert.equal(final.items.find((x:any)=>x.id===series).date,'2026-11-11');assert.equal(final.items.filter((x:any)=>x.occurrenceOf===series).length,1);
   await final.complete(series,true);assert.equal(final.items.find((x:any)=>x.id===series).date,'2026-11-13');assert.equal(final.items.filter((x:any)=>x.occurrenceOf===series).length,2);
  });
  await t.test('F3 explicit rule/date/cancel edits replace future resume; unchanged undo preserves it',async()=>{
   const setup=async(name:string)=>{const id=await final.create(name,null,'2026-11-12',undefined,{unit:'day',interval:1,anchor:'2026-11-12'});await final.setReward(id,3);await final.complete(id,true);await final.complete(id,true);return {id,history:final.items.filter((x:any)=>x.occurrenceOf===id),future:final.items.find((x:any)=>x.id===id).repeatInstance};};
   for(const mode of ['unchanged','no-op','week','date','cancel','multiple','multiple-cancel']) {
    const {id,history,future}=await setup('F3-'+mode);await final.complete(history[0].id,false);
    const beforeSecond=final.rewards.find((x:any)=>x.id===history[1].occurrenceId);
    if(mode.startsWith('multiple'))await final.complete(history[1].id,false);
    if(mode==='no-op')await final.setRepeat(id,{unit:'day',interval:1,anchor:'2026-11-12'},'2026-11-12');
    if(mode==='week'||mode==='multiple')await final.setRepeat(id,{unit:'week',interval:1,anchor:'2026-11-12',weekdays:[4]},'2026-11-12');
    if(mode==='date')await final.setDate(id,'2026-11-18');
    if(mode==='cancel'||mode==='multiple-cancel')await final.setRepeat(id,null,'2026-11-12');
    await final.complete(id,true);
    if(mode.startsWith('multiple')){assert.equal(final.items.find((x:any)=>x.id===id).date,'2026-11-13');assert.equal(final.items.find((x:any)=>x.id===id).reopened,true);await final.complete(id,true);}
    const current=final.items.find((x:any)=>x.id===id);
    if(mode.includes('cancel')) assert.ok(current.completedAt,'no old future cursor revives after cancel');
    else {assert.equal(current.date,mode==='week'||mode==='multiple'?'2026-11-19':mode==='date'?'2026-11-19':'2026-11-14');assert.equal(current.repeatInstance,future,'explicit rescheduling keeps that independent future instance stable');}
    assert.deepEqual(final.rewards.find((x:any)=>x.id===history[1].occurrenceId),beforeSecond,'other completion award remains exactly unchanged');
   }
   // Failed explicit reschedule commits neither rule, date, instance nor resume; retry is one coherent edit.
   const {id,history}=await setup('F3保存失败');await final.complete(history[0].id,false);const f=entries.get(final.items.find((x:any)=>x.id===id).path),before=await vault.read(f);fail=true;
   await assert.rejects(final.setDate(id,'2026-11-18'),/isolated failure/);assert.equal(await vault.read(f),before);await final.setDate(id,'2026-11-18');await final.complete(id,true);assert.equal(final.items.find((x:any)=>x.id===id).date,'2026-11-19');
   // The existing daily-goal date entry obeys the same explicit reschedule behavior.
   t.mock.timers.setTime(Date.parse('2026-11-11T04:00:00Z'));const prior=await final.create('F3日目标入口',null,'2026-11-09',undefined,{unit:'day',interval:1,anchor:'2026-11-09'});await final.complete(prior,true);await final.complete(prior,true);
   const first=final.items.find((x:any)=>x.occurrenceOf===prior);t.mock.timers.setTime(Date.parse('2026-11-12T04:00:00Z'));await final.complete(first.id,false);await final.setDailyGoal(prior);assert.equal(final.items.find((x:any)=>x.id===prior).date,'2026-11-12');await final.complete(prior,true);assert.equal(final.items.find((x:any)=>x.id===prior).date,'2026-11-13');
  });
  // Local day rollover changes the due view, never the unfinished scheduled date.
  const daily=await final.create('日界',null,'2026-11-12',undefined,{unit:'day',interval:1,anchor:'2026-11-12'});
  await final.setDailyGoal(daily);await final.complete(daily,true);
  await final.setDailyGoal(daily);assert.equal(final.items.find((x:any)=>x.id===daily).date,'2026-11-13','choosing today completed goal does not rewind its next period');
  const originalOrder=[...final.state.order];
  t.mock.timers.setTime(Date.parse('2026-11-12T16:00:00Z'));
  const tomorrow=new ArrangeStore(app);await tomorrow.load();assert.equal(tomorrow.facts().day,'2026-11-13');
  assert.equal(tomorrow.facts().x,0);assert.ok(tomorrow.facts().remaining>=1);
  assert.equal(tomorrow.items.find((x:any)=>x.id===daily).date,'2026-11-13');
  assert.equal(tomorrow.state.dailyGoal,null,'a completed repeating goal does not return as yesterday unfinished');
  assert.deepEqual(tomorrow.state.order,originalOrder);
  t.mock.timers.setTime(Date.parse('2026-11-15T16:00:00Z'));
  await tomorrow.load();assert.equal(tomorrow.items.find((x:any)=>x.id===daily).date,'2026-11-13','missed days stay overdue');
 } finally {await rm(root,{recursive:true,force:true});}
});
