import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

export const md = (fields: any) => '---\n' + stringify(fields) + '---\n';
export const fields = (source: string) => parse(source.slice(4, source.indexOf('\n---', 4)));
export class MemoryStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}
export async function bundle() {
  const dir = await mkdtemp(join(tmpdir(), 'gvkit-v2-'));
  const shim = `import {parse,stringify} from 'yaml';
export class TFile {constructor(path){this.path=path;this.name=path.split('/').pop();this.basename=this.name.slice(0,-3);this.stat={mtime:0,size:0}}}
export class TFolder {}
export function getFrontMatterInfo(s){const end=s.indexOf('\\n---',4);return s.startsWith('---\\n')&&end>=0?{exists:true,frontmatter:s.slice(4,end),contentStart:end+5}:{exists:false,frontmatter:'',contentStart:0}}
export const parseYaml=parse;export const stringifyYaml=stringify;`;
  await build({stdin:{contents:"export {ArrangeStore} from './src/arrangeStore';export * from './src/arrangeV2';export * from './src/arrangeCore';export {TFile,TFolder} from 'obsidian';",resolveDir:process.cwd()},
    bundle:true,platform:'node',format:'cjs',outfile:join(dir,'bundle.cjs'),plugins:[{name:'fixture',setup(b){
      b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:shim,loader:'js',resolveDir:process.cwd()}));
    }}]});
  const module=(await import(pathToFileURL(join(dir,'bundle.cjs')).href)).default;
  return { ...module, close:()=>rm(dir,{recursive:true,force:true}) };
}
export function fixture(m:any, overrides:any={}, seed=true) {
  const entries=new Map<string,any>(),data=new Map<string,string>();
  let revision=0; const writes:string[]=[];
  const storage=new MemoryStorage();
  for(const p of ['安排/待执行','安排/已完成','安排/历史','settings/gvkit','settings/gvkit/arrange-v2'])entries.set(p,new m.TFolder());
  const put=(path:string,source:string)=>{const file=entries.get(path)??new m.TFile(path);file.stat={mtime:++revision,size:source.length};entries.set(path,file);data.set(path,source);return file;};
  const state={...m.defaultArrangeState(),specialReminderDay:'2026-11-23',rewardsEnabledAt:'2026-11-01T00:00:00Z',...overrides};
  const legacy=md({gvkit_arrange_state:1,...state});put('settings/gvkit/arrange.md',legacy);
  if(seed)put(m.V2_ACTIVATION,m.encodeV2({schema:2,epoch:'fixture-epoch',state,legacy}));
  const vault:any={getName:()=> 'fixture',getMarkdownFiles:()=>[...entries.values()].filter(f=>f instanceof m.TFile),getAbstractFileByPath:(p:string)=>entries.get(p)??null,
    read:async(f:any)=>data.get(f.path)!,createFolder:async(p:string)=>{entries.set(p,new m.TFolder());},
    create:async(p:string,s:string)=>{if(entries.has(p))throw Error('exists');writes.push(p);return put(p,s);},
    process:async(f:any,fn:any)=>{const next=fn(data.get(f.path));writes.push(f.path);put(f.path,next);return next;}};
  const app={vault,fileManager:{renameFile:async(f:any,p:string)=>{if(entries.has(p))throw Error('exists');const source=data.get(f.path)!;entries.delete(f.path);data.delete(f.path);f.path=p;entries.set(p,f);put(p,source);}}};
  const store=()=>{(globalThis as any).window={localStorage:storage};return new m.ArrangeStore(app);};
  const item=(id:string, extra:any={})=>put('安排/待执行/'+id+'.md',md({gvid:id,gvkit_arrange:true,title:id,parent:null,date:null,completed_at:null,pinned:false,...extra}));
  const ops=()=>[...data].filter(([path])=>path.startsWith(m.V2_ROOT+'/ops/')).map(([,raw])=>m.decodeV2(raw));
  return {app,vault,data,entries,storage,writes,put,item,store,ops};
}
