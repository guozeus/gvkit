import assert from 'node:assert/strict';
import test from 'node:test';
import {bundle,fixture,md} from './helpers/arrangeV2Fixture.ts';

test('v2 missing goal dependency isolates goal while independent fields and completions remain usable',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-23T04:00:00Z')});
 const m=await bundle();try{
  const x=fixture(m,{dailyGoal:{day:'2026-11-22',id:'late'},order:['late','healthy'],listFontSize:28});
  x.item('healthy',{reward_points:3});const s=x.store();await s.load();assert.ok(s.goalIssue);
  await s.configure({keyboardGap:18});assert.equal(s.state.listFontSize,28);
  assert.equal(await s.complete('healthy',true),true);assert.equal(s.rewards.find((r:any)=>r.id==='healthy').points,3);
  assert.equal(s.state.dailyGoal.day,'2026-11-22','missing is not implicitly completed');
  x.item('late');await s.load();assert.equal(s.goalIssue,null);assert.equal(s.state.dailyGoal.returnedId,'late');
  assert.equal(s.state.order[0],'late');
  const original=x.data.get('settings/gvkit/arrange.md');
  x.put('settings/gvkit/arrange.md','---\ndailyGoal:\n  id: [\n---\n');await s.configure({keyboardGap:19});assert.equal(s.state.keyboardGap,19);
  assert.notEqual(x.data.get('settings/gvkit/arrange.md'),original,'old broken bytes retained as evidence');
 }finally{await m.close();delete (globalThis as any).window;}
});
