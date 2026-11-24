import test from 'node:test';
import assert from 'node:assert/strict';
import { bundle, fixture, md, fields } from './helpers/arrangeV2Fixture.ts';
const m=await bundle();
test.after(async()=>{await m.close();delete (globalThis as any).window;});
const series=(x:any)=>x.item('r',{date:'2026-11-24',repeat:{unit:'day',interval:1,anchor:'2026-11-24'},repeat_instance:'occ-1',reward_points:3});

test('reopened explicit edits reach the redone occurrence; future cursor stays intact',async()=>{
 const x=fixture(m);series(x);x.item('parent');const s=x.store();await s.load();await s.complete('r',true);
 const next=fields(x.data.get('安排/待执行/r.md')!).repeat_instance;
 await s.complete('occ-1',false);await s.setReward('r',8);await s.edit('r','edited title','edited body\n','parent');
 await s.complete('r',true);const f=fields(x.data.get('安排/待执行/r.md')!),a=f.repeat_history[0];
 assert.equal(a.title,'edited title');assert.equal(a.body,'edited body\n');assert.equal(a.parent,'parent');assert.equal(a.reward_awarded,8);assert.equal(a.reward_points,8);
 assert.equal(f.date,'2026-11-25');assert.equal(f.repeat_instance,next);assert.equal(f.repeat_reopened.length,0);
});

test('redo without explicit edits retains its historical snapshot and future template',async()=>{
 const x=fixture(m);series(x);const s=x.store();await s.load();await s.complete('r',true);
 await s.setReward('r',8);await s.edit('r','future title','future body\n',null);
 const next=fields(x.data.get('安排/待执行/r.md')!).repeat_instance;
 await s.complete('occ-1',false);await s.complete('r',true);
 const f=fields(x.data.get('安排/待执行/r.md')!),a=f.repeat_history[0];
 assert.equal(a.title,'r');assert.equal(a.body,'');assert.equal(a.reward_awarded,3);
 assert.equal(f.title,'future title');assert.equal(f.reward_points,8);assert.equal(f.repeat_instance,next);assert.equal(f.date,'2026-11-25');
});

test('ordinary completion rejects a date, identity, or completion changed inside final process',async()=>{
 for(const change of [{date:'2026-12-01'}, {gvid:'replacement'}, {completed_at:'2026-11-24T00:01:00Z'}]){
  const x=fixture(m);x.item('normal',{date:'2026-11-24',reward_points:3});const s=x.store();await s.load();
  const process=x.vault.process;let once=true;
  x.vault.process=async(file:any,fn:any)=>{if(once&&file.path==='安排/待执行/normal.md'){once=false; x.put(file.path,md({...fields(x.data.get(file.path)!),...change,reward_points:8})+'later body\n');}return process(file,fn);};
  assert.equal(await s.complete('normal',true),false);const raw=x.data.get('安排/待执行/normal.md')!;
  assert.ok(raw.includes('later body'));assert.equal(fields(raw).reward_awarded,undefined);assert.equal(x.data.has('安排/已完成/normal.md'),false);
 }
});

test('ordinary completion awards the current reward and preserves a concurrent content edit',async()=>{
 const x=fixture(m);x.item('normal',{reward_points:3});const s=x.store();await s.load();const process=x.vault.process;let once=true;
 x.vault.process=async(file:any,fn:any)=>{if(once&&file.path==='安排/待执行/normal.md'){once=false;x.put(file.path,md({...fields(x.data.get(file.path)!),reward_points:8,title:'later title'})+'later body\n');}return process(file,fn);};
 assert.equal(await s.complete('normal',true),true);const raw=x.data.get('安排/已完成/normal.md')!;
 assert.equal(fields(raw).reward_awarded,8);assert.equal(fields(raw).title,'later title');assert.ok(raw.includes('later body'));
 assert.equal(await s.complete('normal',false),true);assert.equal(fields(x.data.get('安排/待执行/normal.md')!).reward_awarded,null);
});

test('duplicate series contributes neither rewards nor archived counts; healthy sources remain',async()=>{
 const x=fixture(m);series(x);x.item('healthy',{reward_points:5});const s=x.store();await s.load();await s.complete('r',true);await s.complete('healthy',true);
 const path='安排/待执行/r.md',f=fields(x.data.get(path)!);f.repeat_history[0].archived=true;x.put(path,md(f));
 await s.load();assert.equal(s.facts().x,2);
 x.put('安排/待执行/duplicate.md',x.data.get(path)!);await s.load();
 assert.equal(s.isolatedItems.size,2);assert.equal(s.items.length,1);assert.equal(s.rewards.length,1);assert.equal(s.rewards[0].points,5);assert.equal(s.facts().x,1);
 x.data.delete('安排/待执行/duplicate.md');x.entries.delete('安排/待执行/duplicate.md');await s.load();assert.equal(s.rewards.length,2);assert.equal(s.facts().x,2);
});

test('duplicate archived sources do not contribute daily goal or completion statistics',async()=>{
 const today=m.dayKey(new Date(),'Asia/Shanghai'),at=new Date().toISOString();
 const x=fixture(m,{dailyGoal:{day:today,id:'arch'}});const source=md({gvid:'arch',gvkit_arrange:true,title:'arch',parent:null,date:null,completed_at:at,reward_completed_at:at,reward_awarded:3});
 const path=`安排/历史/${today.slice(0,4)}/${today.slice(5,7)}/arch.md`;
 x.put(path,source);const s=x.store();await s.load();assert.equal(s.archivedDailyGoalCompletedAt,at);
 x.put('安排/待执行/duplicate.md',source);await s.load();assert.equal(s.archivedDailyGoalCompletedAt,null);assert.equal(s.facts().x,0);assert.equal(s.rewards.length,0);
});

test('failed child creation restores only undo fields while retaining later parent content',async()=>{
 for(const repeat of [false,true]){
  const x=fixture(m);if(repeat)series(x);else x.item('r');const s=x.store();await s.load();await s.complete('r',true);
  const originalPath=repeat?'安排/待执行/r.md':'安排/已完成/r.md';const original=fields(x.data.get(originalPath)!);const create=x.vault.create;
  x.vault.create=async(path:string,raw:string)=>{if(path.startsWith('安排/待执行/')&&!path.endsWith('/r.md')){const p='安排/待执行/r.md';x.put(p,md({...fields(x.data.get(p)!),title:'later parent title'})+'later parent body\n');throw Error('child save failed');}return create(path,raw);};
  await assert.rejects(s.create('child',repeat?'occ-1':'r'),/child save failed/);
  const raw=x.data.get(originalPath)!,f=fields(raw);assert.equal(f.title,'later parent title');assert.ok(raw.includes('later parent body'));
  if(repeat){assert.deepEqual(f.repeat_history,original.repeat_history);assert.equal(f.date,original.date);assert.equal(f.repeat_instance,original.repeat_instance);}else assert.equal(f.completed_at,original.completed_at);
  assert.equal([...x.data.keys()].filter(p=>p.startsWith('安排/待执行/')).length,repeat?1:0);
 }
});

test('failed child creation never overwrites a newer parent completion',async()=>{
 const x=fixture(m);x.item('r');const s=x.store();await s.load();await s.complete('r',true);const create=x.vault.create;
 x.vault.create=async(path:string,raw:string)=>{if(path.startsWith('安排/待执行/')&&!path.endsWith('/r.md')){const p='安排/待执行/r.md';x.put(p,md({...fields(x.data.get(p)!),completed_at:'2026-11-25T00:00:00Z'})+'later parent body\n');throw Error('child save failed');}return create(path,raw);};
 await assert.rejects(s.create('child','r'),/上级状态恢复失败/);const raw=x.data.get('安排/待执行/r.md')!;assert.equal(fields(raw).completed_at,'2026-11-25T00:00:00Z');assert.ok(raw.includes('later parent body'));
});
