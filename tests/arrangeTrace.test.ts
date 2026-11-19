import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArrangeTrace, configFingerprint } from '../src/arrangeTrace.ts';

test('bounded per-device Trace survives recreation, redacts errors and never blocks writes', () => {
  const map = new Map<string, string>();
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
  const trace = new ArrangeTrace(storage, 'test-trace', '0.6.61', 'ios');
  trace.record('load.start', { run: 1, trigger: 'view_open' });
  trace.failure('load.fail', { name: 'YAMLException', message: 'Implicit keys at line 20, column 1 SECRET_REMINDER' }, { run: 1, stage: 'parse_config' });
  const reopened = new ArrangeTrace(storage, 'test-trace', '0.6.62', 'ios');
  assert.equal(reopened.export().events.length, 1);
  assert.equal(reopened.export().events[0].detail.line, 20);
  assert.equal(reopened.export().events[0].detail.column, 1);
  assert.equal(reopened.export().events[0].detail.stage, 'parse_config');
  assert.ok(!JSON.stringify(reopened.export()).includes('SECRET_REMINDER'));
  assert.equal(reopened.export().events[0].platform, 'ios');
  for (let i = 0; i < 300; i++) reopened.record('config.invalid', { fingerprint: String(i) });
  assert.equal(new ArrangeTrace(storage, 'test-trace', '0.6.63', 'ios').export().events.length, 240);
  reopened.record('config.invalid', { fingerprint: '299' });
  assert.equal(reopened.export().events.at(-1)?.count, 2);
  const brokenStorage = { getItem: () => { throw Error('failed'); }, setItem: () => { throw Error('failed'); } };
  const isolated = new ArrangeTrace(brokenStorage, 'restricted', '0.6.61', 'ios');
  assert.doesNotThrow(() => isolated.record('load.start'));
  assert.equal(isolated.export().persistence, 'failed');
  assert.equal(configFingerprint('abc').fingerprint, configFingerprint('abc').fingerprint);
  assert.notEqual(configFingerprint('abc').fingerprint, configFingerprint('abcd').fingerprint);
});

// Production Store/View against a fresh disk-backed test Vault and a light Obsidian host shim.
// It checks the actual menu/export and lifecycle, not physical iPhone/iPad execution.
const shim = [
  "export class ItemView { constructor(leaf){Object.assign(this,leaf);this.disposers=[]} register(fn){this.disposers.push(fn)} registerEvent(){} registerInterval(id){this.register(()=>window.clearInterval(id))} registerDomEvent(el,type,fn,options){el.addEventListener(type,fn,options);this.register(()=>el.removeEventListener(type,fn,options))} }",
  "export const Platform={isMobileApp:false,isIosApp:false,isAndroidApp:false};",
  "export class Scope { register(){} }",
  "export class Modal {} export class Setting {}",
  "export class Menu {constructor(){this.entries=[]} addItem(fn){const e={setTitle(v){this.title=v;return this},setIcon(){return this},onClick(fn){this.click=fn;return this}};fn(e);this.entries.push(e);return this} showAtMouseEvent(){(window.menus??=[]).push(this.entries)}}",
  "export class Notice {constructor(message){(window.notices??=[]).push(message)}}",
  "export class TFile {constructor(path){this.path=path;this.name=path.split('/').pop();this.basename=this.name.slice(0,-3);this.stat={mtime:Date.now(),size:0}}}",
  "export class TFolder {} export class Plugin {} export class WorkspaceLeaf {}",
  "export const MarkdownRenderer={render:async()=>{}};export const setIcon=()=>{};export function sanitizeHTMLToDom(html){const el=document.createElement('template');el.innerHTML=html;return el.content}",
  "export function getFrontMatterInfo(s){const end=s.indexOf('\\n---',4);return s.startsWith('---\\n')&&end>=0?{exists:true,frontmatter:s.slice(4,end),contentStart:end+5}:{exists:false,frontmatter:'',contentStart:0}}",
  "export const parseYaml=JSON.parse; export const stringifyYaml=value=>JSON.stringify(value,null,2)+'\\n';"
].join('\n');

test('isolated Store/View: config save, Vault event, damaged parse, close/reopen and clipboard Trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gvkit-arrange-trace-'));
  const win = new Window({url:'https://isolated-gvkit.invalid/'});
  const keys = ['window','document','navigator','ResizeObserver','MutationObserver','HTMLElement','Node','NodeFilter','Text','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'];
  const globals = new Map(keys.map(k => [k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  let view: any, active: any = null;
  try {
    Object.assign(globalThis,{window:win,document:win.document});
    for (const k of ['MutationObserver','HTMLElement','Node','NodeFilter','Text']) (globalThis as any)[k]=(win as any)[k];
    Object.assign(globalThis,{getComputedStyle:win.getComputedStyle.bind(win),requestAnimationFrame:win.requestAnimationFrame.bind(win),
      cancelAnimationFrame:win.cancelAnimationFrame.bind(win),ResizeObserver:class {observe(){} disconnect(){}}});
    const copied: string[]=[];
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async (text:string)=>{copied.push(text)}}}});
    const proto:any=win.HTMLElement.prototype;
    proto.empty=function(){this.replaceChildren()};
    proto.addClass=function(...names:string[]){this.classList.add(...names)};
    proto.removeClass=function(...names:string[]){this.classList.remove(...names)};
    proto.toggleClass=function(name:string,on:boolean){this.classList.toggle(name,on)};
    proto.createEl=function(tag:string,options:any={}) {
      if(typeof options==='string')options={cls:options};
      const el=win.document.createElement(tag);
      if(options.cls)el.className=options.cls;
      if(options.text)el.textContent=options.text;
      if(options.type)el.type=options.type;
      for(const [k,v] of Object.entries(options.attr??{}))el.setAttribute(k,String(v));
      this.append(el);return el;
    };
    proto.createDiv=function(options:any={}){return this.createEl('div',options)};
    proto.createSpan=function(options:any={}){return this.createEl('span',options)};
    proto.scrollIntoView=()=>{};
    await build({stdin:{contents:"export {registerArrange} from './src/arrangeView';export {TFile,TFolder} from 'obsidian';",resolveDir:process.cwd()},
      platform:'node',format:'esm',bundle:true,outfile:join(dir,'bundle.mjs'),
      plugins:[{name:'fake-obsidian',setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'shim'}));
        b.onLoad({filter:/.*/,namespace:'shim'},()=>({contents:shim,loader:'js'}));}}]});
    const {registerArrange,TFile,TFolder}=await import(pathToFileURL(join(dir,'bundle.mjs')).href);
    const files=new Map<string,any>([['settings/gvkit',new TFolder()],['安排/待执行',new TFolder()],['安排/已完成',new TFolder()],['安排/历史',new TFolder()]]);
    const handlers=new Map<string,((file:any)=>void)[]>();
    const disk=(path:string)=>join(dir,encodeURIComponent(path));
    const emit=(kind:string,file:any)=>{for(const fn of handlers.get(kind)??[])fn(file)};
    const vault:any={
      getName:()=> 'isolated-fixture',
      getMarkdownFiles:()=>[...files.values()].filter(f=>f instanceof TFile),
      getAbstractFileByPath:(path:string)=>files.get(path)??null,
      on:(kind:string,fn:(file:any)=>void)=>{handlers.set(kind,[...(handlers.get(kind)??[]),fn]);return {}},
      read:(file:any)=>readFile(disk(file.path),'utf8'),
      create:async (path:string,source:string)=>{await writeFile(disk(path),source);const f=new TFile(path);f.stat.size=source.length;files.set(path,f);emit('create',f);return f},
      process:async (file:any,change:(source:string)=>string)=>{const next=change(await readFile(disk(file.path),'utf8'));
        await writeFile(disk(file.path),next);file.stat={mtime:Date.now(),size:next.length};emit('modify',file)}
    };
    const app:any={vault,scope:{},workspace:{getActiveViewOfType:()=>active,getLeavesOfType:()=>[],on:()=>({})}};
    let factory:(leaf:any)=>any=()=>{throw Error('factory missing')};
    const plugin:any={app,manifest:{version:'0.6.61'},registerView:(_id:string,fn:any)=>{factory=fn},
      registerEvent:()=>{},addCommand:()=>{},addRibbonIcon:()=>{},registerObsidianProtocolHandler:()=>{}};
    const open=async()=>{
      const host=win.document.createElement('section');win.document.body.append(host);
      const root=win.document.createElement('main');host.append(root);
      root.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:390,bottom:844,width:390,height:844,toJSON(){}});
      view=factory({app,contentEl:root,containerEl:host});active=view;await view.onOpen();
    };
    const copy=async()=>{
      view.headerMenu(new win.MouseEvent('click'));
      const entries=(win as any).menus.at(-1);
      const entry=entries.find((e:any)=>e.title.includes('复制交互诊断'));
      assert.ok(entry,'existing menu exposes export');
      await entry.click();return JSON.parse(copied.at(-1)!);
    };
    registerArrange(plugin);
    await open();
    await view.store.configure({keyboardGap:13});
    const stateFile=files.get('settings/gvkit/arrange.md')!;
    const good=await vault.read(stateFile);
    assert.match(good,/"keyboardGap": 13/);
    let data=await copy(), events=data.configTrace.events as any[];
    assert.ok(events.every(x=>x.event==='config.invalid'&&x.detail.stage==='config_missing'),'only the initial missing configuration is an anomaly');
    assert.equal(data.configTrace.persistence,'available');
    await view.onClose();active=null;
    handlers.clear();registerArrange(plugin);await open();
    data=await copy();events=data.configTrace.events;
    assert.ok(events.every((x:any)=>x.event==='config.invalid'&&x.detail.stage==='config_missing'));
    await view.onClose();active=null;
    // A real note remains readable even when the separate configuration cannot parse.
    await vault.create('安排/待执行/task.md','---\n'+JSON.stringify({gvid:'task',gvkit_arrange:true,title:'Fixture item',parent:null,date:null,completed_at:null,pinned:false})+'\n---\n');
    const broken='---\n{"gvkit_arrange_state":1,"order":[\n---\nCONFIDENTIAL_NOTE\n';
    await writeFile(disk(stateFile.path),broken);stateFile.stat={mtime:Date.now(),size:broken.length};
    handlers.clear();registerArrange(plugin);emit('modify',stateFile);
    await open(); // load fails and cannot overwrite damaged Markdown.
    assert.equal(await vault.read(stateFile),broken);
    await assert.rejects(view.store.saveState('isolated_injection'));
    assert.equal(await vault.read(stateFile),broken);
    data=await copy();events=data.configTrace.events;
    assert.ok(events.some((x:any)=>x.event==='config.invalid'&&x.detail.stage==='parse_config'));
    assert.equal(view.store.items.length,1);
    assert.equal(view.store.state.dailyGoal,null);
    assert.equal(view.store.state.rewardsEnabledAt,null);
    assert.match(view.contentEl.textContent,/Fixture item/);
    const beforeNotices=(win as any).notices.filter((x:string)=>x.startsWith('安排配置异常')).length;
    await Promise.all([view.reload('view_enter'),view.reload('visibility'),view.reload('vault_change')]);
    assert.equal((win as any).notices.filter((x:string)=>x.startsWith('安排配置异常')).length,beforeNotices);
    assert.equal(await vault.read(stateFile),broken,'presentation and repeated events do not repair/write shared bytes');
    await assert.rejects(view.store.configure({keyboardGap:20}));
    assert.ok(!JSON.stringify(data).includes('CONFIDENTIAL_NOTE'));
    await view.onClose();active=null;
    await writeFile(disk(stateFile.path),good);handlers.clear();registerArrange(plugin);await open();
    await view.store.configure({keyboardGap:14});
    assert.match(await vault.read(stateFile),/"keyboardGap": 14/);
    // A second client changes another field after this operation's load.
    const originalProcess=vault.process;
    let inject:Record<string,unknown>|null={submitColor:'navy',foreignSetting:'keep'};
    vault.process=async(file:any,change:any)=>{
      if(file.path==='settings/gvkit/arrange.md'&&inject){
        const source=await vault.read(file),fm=JSON.parse(source.slice(4,source.indexOf('\n---',4)));
        Object.assign(fm,inject);inject=null;
        await writeFile(disk(file.path),'---\n'+JSON.stringify(fm)+'\n---\n');
      }
      return originalProcess(file,change);
    };
    await view.store.configure({keyboardGap:16});
    let persisted=await vault.read(stateFile);
    assert.match(persisted,/"submitColor": "navy"/);
    assert.match(persisted,/"foreignSetting": "keep"/);
    inject={keyboardGap:22};
    await assert.rejects(view.store.configure({keyboardGap:17}),/其他操作更新/);
    assert.match(await vault.read(stateFile),/"keyboardGap":22/,'same-field race is preserved, not overwritten');
    vault.process=originalProcess;
    await view.store.load();
    let writes=0;vault.process=async(...args:any[])=>{writes++;return originalProcess(...args);};
    await view.store.configure({keyboardGap:22});
    assert.equal(writes,0,'unchanged business setting does not write');
    vault.process=originalProcess;
    // An offline instance must apply only its changed field after reconnection.
    const offline=new view.store.constructor(app);
    await offline.load();
    await view.store.configure({submitArrowSize:30});
    offline.state.keyboardGap=19;
    await offline.saveState('offline_reconnect');
    persisted=await vault.read(stateFile);
    assert.match(persisted,/"submitArrowSize": 30/);
    assert.match(persisted,/"keyboardGap": 19/);
    // Reconnected bad content is not replaced with the offline client's good snapshot.
    offline.state.keyboardGap=18;
    await writeFile(disk(stateFile.path),broken);
    await assert.rejects(offline.saveState('offline_bad_reconnect'));
    assert.equal(await vault.read(stateFile),broken);
    // Even a cold client with no cache lists source notes and makes no shared initialization.
    await view.onClose();active=null;win.localStorage.clear();
    handlers.clear();registerArrange(plugin);await open();
    assert.equal(view.store.items.length,1);
    assert.match(view.contentEl.textContent,/Fixture item/);
    assert.equal(await vault.read(stateFile),broken);
    // A parseable truncated UUID is also degraded, not treated as a healthy cache.
    const malformed=JSON.parse(good.slice(4,good.indexOf('\n---',4)));
    malformed.dailyGoal={day:'2026-11-19',id:null,returnedId:'01a1ab26-ca30-729'};
    await writeFile(disk(stateFile.path),'---\n'+JSON.stringify(malformed)+'\n---\n');
    await view.reload('vault_change');
    assert.ok(view.store.configIssue);
    assert.equal(view.store.items.length,1);
    await assert.rejects(view.store.configure({keyboardGap:20}));
    await writeFile(disk(stateFile.path),good);
    await view.reload('vault_change');
    assert.equal(view.store.configIssue,null);
    // Even real Store.load/save paths must proceed when diagnostic persistence rejects every access.
    view.store.trace = new ArrangeTrace({
      getItem: () => { throw Error('storage denied'); },
      setItem: () => { throw Error('storage denied'); },
    }, 'denied', '0.6.61', 'ios');
    await view.store.configure({keyboardGap:15});
    assert.match(await vault.read(stateFile),/"keyboardGap": 15/);
    assert.equal(view.store.trace.export().persistence,'failed');
    await view.onClose();active=null;
  } finally {
    await win.happyDOM.close();
    for(const [key,desc] of globals){if(desc)Object.defineProperty(globalThis,key,desc);else Reflect.deleteProperty(globalThis,key)}
    await rm(dir,{recursive:true,force:true});
  }
});