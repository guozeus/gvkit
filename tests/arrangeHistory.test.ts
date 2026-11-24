import test from 'node:test';
import assert from 'node:assert/strict';
import { bundle, fixture, md } from './helpers/arrangeV2Fixture.ts';

const op = (id: string, changes: any, extra: any = {}) => ({schema:2,epoch:'fixture-epoch',id,clock:1,
  parents:[],expected:Object.fromEntries(Object.keys(changes).map(k=>[k,''])),changes,...extra});
function host(x: any, versions: Map<string,string[]>, remote?: any) {
  const reads: string[]=[];
  const recovery={db:{transaction:(table:string,mode:string)=>{
    assert.equal(table,'backups');assert.equal(mode,'readonly');
    return {store:{index:(index:string)=>{assert.equal(index,'path');return {getAll:async(path:string)=>{
      reads.push(path);return (versions.get(path)??[]).map((data,ts)=>({path,ts,data}));
    }};}}};
  }}};
  x.app.internalPlugins={getEnabledPluginById:(id:string)=>id==='file-recovery'?recovery:remote};
  return reads;
}
const flush = async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
function remote(versions:Map<string,string[]>) {
  const reads:string[]=[],pulls:(string|number)[]=[];
  const contents=new Map<string,string>();
  const sync:any={vaultId:'fixture-remote',ready:true,pause:false,server:{isConnected:()=>true},
    getHistory:async(path:string,last:any)=>{
      assert.equal(last,null);reads.push(path);
      const items=(versions.get(path)??[]).map((data,i)=>{const uid=path+':'+i;contents.set(uid,data);return {uid,path,deleted:false,relatedpath:''};});
      return {items,more:false};
    },getContentForVersion:async(uid:string)=>{pulls.push(uid);return new TextEncoder().encode(contents.get(uid)!).buffer;}};
  return {sync,reads,pulls};
}

test('existing host histories recover only provable originals through production Store',async t=>{
  const m=await bundle();
  try {
    await t.test('only File Recovery holds activation and op originals; healthy reads never query history',async()=>{
      const x=fixture(m),base=x.data.get(m.V2_ACTIVATION)!,path=`${m.V2_ROOT}/ops/a.md`,raw=m.encodeV2(op('a',{listFontSize:28}));
      x.put(m.V2_ACTIVATION,base.slice(0,-5));x.put(path,raw.slice(0,-5));x.item('healthy');
      const reads=host(x,new Map([[m.V2_ACTIVATION,[base,base]],[path,[raw,'broken snapshot']]]));
      const s=x.store();await s.load();assert.equal(s.state.listFontSize,28);
      assert.equal(x.data.get(m.V2_ACTIVATION),base);assert.equal(x.data.get(path),raw);
      assert.deepEqual(reads,[m.V2_ACTIVATION,path]);await s.load();await s.complete('healthy',true);assert.equal(reads.length,2);
      assert.equal([...x.data.keys()].filter(p=>p.includes('/recovery/')).length,2);
    });
    await t.test('historical same-ID different legal bytes remain ambiguous, hot reads dedupe, later legal original returns',async()=>{
      const x=fixture(m),path=`${m.V2_ROOT}/ops/a.md`,a=op('a',{listFontSize:22}),raw=m.encodeV2(a);
      const other=m.encodeV2({...a,changes:{listFontSize:30}});
      x.put(path,'damaged');const reads=host(x,new Map([[path,[raw,other]]]));const s=x.store();await s.load();await s.load();await s.load();
      assert.equal(x.data.get(path),'damaged');assert.deepEqual(reads,[path]);assert.equal(s.v2.projection.applied.has('a'),false);
      x.put(path,other);await s.load();assert.equal(s.state.listFontSize,30);assert.deepEqual(reads,[path]);
      const wrong=`${m.V2_ROOT}/ops/wrong.md`;x.put(wrong,'damaged');
      host(x,new Map([[wrong,[raw]]]));await s.load();assert.equal(x.data.get(wrong),'damaged');
    });
    await t.test('item history proves stable identity only; all later mutable text stays byte-for-byte',async()=>{
      const x=fixture(m),id='01a11111-2222-7333-8444-555555555555',path=`安排/待执行/${id}.md`;
      const old=md({gvid:id,gvkit_arrange:true,title:'old',parent:null,date:null})+'old body\n';
      const current=md({gvid:id,gvkit_arrange:true,title:'new',parent:'new-parent',date:'2026-12-01',reward_points:7})+'new body\n';
      x.put(path,current.replace(id,id.slice(0,26)));const reads=host(x,new Map([[path,[old,current]]]));
      const s=x.store();await s.load();assert.equal(x.data.get(path),current);assert.equal(s.items.find((i:any)=>i.id===id).title,'new');assert.deepEqual(reads,[path]);
      const broken=current.replace('date: 2026-12-01','date: broken');x.put(path,broken);await s.load();assert.equal(x.data.get(path),broken);
      assert.equal(s.items.some((i:any)=>i.id===id),false);
      x.put(path,current);await s.load();assert.equal(s.items.some((i:any)=>i.id===id),true);
    });
    await t.test('connected Sync is a nonblocking fallback; healthy completion and later new IDs remain usable',async()=>{
      const x=fixture(m),path=`${m.V2_ROOT}/ops/a.md`,raw=m.encodeV2(op('a',{listFontSize:29}));x.put(path,'broken');x.item('healthy');
      const remoteHost=remote(new Map([[path,[raw,raw]]])),getHistory=remoteHost.sync.getHistory;
      let resume!:()=>void;const wait=new Promise<void>(resolve=>resume=resolve);
      remoteHost.sync.getHistory=async(...args:any[])=>{await wait;return getHistory(...args);};
      host(x,new Map(),remoteHost.sync);const s=x.store();await s.load();
      assert.equal(s.items.some((i:any)=>i.id==='healthy'),true);assert.equal(x.data.get(path),'broken');
      assert.equal(await s.complete('healthy',true),true);
      const newPath=`${m.V2_ROOT}/ops/new.md`,newRaw=m.encodeV2(op('new',{keyboardGap:15}));x.put(newPath,newRaw);
      resume();await flush();assert.equal(x.data.get(path),raw);await s.load();assert.equal(s.state.listFontSize,29);assert.equal(s.state.keyboardGap,15);
      assert.equal(x.data.get(newPath),newRaw);assert.deepEqual(remoteHost.reads,[path]);
    });
    await t.test('Sync ambiguity, incomplete pages, rename/delete and offline never select a snapshot',async()=>{
      for(const mode of ['ambiguous','paged','renamed','deleted','offline','disconnect']) {
        const x=fixture(m),path=`${m.V2_ROOT}/ops/a.md`,a=op('a',{listFontSize:22}),raw=m.encodeV2(a);
        const remoteHost=remote(new Map([[path,mode==='ambiguous'?[raw,m.encodeV2({...a,changes:{listFontSize:30}})]:[raw]]]));
        const getHistory=remoteHost.sync.getHistory;
        remoteHost.sync.getHistory=async(...args:any[])=>{const result=await getHistory(...args);
          if(mode==='paged')result.more=true;if(mode==='renamed')result.items[0].relatedpath='old.md';if(mode==='deleted')result.items[0].deleted=true;
          if(mode==='disconnect')remoteHost.sync.ready=false;return result;};
        if(mode==='offline')remoteHost.sync.server.isConnected=()=>false;
        x.put(path,'broken');host(x,new Map(),remoteHost.sync);const s=x.store();await s.load();await flush();await s.load();
        assert.equal(x.data.get(path),'broken',mode);assert.equal(s.v2.projection.applied.has('a'),false,mode);
        assert.ok(remoteHost.reads.length<=1,mode);if(mode!=='ambiguous')assert.equal(remoteHost.pulls.length,0,mode);
      }
    });
    await t.test('same server temporary failure and same local provider not-ready retry after cooldown, with in-flight dedupe',async t=>{
      t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
      for (const mode of ['remote-error','remote-disconnect','local-not-ready']) {
        const x=fixture(m),path=`${m.V2_ROOT}/ops/a.md`,raw=m.encodeV2(op('a',{listFontSize:23}));x.put(path,'broken');
        const r=remote(new Map([[path,[raw]]]));let calls=0;
        const original=r.sync.getHistory;
        r.sync.getHistory=async(...args:any[])=>{
          calls++;
          if(calls===1&&mode==='remote-error')throw Error('temporary');
          const result=await original(...args);if(calls===1&&mode==='remote-disconnect')r.sync.ready=false;
          return result;
        };
        let localCalls=0;
        const recovery:any={};
        const database={transaction:()=>({store:{index:()=>({getAll:async()=>{localCalls++;return [{path,ts:1,data:raw}];}})}})};
        x.app.internalPlugins={getEnabledPluginById:(id:string)=>id==='sync'?(mode==='local-not-ready'?undefined:r.sync):recovery};
        const s=x.store();await s.load();await flush();assert.equal(x.data.get(path),'broken',mode);
        r.sync.ready=true;if(mode==='local-not-ready')recovery.db=database;
        await s.load();await s.load();assert.equal(x.data.get(path),'broken',mode);
        assert.equal(calls,mode==='local-not-ready'?0:1,mode);assert.equal(localCalls,0);
        t.mock.timers.tick(60_001);
        await s.load();await flush();await s.load();assert.equal(x.data.get(path),raw,mode);assert.equal(s.state.listFontSize,23);
        assert.equal(calls,mode==='local-not-ready'?0:2,mode);assert.equal(localCalls,mode==='local-not-ready'?1:0,mode);
      }
      const x=fixture(m),path=`${m.V2_ROOT}/ops/a.md`,raw=m.encodeV2(op('a',{listFontSize:23}));x.put(path,'broken');
      const r=remote(new Map([[path,[raw]]]));let release!:()=>void,calls=0;const waiting=new Promise<void>(resolve=>release=resolve),get=r.sync.getHistory;
      r.sync.getHistory=async(...args:any[])=>{calls++;await waiting;return get(...args);};host(x,new Map(),r.sync);
      const s=x.store();await s.load();t.mock.timers.tick(120_000);await s.load();await s.load();assert.equal(calls,1);
      release();await flush();assert.equal(x.data.get(path),raw);
    });
    await t.test('online result cannot overwrite a later legal current value; local ambiguity also survives online history',async()=>{
      for(const localConflict of [false,true]) {
        const x=fixture(m),path=`${m.V2_ROOT}/ops/a.md`,a=op('a',{listFontSize:22}),raw=m.encodeV2(a),later=m.encodeV2({...a,changes:{listFontSize:30}});
        const remoteHost=remote(new Map([[path,[raw]]]));const getContent=remoteHost.sync.getContentForVersion;
        remoteHost.sync.getContentForVersion=async(uid:string)=>{if(!localConflict)x.put(path,later);return getContent(uid);};
        x.put(path,'broken');host(x,new Map(localConflict?[[path,[raw,later]]]:[]),remoteHost.sync);
        const s=x.store();await s.load();await flush();assert.equal(x.data.get(path),localConflict?'broken':later);
        await s.load();if(!localConflict)assert.equal(s.state.listFontSize,30);
      }
    });
  } finally {await m.close();delete (globalThis as any).window;}
});
