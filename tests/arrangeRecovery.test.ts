import test from 'node:test';
import assert from 'node:assert/strict';
import { bundle, fixture, md } from './helpers/arrangeV2Fixture.ts';

const key = 'gvkit:arrange:v2:fixture:';
const op = (id: string, changes: any, extra: any = {}) => ({schema:2,epoch:'fixture-epoch',id,clock:1,
  parents:[],expected:Object.fromEntries(Object.keys(changes).map(k=>[k,''])),changes,...extra});
const backups = (x: any) => [...x.data].filter(([p]: any)=>p.includes('/recovery/')).map(([,v]: any)=>v);

test('recovery: four targeted production Store contracts', async t => {
  const m=await bundle();
  try {
    await t.test('1 damaged activation/op originals recover exact bytes; bad local activation does not skip outbox',async()=>{
      const x=fixture(m);x.item('healthy');const s=x.store();await s.load();
      const base=x.data.get(m.V2_ACTIVATION)!;
      await s.configure({listFontSize:26});const first=x.ops()[0], path=`${m.V2_ROOT}/ops/${first.id}.md`, raw=x.data.get(path)!;
      const damagedBase=base.slice(0,-8), damagedOp=raw.slice(0,-8);
      x.put(m.V2_ACTIVATION,damagedBase);x.put(path,damagedOp);
      const re=x.store();await re.load();
      assert.equal(x.data.get(m.V2_ACTIVATION),base);assert.equal(x.data.get(path),raw);
      assert.equal(re.state.listFontSize,26);assert.ok(backups(x).includes(damagedBase));assert.ok(backups(x).includes(damagedOp));
      const offline=op('pending-local',{keyboardGap:19});const pending=m.encodeV2(offline);
      x.storage.setItem(key+'op:pending-local',pending);x.storage.setItem(key+'pending:pending-local','1');
      x.storage.setItem(key+'activation','broken local activation');
      const resumed=x.store();await resumed.load();
      assert.equal(resumed.state.keyboardGap,19);assert.equal(resumed.v2.pending,false);
      assert.equal(x.data.get(`${m.V2_ROOT}/ops/pending-local.md`),pending);
      assert.equal(x.storage.getItem(key+'activation'),base);
      assert.ok([...x.storage.data].some(([k,v])=>k.startsWith(key+'recovery:activation:')&&v==='broken local activation'));
      x.storage.setItem(key+'op:'+first.id,'broken local op');
      const localRepair=x.store();await localRepair.load();assert.equal(localRepair.state.listFontSize,26);
      assert.equal(x.storage.getItem(key+'op:'+first.id),raw);
    });
    await t.test('2 legal changed same-ID stays isolated; exact original arriving releases it and dependent ops',async()=>{
      const x=fixture(m);const a=op('a',{listFontSize:22}),raw=m.encodeV2(a),path=`${m.V2_ROOT}/ops/a.md`;
      x.put(path,raw);const s=x.store();await s.load();
      const different=m.encodeV2({...a,changes:{listFontSize:30}});x.put(path,different);
      const child=op('child',{listFontSize:24},{clock:2,parents:['a'],expected:{listFontSize:'a'}});
      x.put(`${m.V2_ROOT}/ops/child.md`,m.encodeV2(child));await s.load();
      assert.equal(x.data.get(path),different);assert.equal(s.v2.projection.applied.has('a'),false);assert.equal(s.v2.projection.deferred.has('child'),true);
      x.put(path,'damaged after competing version');await s.load();
      assert.equal(x.data.get(path),'damaged after competing version');
      const conflictedRestart=x.store();await conflictedRestart.load();assert.equal(x.data.get(path),'damaged after competing version');
      x.put(path,raw);await s.load();assert.equal(s.state.listFontSize,24);assert.equal(s.v2.projection.applied.has('child'),true);
      assert.equal(s.v2.projection.deferred.size,0);
      const restart=x.store();await restart.load();assert.equal(restart.state.listFontSize,24);
    });
    await t.test('3 later new IDs, valid competing bytes during conditional repair, and foreign epochs survive',async()=>{
      const x=fixture(m);const a=op('a',{listFontSize:22}),raw=m.encodeV2(a),path=`${m.V2_ROOT}/ops/a.md`;
      x.put(path,raw);const s=x.store();await s.load();x.put(path,'broken');
      const newer=m.encodeV2(op('new',{keyboardGap:12}));x.put(`${m.V2_ROOT}/ops/new.md`,newer);
      const process=x.vault.process, competing=m.encodeV2({...a,changes:{listFontSize:31}});
      x.vault.process=async(f:any,fn:any)=>{if(f.path===path)x.put(path,competing);return process(f,fn);};
      await s.load();assert.equal(x.data.get(path),competing);assert.equal(s.v2.projection.applied.has('a'),false);
      assert.equal(s.state.keyboardGap,12);assert.equal(x.data.get(`${m.V2_ROOT}/ops/new.md`),newer);
      x.vault.process=process;
      const foreign=m.encodeV2({...a,epoch:'other-epoch'});x.put(path,foreign);await s.load();assert.equal(x.data.get(path),foreign);
      x.storage.setItem(key+'op:foreign',m.encodeV2(op('foreign',{keyboardGap:50},{epoch:'other-epoch'})));
      x.storage.setItem(key+'pending:foreign','1');
      const re=x.store();await re.load();assert.equal(x.entries.has(`${m.V2_ROOT}/ops/foreign.md`),false);assert.equal(re.state.keyboardGap,12);
      const otherBase=m.encodeV2({...m.decodeV2(x.data.get(m.V2_ACTIVATION)),epoch:'different'});
      x.put(m.V2_ACTIVATION,otherBase);await re.load();assert.equal(re.v2.projection,null);assert.equal(x.data.get(m.V2_ACTIVATION),otherBase);
    });
    await t.test('4 locally provable item identity repair preserves later edits; ambiguous damage isolates only dependents and later original returns',async()=>{
      const x=fixture(m),id='01a11111-2222-7333-8444-555555555555',path=`安排/待执行/${id}.md`;
      x.item('parent');x.item(id,{parent:'parent'});x.item('healthy');const s=x.store();await s.load();
      const later=md({gvid:id,gvkit_arrange:true,title:'later title',parent:'parent',date:'2026-12-25',completed_at:null,pinned:true})+'Later body stays exactly.\n';
      const damaged=later.replace('gvid: '+id,'gvid: '+id.slice(0,26));x.put(path,damaged);
      const re=x.store();await re.load();assert.equal(x.data.get(path),later);assert.ok(backups(x).includes(damaged));
      assert.equal(re.items.find((i:any)=>i.id===id).body,'Later body stays exactly.\n');assert.equal(re.isolatedItems.size,0);
      const ambiguous=later.replace('date: 2026-12-25','date: [broken');x.put(path,ambiguous);await re.load();
      assert.equal(x.data.get(path),ambiguous);assert.equal(re.items.some((i:any)=>i.id===id),false);
      await assert.rejects(re.complete('parent',true),/相关事项待确认/);assert.equal(await re.complete('healthy',true),true);
      x.put(path,later);await re.load();assert.equal(re.items.some((i:any)=>i.id===id),true);assert.equal(re.isolatedItems.size,0);
      const unknown='01a99999-2222-7333-8444-555555555555';
      x.put(`安排/待执行/${unknown}.md`,later.replace(id,unknown.slice(0,26)));await re.load();
      assert.equal(re.items.some((i:any)=>i.id===unknown),false);
    });
    await t.test('failed preservation/readback never overwrites damage or reports recovery',async()=>{
      const x=fixture(m);const raw=m.encodeV2(op('a',{listFontSize:22})),path=`${m.V2_ROOT}/ops/a.md`;
      x.put(path,raw);const s=x.store();await s.load();x.put(path,'broken');
      const read=x.vault.read;x.vault.read=async(f:any)=>f.path.includes('/recovery/')?'wrong backup':read(f);
      await s.load();assert.equal(x.data.get(path),'broken');assert.equal(s.v2.projection.applied.has('a'),false);
      x.vault.read=read;await s.load();assert.equal(x.data.get(path),raw);assert.equal(s.v2.projection.applied.has('a'),true);
    });
  } finally {await m.close();delete (globalThis as any).window;}
});
