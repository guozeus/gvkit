import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { bundle, fixture } from './helpers/arrangeV2Fixture.ts';

const op = (id: string, changes: Record<string, unknown>, extra: any = {}) => ({schema:2, epoch:'fixture-epoch', id, clock:1,
  parents:[], expected:Object.fromEntries(Object.keys(changes).map(k=>[k,''])), changes, ...extra});
const write = (m:any, x:any, value:any) => x.put(`${m.V2_ROOT}/ops/${value.id}.md`,m.encodeV2(m.operation(value)));

test('conflicting fields remain provisional until an explicit observed confirmation', async t => {
  const m=await bundle();
  try {
    await t.test('same-field conflict refuses overwrite and dependent write; independent fields merge',()=>{
      const base={schema:2,epoch:'fixture-epoch',state:m.defaultArrangeState(),legacy:''};
      const a=op('a',{listFontSize:14}), b=op('b',{listFontSize:21}), gap=op('gap',{keyboardGap:12});
      const c=op('c',{listFontSize:25},{clock:2,parents:['a'],expected:{listFontSize:'a'}});
      const snapshot=JSON.stringify([a,b,c,gap]);
      const p=m.project(base,[a,b,c,gap]), shuffled=m.project(base,[gap,c,b,a]);
      assert.equal(p.state.listFontSize,14);assert.equal(p.state.keyboardGap,12);
      assert.equal(p.applied.has('a'),true);assert.equal(p.applied.has('b'),false);assert.equal(p.applied.has('c'),false);
      assert.deepEqual(p.pending.get('listFontSize'),['a','b','c']);assert.equal(p.pending.has('keyboardGap'),false);
      assert.deepEqual(shuffled.state,p.state);assert.deepEqual(shuffled.pending,p.pending);
      const confirm=op('resolve',{listFontSize:21},{clock:3,parents:['a'],expected:{listFontSize:'a'},resolves:{listFontSize:['a','b','c']}});
      const next=op('next',{listFontSize:23},{clock:4,parents:['resolve'],expected:{listFontSize:'resolve'}});
      const fixed=m.project(base,[next,gap,c,confirm,b,a]);
      assert.equal(fixed.state.listFontSize,23);assert.equal(fixed.pending.size,0);assert.equal(fixed.conflicts.has('listFontSize'),false);
      assert.equal(fixed.applied.has('b'),false);assert.equal(fixed.applied.has('resolve'),true);
      assert.equal(JSON.stringify([a,b,c,gap]),snapshot);
      const missing=m.project(base,[confirm,a]);assert.equal(missing.deferred.has('resolve'),true);
      const concurrent=op('resolve2',{listFontSize:30},{clock:3,parents:['a'],expected:{listFontSize:'a'},resolves:{listFontSize:['a','b','c']}});
      const two=m.project(base,[a,b,c,confirm,concurrent]);assert.equal(two.state.listFontSize,21);assert.equal(two.applied.has('resolve2'),false);assert.ok(two.pending.has('listFontSize'));
    });
    await t.test('production Store preserves both originals, resolves after restart, and rejects stale confirmation',async()=>{
      const x=fixture(m);x.item('healthy');const a=op('a',{listFontSize:14}),b=op('b',{listFontSize:21});write(m,x,a);write(m,x,b);
      const originalA=x.data.get(`${m.V2_ROOT}/ops/a.md`),originalB=x.data.get(`${m.V2_ROOT}/ops/b.md`);
      const s=x.store();await s.load();assert.equal(s.hasConfigConflict('listFontSize'),true);
      await assert.rejects(s.configure({listFontSize:30}),/待确认/);assert.equal(s.state.listFontSize,14);
      await s.configure({keyboardGap:13});assert.equal(s.state.keyboardGap,13);await s.complete('healthy',true);
      assert.equal(s.items.find((i:any)=>i.id==='healthy').completedAt!==null,true);
      const ids=[...s.v2.projection.pending.get('listFontSize')];
      write(m,x,op('c',{listFontSize:26}));await assert.rejects(s.resolveConfigConflict('listFontSize',ids,'b'),/已变化/);
      const current=[...s.v2.projection.pending.get('listFontSize')];
      const restarted=x.store();await restarted.load();assert.deepEqual(restarted.v2.projection.pending.get('listFontSize'),current);
      await restarted.resolveConfigConflict('listFontSize',current,'b');assert.equal(restarted.state.listFontSize,21);assert.equal(restarted.hasConfigConflict('listFontSize'),false);
      const re=x.store();await re.load();assert.equal(re.state.listFontSize,21);assert.equal(re.v2.projection.pending.size,0);
      assert.equal(x.data.get(`${m.V2_ROOT}/ops/a.md`),originalA);assert.equal(x.data.get(`${m.V2_ROOT}/ops/b.md`),originalB);
      assert.equal(x.writes.includes(m.V2_ACTIVATION),false);assert.equal(x.writes.includes('settings/gvkit/arrange.md'),false);
    });
    await t.test('goal conflict defers rollover and reminder without blocking independent completion',async()=>{
      const x=fixture(m,{order:['a','b','healthy'],specialReminderDay:'2000-01-01'});for(const id of ['a','b','healthy'])x.item(id);
      write(m,x,op('goal-a',{dailyGoal:{day:'2000-01-01',id:'a'}}));write(m,x,op('goal-b',{dailyGoal:{day:'2000-01-01',id:'b'}}));
      const s=x.store();await s.enter();assert.ok(s.goalIssue);assert.equal(x.ops().length,2);
      await assert.rejects(s.setDailyGoal('healthy'),/待确认/);await assert.rejects(s.setAchieved('2026-11-24',true),/待确认/);
      assert.equal(await s.complete('healthy',true),true);assert.ok(s.hasConfigConflict('dailyGoal'));
      await s.resolveConfigConflict('dailyGoal',[...s.v2.projection.pending.get('dailyGoal')],'goal-b');
      assert.equal(s.hasConfigConflict('dailyGoal'),false);assert.equal(s.state.dailyGoal.returnedId,'b');
    });
    await t.test('order conflict leaves normal completion usable and explicit keep-current resolves it',async()=>{
      const x=fixture(m,{order:['a','p','b'],dailyGoal:null});x.item('a');x.item('p',{pinned:true});x.item('b');
      const order=(id:string,target:string)=>op(id,{}, {expected:{order:''},order:{kind:'move',ids:[target],pins:['p']}});
      write(m,x,order('move-a','b'));write(m,x,order('move-b','a'));const s=x.store();await s.load();
      assert.equal(s.hasConfigConflict('order'),true);assert.equal(s.state.order[1],'p');
      assert.equal(await s.complete('a',true),true);
      await s.resolveConfigConflict('order',[...s.v2.projection.pending.get('order')]);assert.equal(s.hasConfigConflict('order'),false);
    });
    await t.test('production confirmation dialog names the conflict, chooses 21 and disappears after reload',async()=>{
      const x=fixture(m);write(m,x,op('a',{listFontSize:14}));write(m,x,op('b',{listFontSize:21}));
      const s=x.store();await s.load();const win=new Window(), saved=globalThis.document;globalThis.document=win.document as any;
      const proto=win.HTMLElement.prototype as any;
      proto.createEl=function(tag:string,options:any={}) {const el=win.document.createElement(tag);el.textContent=options.text??'';el.className=options.cls??'';for(const [k,v] of Object.entries(options.attr??{}))el.setAttribute(k,String(v));this.append(el);return el;};
      try {
        const result=await build({entryPoints:['src/arrangeConflictView.ts'],bundle:true,platform:'node',format:'cjs',write:false,
          plugins:[{name:'ui',setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'ui'}));b.onLoad({filter:/.*/,namespace:'ui'},()=>({contents:`
export class Modal {constructor(){this.contentEl=document.createElement('section')}setTitle(t){this.contentEl.createEl('h2',{text:t})}open(){document.body.append(this.contentEl)}close(){this.contentEl.remove()}}
export class Notice {constructor(t){document.body.createEl('aside',{text:t})}}`,loader:'js'}));}}]});
        const mod:any={exports:{}};new Function('module','exports','require',result.outputFiles[0]!.text)(mod,mod.exports,createRequire(import.meta.url));
        let changed=0;mod.exports.showConfigConflict(x.app,s,()=>changed++);
        assert.equal(win.document.querySelector('h2')!.textContent,'列表标题字号待确认');
        const buttons=[...win.document.querySelectorAll('button')];assert.deepEqual(buttons.map(b=>b.textContent),['保留当前：14','采用：21']);
        await (buttons[1] as any).onclick();assert.equal(changed,1);assert.equal(s.state.listFontSize,21);
        assert.equal(win.document.querySelectorAll('section').length,0);assert.equal(win.document.querySelector('aside')!.textContent,'已确认');
        mod.exports.showConfigConflict(x.app,s,()=>changed++);assert.equal(win.document.querySelectorAll('section').length,0);
      } finally {globalThis.document=saved;await win.happyDOM.close();}
    });
  } finally {await m.close();delete (globalThis as any).window;}
});
