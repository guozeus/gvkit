import test from 'node:test';
import assert from 'node:assert/strict';
import { bundle, fixture, md, fields } from './helpers/arrangeV2Fixture.ts';

test('v2 production Store paths with isolated Markdown and durable device storage', async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-23T04:00:00Z')});
 const m=await bundle();
 try {
  await t.test('old YAML damage and missing activation never create a second baseline',async()=>{
   const x=fixture(m,{order:['a','b'],listFontSize:25});x.item('a');x.item('b');const s=x.store();await s.load();
   x.put('settings/gvkit/arrange.md','---\norder: [bad\n---\n');await s.configure({keyboardGap:12});
   assert.equal(s.state.listFontSize,25);assert.equal(s.state.keyboardGap,12);assert.equal(x.writes.includes('settings/gvkit/arrange.md'),false);
   x.entries.delete(m.V2_ACTIVATION);const restart=x.store();await restart.load();assert.equal(restart.state.listFontSize,25);
   await restart.complete('a',true);assert.equal(restart.items.find((i:any)=>i.id==='a').completedAt!==null,true);
   const y=fixture(m,{},false);y.item('independent');const fresh=y.store();await fresh.load();assert.ok(fresh.configIssue);
   await fresh.complete('independent',true);await assert.rejects(fresh.configure({listFontSize:22}),/等待同步/);assert.equal(y.entries.has(m.V2_ACTIVATION),false);
  });
  await t.test('ordinary move, top, batch top, pin slots and reload',async()=>{
   const x=fixture(m,{order:['a','p','b','c']});for(const id of ['a','p','b','c'])x.item(id,{pinned:id==='p'});
   const s=x.store();await s.load();await s.move('c');assert.deepEqual(s.state.order,['c','p','a','b']);
   assert.deepEqual(x.ops().at(-1).order.ids,['c']);assert.equal('order' in x.ops().at(-1).changes,false);
   await s.top('p');assert.deepEqual(s.state.order,['p','c','a','b']);
   await s.applyBatch(s.items.filter((i:any)=>['a','b'].includes(i.id)),{kind:'top'});assert.deepEqual(s.state.order,['p','a','b','c']);
   const re=x.store();await re.load();assert.deepEqual(re.state.order,s.state.order);
   await re.complete('a',true);await re.complete('a',false);assert.equal(re.state.order[0],'p');assert.equal(re.state.order[1],'a');
  });
  await t.test('rollover is atomic, reminders no-op writes zero ordering, repeated entry dedupes',async()=>{
   const x=fixture(m,{order:['p','a','b'],dailyGoal:{day:'2026-11-22',id:'b'},specialReminderDay:'2026-11-22'});
   x.item('p',{pinned:true});x.item('a');x.item('b');const s=x.store();await s.enter();
   assert.deepEqual(s.state.order,['b','p','a']);assert.equal(s.state.dailyGoal.returnedId,'b');
   const rollover=x.ops().find((op:any)=>op.automatic?.kind==='rollover');assert.ok(rollover.changes.dailyGoal);assert.equal(rollover.order.kind,'front');
   const reminder=x.ops().find((op:any)=>op.automatic?.kind==='reminder');assert.equal(reminder.order,undefined);
   const count=x.ops().length;await s.enter();assert.equal(x.ops().length,count);
  });
  await t.test('next-day reminder uses normal top order and releases selected pins, preserves other slots and does not run in background',async()=>{
   const x=fixture(m,{order:['B','P','X','A'],specialReminderDay:'2026-11-22'});
   x.item('B',{pinned:true,special_reminder_at:'2026-11-02T00:00:00Z'});x.item('P',{pinned:true});x.item('X');x.item('A',{special_reminder_at:'2026-11-01T00:00:00Z'});
   const s=x.store();await s.load();assert.deepEqual(s.state.order,['B','P','X','A']);await s.enter();assert.deepEqual(s.state.order,['B','P','A','X']);
   assert.deepEqual(x.ops().at(-1).order.ids,['B','A']);
   const restarted=x.store();await restarted.load();assert.deepEqual(restarted.state.order,s.state.order);
   assert.deepEqual(m.applyOrder(['B','P','X','A'],{kind:'top',ids:['A','B'],pins:['B','P']}),['A','P','B','X'],'previously written explicit reminder intent keeps its meaning');
   await s.top('X');const manual=[...s.state.order];await s.enter();assert.deepEqual(s.state.order,manual);
   t.mock.timers.tick(86400000);await s.load();assert.deepEqual(s.state.order,manual);await s.enter();assert.deepEqual(s.state.order,['B','P','A','X']);
   t.mock.timers.setTime(new Date('2026-11-23T04:00:00Z').getTime());
  });
  await t.test('bad child and duplicate identity isolate dependencies; independent completion survives',async()=>{
   const x=fixture(m,{order:['parent','child','healthy','dupe']});x.item('parent');x.item('child',{parent:'parent'});x.item('healthy');x.item('dupe');
   const s=x.store();await s.load();x.put('安排/待执行/child.md','---\ngvkit_arrange: true\ngvid: child\nparent: parent\nbroken: [\n---\n');
   x.put('安排/待执行/duplicate.md',md({gvid:'dupe',gvkit_arrange:true,title:'duplicate',parent:null}));await s.load();
   assert.equal(s.isolatedItems.size,3);assert.equal(s.items.some((i:any)=>i.id==='dupe'),false);
   await assert.rejects(s.complete('parent',true),/相关事项待确认/);assert.equal(await s.complete('healthy',true),true);
   await assert.rejects(s.setAchieved('2026-11-23',true),/部分事项待确认/);
  });
  await t.test('uncertain create recovers exact physical operation after restart',async()=>{
   const x=fixture(m);x.item('a');let fail=true;const create=x.vault.create;
   x.vault.create=async(p:string,s:string)=>{if(fail&&p.includes('/ops/'))throw Error('offline');return create(p,s);};
   const s=x.store();await s.configure({listFontSize:27});assert.equal(s.v2.pending,true);assert.equal(s.state.listFontSize,27);
   const pending=[...x.storage.data].filter(([k])=>k.includes(':op:')).map(([,v])=>m.decodeV2(v).id);
   fail=false;const re=x.store();await re.load();assert.equal(re.v2.pending,false);assert.equal(re.state.listFontSize,27);
   assert.deepEqual(x.ops().map((op:any)=>op.id),pending);await re.load();assert.equal(x.ops().length,1);
  });
  await t.test('repeat completion/undo, reward and parent contracts retain real Markdown facts',async()=>{
   const x=fixture(m,{order:['r','parent','child']});x.item('r',{date:'2026-11-23',repeat:{unit:'day',interval:1,anchor:'2026-11-23'},repeat_instance:'occ-one',reward_points:3});
   x.item('parent');x.item('child',{parent:'parent'});const s=x.store();await s.load();
   await assert.rejects(s.complete('parent',true),/需先完成/);await s.complete('child',true);await s.complete('parent',true);
   await s.complete('r',true);let f=fields(x.data.get('安排/待执行/r.md')!);assert.equal(f.repeat_history.length,1);assert.equal(f.repeat_history[0].reward_awarded,3);
   const occurrence=s.items.find((i:any)=>i.occurrenceId==='occ-one');await s.complete(occurrence.id,false);f=fields(x.data.get('安排/待执行/r.md')!);assert.equal(f.repeat_history.length,0);
  });
 } finally {await m.close();delete (globalThis as any).window;}
});

test('v2 projection convergence and bounded ordering payload',async()=>{
 const m=await bundle();try{
  const base={schema:2,epoch:'e',state:{...m.defaultArrangeState(),order:['a','b','c']},legacy:''};
  const op=(id:string,changes:any={},extra:any={})=>({schema:2,epoch:'e',id,clock:1,parents:[],expected:{},changes,...extra});
  const a=op('a',{listFontSize:24}),b=op('b',{keyboardGap:15}),c=op('c',{listFontSize:26},{clock:2,parents:['a'],expected:{listFontSize:'a'}});
  assert.deepEqual(m.project(base,[c,b,a]).state,m.project(base,[a,b,c]).state);
  assert.equal(m.project(base,[c,b]).state.keyboardGap,15);assert.equal(m.project(base,[c,b]).deferred.has('c'),true);
  assert.equal(m.project(base,[a,{...a,changes:{listFontSize:30}},b]).state.keyboardGap,15);
  assert.equal(m.project(base,[a,{...a,changes:{listFontSize:30}},b]).state.listFontSize,17);
  const auto=op('auto',{dailyGoal:{day:'2026-11-23',id:null,returnedId:'c'}},{expected:{dailyGoal:'',order:''},automatic:{kind:'rollover',day:'2026-11-23'},order:{kind:'front',ids:['c'],pins:[]}});
  const second={...auto,id:'second'};const manual=op('manual',{}, {clock:2,parents:['business:e:rollover:2026-11-23'],expected:{order:'business:e:rollover:2026-11-23'},order:{kind:'move',ids:['b'],pins:[]}});
  assert.deepEqual(m.project(base,[second,manual,auto]).state.order,['b','c','a']);
  const newer=op('new',{dailyGoal:{day:'2026-11-23',id:'a'}},{clock:1});const late={...auto,id:'z-late',clock:5};
  assert.equal(m.project(base,[newer,late]).state.dailyGoal.id,'a');
  const concurrent=op('0-manual',{}, {order:{kind:'move',ids:['b'],pins:[]},expected:{order:''}});
  const nextGoal=op('next',{dailyGoal:{day:'2026-11-23',id:'a'}},{clock:2,parents:['business:e:rollover:2026-11-23'],expected:{dailyGoal:'business:e:rollover:2026-11-23'}});
  const resolved=m.project(base,[auto,nextGoal,concurrent]);assert.equal(resolved.state.dailyGoal.id,'a');assert.equal(resolved.deferred.size,0);assert.deepEqual(resolved.state.order,['b','a','c']);
  const other={...auto,id:'other',changes:{dailyGoal:{day:'2026-11-23',id:null,returnedId:'b'}}};
  const conflict=m.project(base,[auto,other]);assert.equal(conflict.applied.has('other'),false);assert.equal(conflict.conflicts.has('other'),true);
  const many={...base,state:{...base.state,order:Array.from({length:10000},(_,i)=>String(i))}};
  const move=op('move',{}, {order:{kind:'move',ids:['9999'],before:'1',pins:['0']}});
  assert.ok(JSON.stringify(move).length<350);const start=performance.now();const result=m.project(many,[move]);assert.equal(result.state.order[1],'9999');assert.ok(performance.now()-start<1000);
 }finally{await m.close();}
});
