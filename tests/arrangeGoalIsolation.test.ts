import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

const id = (n: number) => '019b0000-0000-7000-8000-' + String(n).padStart(12, '0');
const truncated = '019b0000-0000-700';
const md = (fields: any) => '---\n' + stringify(fields) + '---\n';
const fields = (source: string) => parse(source.slice(4, source.indexOf('\n---', 4)));
const shim = [
  "import {parse,stringify} from 'yaml';",
  "export class TFile {constructor(path){this.path=path;this.name=path.split('/').pop();this.basename=this.name.slice(0,-3);this.stat={mtime:0,size:0}}}",
  "export class TFolder {}",
  "export function getFrontMatterInfo(s){const end=s.indexOf('\\n---',4);return s.startsWith('---\\n')&&end>=0?{exists:true,frontmatter:s.slice(4,end),contentStart:end+5}:{exists:false,frontmatter:'',contentStart:0}}",
  "export const parseYaml=parse;export const stringifyYaml=stringify;"
].join('\n');

test('unconfirmed returned target is isolated while ordinary operations keep real state', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-19T04:00:00Z') });
  const dir = await mkdtemp(join(tmpdir(), 'gvkit-goal-isolation-'));
  try {
    await build({stdin:{contents:"export {ArrangeStore} from './src/arrangeStore';export {TFile,TFolder} from 'obsidian';",resolveDir:process.cwd()},
      bundle:true,platform:'node',format:'cjs',outfile:join(dir,'store.cjs'),
      plugins:[{name:'isolated-yaml',setup(b){
        b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'fixture'}));
        b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:shim,loader:'js',resolveDir:process.cwd()}));
      }}]});
    const {ArrangeStore,TFile,TFolder}=(await import(pathToFileURL(join(dir,'store.cjs')).href)).default;
    const fixture=(goal:any={day:'2026-11-19',id:null,returnedId:truncated})=>{
      const entries=new Map<string,any>(),data=new Map<string,string>();
      let writes=0;
      for(const p of ['安排/待执行','安排/已完成','安排/历史','settings/gvkit'])entries.set(p,new TFolder());
      const put=(path:string,body:string)=>{const file=new TFile(path);entries.set(path,file);data.set(path,body);return file};
      const stateFile=put('settings/gvkit/arrange.md',md({gvkit_arrange_state:1,order:[id(1),id(2)],achievedDays:[],dailyGoal:goal,
        rewardsEnabledAt:'2026-11-01T00:00:00Z',timezone:'Asia/Shanghai',specialReminderDay:'2026-11-19',submitColor:'classic',foreignSetting:'preserve'}));
      for(const n of [1,2])put('安排/待执行/'+id(n)+'.md',md({gvid:id(n),gvkit_arrange:true,title:'Fixture '+n,parent:null,date:null,completed_at:null,pinned:false,reward_points:n===1?3:0}));
      const donePath='安排/已完成/'+id(3)+'.md';
      put(donePath,md({gvid:id(3),gvkit_arrange:true,title:'Old completion',parent:null,date:null,pinned:false,completed_at:'2026-11-18T00:00:00Z',
        reward_completed_at:'2026-11-18T00:00:00Z',reward_awarded:5}));
      const vault:any={getName:()=> 'isolated-goal-fixture',getMarkdownFiles:()=>[...entries.values()].filter(f=>f instanceof TFile),
        getAbstractFileByPath:(p:string)=>entries.get(p)??null,read:async(f:any)=>data.get(f.path)!,
        create:async(p:string,s:string)=>{assert.ok(!entries.has(p));writes++;return put(p,s)},
        process:async(f:any,change:any)=>{const source=data.get(f.path)!,next=change(source);if(next!==source)writes++;data.set(f.path,next);return next}};
      const app={vault,fileManager:{renameFile:async(f:any,p:string)=>{assert.ok(!entries.has(p));const source=data.get(f.path)!;entries.delete(f.path);data.delete(f.path);f.path=p;entries.set(p,f);data.set(p,source)}}};
      return {store:new ArrangeStore(app),vault,data,stateFile,donePath,writes:()=>writes};
    };

    await t.test('actual damage shape needs only its two known structural corrections',async()=>{
      const x=fixture();
      const damaged='---\ngvkit_arrange_state: 1\norder:\n  - '+id(1)+'\n000-000000000002\nachievedDays: []\nrewardsEnabledAt: 2026-11-01T00:00:00Z\ndailyGoal:\n  day: 2026-11-19\n  id:\n  returnedId: '+truncated+'\n  id:\n---\n';
      assert.throws(()=>fields(damaged));
      x.data.set(x.stateFile.path,damaged);await x.store.load();assert.ok(x.store.configIssue);
      const orderFixed=damaged.replace('\n000-000000000002\n','\n  - '+id(2)+'\n');
      assert.throws(()=>fields(orderFixed),'duplicate mapping key remains invalid');
      const repaired=orderFixed.replace('  returnedId: '+truncated+'\n  id:\n','  returnedId: '+truncated+'\n');
      x.data.set(x.stateFile.path,repaired);await x.store.load();
      assert.equal(x.store.configIssue,null);assert.ok(x.store.goalIssue);
      assert.equal(x.data.get(x.stateFile.path),repaired,'loading leaves original unknown value and other bytes alone');
      assert.equal(fields(repaired).dailyGoal.returnedId,truncated);
    });

    await t.test('create, pin, complete and duplicate complete preserve goal and old rewards',async()=>{
      const x=fixture();await x.store.load();const before=fields(x.data.get(x.stateFile.path)!);
      const oldReward=x.data.get(x.donePath);
      const created=await x.store.create('New fixture',null);assert.ok(x.store.items.some((i:any)=>i.id===created));
      const order=[...x.store.state.order];await x.store.togglePin(id(2));
      assert.equal(x.store.items.find((i:any)=>i.id===id(2)).pinned,true);assert.deepEqual(x.store.state.order,order);
      assert.equal(await x.store.complete(id(1),true),true);
      assert.equal(fields(x.data.get('安排/已完成/'+id(1)+'.md')!).reward_awarded,3);
      assert.equal(await x.store.complete(id(1),true),false);
      assert.equal(x.data.get(x.donePath),oldReward);
      const after=fields(x.data.get(x.stateFile.path)!);
      assert.deepEqual(after.dailyGoal,before.dailyGoal);assert.equal(after.rewardsEnabledAt,before.rewardsEnabledAt);
      assert.equal(after.foreignSetting,'preserve');
      await assert.rejects(x.store.setDailyGoal(id(2)),/目标设置暂不可用/);
      assert.deepEqual(fields(x.data.get(x.stateFile.path)!).dailyGoal,before.dailyGoal);
    });

    await t.test('unknown returned target blocks rollover and all goal replacements',async()=>{
      const x=fixture({day:'2026-11-18',id:null,returnedId:truncated});
      const before=x.data.get(x.stateFile.path);
      await x.store.enter('view_open');
      assert.equal(x.store.state.dailyGoal.day,'2026-11-18');
      assert.deepEqual(fields(x.data.get(x.stateFile.path)!).dailyGoal,fields(before!).dailyGoal);
      await assert.rejects(x.store.configure({dailyGoal:null}),/目标设置暂不可用/);
      assert.deepEqual(fields(x.data.get(x.stateFile.path)!).dailyGoal,fields(before!).dailyGoal);
    });

    await t.test('normal targets still select and roll over normally',async()=>{
      const x=fixture({day:'2026-11-19',id:id(1),returnedId:id(2)});
      await x.store.load();assert.equal(x.store.goalIssue,null);
      await x.store.setDailyGoal(id(2));assert.equal(fields(x.data.get(x.stateFile.path)!).dailyGoal.id,id(2));
      const old=fixture({day:'2026-11-18',id:id(1),returnedId:id(2)});
      await old.store.load();assert.equal(old.store.goalIssue,null);
      assert.equal(old.store.state.dailyGoal.day,'2026-11-19');
      assert.equal(old.store.state.dailyGoal.returnedId,id(1));
    });

    await t.test('fresh concurrent settings and resolved target survive an ordinary write',async()=>{
      const x=fixture();await x.store.load();
      const process=x.vault.process;let inject=true;
      const nextGoal={day:'2026-11-19',id:id(2),returnedId:id(1)};
      x.vault.process=async(f:any,change:any)=>{
        if(f===x.stateFile&&inject){const latest=fields(x.data.get(f.path)!);latest.dailyGoal=nextGoal;latest.submitColor='navy';x.data.set(f.path,md(latest));inject=false;}
        return process(f,change);
      };
      await x.store.configure({keyboardGap:12});
      const saved=fields(x.data.get(x.stateFile.path)!);
      assert.deepEqual(saved.dailyGoal,nextGoal);assert.equal(saved.submitColor,'navy');assert.equal(saved.keyboardGap,12);
      await x.store.load();assert.equal(x.store.goalIssue,null);
    });
  } finally { await rm(dir,{recursive:true,force:true}); }
});