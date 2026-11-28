import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

test('shared publication key confirms the exact linked tab and publishes the displayed two levels', async () => {
    const window = new Window();
    const document = window.document;
    const proto: any = window.HTMLElement.prototype;
    proto.addClass = function(c: string) { this.classList.add(c); };
    proto.empty = function() { this.replaceChildren(); };
    proto.setText = function(text: string) { this.textContent=text; };
    proto.createEl = function(tag: string, o: any={}) {
        const e: any=document.createElement(tag);
        if(o.text) e.textContent=o.text;
        for(const key of ['type','value','placeholder']) if(o[key]!==undefined) e[key]=o[key];
        this.append(e); return e;
    };
    proto.createDiv = function() { return this.createEl('div'); };
    const mock = `
        export class Modal {
            constructor(){this.contentEl=globalThis.sheetHost.document.createElement('div')}
            setTitle(){} open(){globalThis.sheetHost.document.body.append(this.contentEl)}
            close(){this.contentEl.remove();this.onClose?.()}
        }
        export function parseYaml() {} export function getFrontMatterInfo() {}
        export class Setting {} export class Notice {} export const requestUrl=(arg)=>globalThis.sheetRequest(arg);
    `;
    const { outputFiles }=await build({entryPoints:['src/dingtalkSheet.ts'],bundle:true,write:false,
        format:'esm',platform:'node',plugins:[{name:'obsidian',setup(b){
            b.onResolve({filter:/^obsidian$/},()=>({path:'shim',namespace:'test'}));
            b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:mock}));
        }}]});
    const g=globalThis as any;
    g.sheetHost=window;
    g.window=window;
    const { DingTalkSheets }=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].contents).toString('base64'));
    let binding: any=null, current=true, publications=0;
    let release: (()=>void)|null=null;
    const pending: any[]=[];
    const items=[
        {id:'r',title:'根',parent:null},{id:'g',title:'组',parent:'r'},
        {id:'x',title:'已完成孙项',parent:'g',completedAt:'2026-01-01',body:'私密正文'},
        {id:'old',title:'历史投影',parent:'g',occurrenceOf:'x'},{id:'z',title:'第三层',parent:'x'},
    ];
    g.sheetRequest=async(arg:any)=>{
        assert.equal(arg.headers.Authorization,'Bearer shared-publication-key');
        const body=arg.body && JSON.parse(arg.body);
        if(arg.url.endsWith('/targets')) return {status:200,json:{sheets:[{id:'b',name:'乙'}]}};
        if(arg.url.includes('?root=')) return {status:200,json:{binding}};
        if(arg.url.endsWith('/command')) {
            assert.equal(body.action,'stop'); binding.status='stopped'; return {status:200,json:binding};
        }
        if(arg.url.includes('blocked=true')) return {status:200,json:{bindings:[binding]}};
        publications++;
        pending.push(body);
        binding={root:'r',id:'bound',version:1,sheet:'乙',title:'根',status:'synced'};
        return {status:200,json:binding};
    };
    const plugin={app:{secretStorage:{getSecret:(ref:string)=>{assert.equal(ref,'gvkit-collab-board-device');return 'shared-publication-key';}}}};
    const store={items,sheetSourceReady:()=>true,load:async()=>{}};
    const ui=new DingTalkSheets(plugin,store,()=>({getCollabSecretRef:()=> 'gvkit-collab-board-device'}));
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    const btn=(name:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent===name) as any;
    try {
        ui.open({root:'r',current:()=>current}); await tick();
        const input=document.querySelector('input')!;
        input.value='https://alidocs.dingtalk.com/i/nodes/'+'a'.repeat(32)+'?sheetId=b';
        await btn('核对页签').onclick();
        assert.equal(document.querySelector('select'),null);
        assert.match(document.body.textContent,/发布到「乙」/);
        assert.match(document.body.textContent,/根 · 2 项/);
        assert.doesNotMatch(document.body.textContent,/历史投影|第三层|私密正文/);
        items[2].title='更新的标题';
        await btn('发布').onclick(); assert.equal(publications,0);
        assert.match(document.body.textContent,/事项内容已变化/);
        await btn('发布').onclick(); assert.equal(publications,1);
        assert.equal(pending[0].sheet,'b');
        assert.match(pending[0].link,/sheetId=b/);
        assert.equal(pending[0].preview.rows[1].title,'更新的标题');
        assert.deepEqual(pending[0].preview.rows.map((r:any)=>Object.keys(r).sort()),[['id','parent','title'],['id','parent','title']]);
        assert.match(document.body.textContent,/当前内容已同步/);
        await btn('停止后续同步').onclick();
        assert.match(document.body.textContent,/后续同步已停止/);
        ui.panel.close();
        g.sheetRequest=async()=>{ await new Promise<void>(r=>{release=r;}); return {status:200,json:{binding}}; };
        ui.open({root:'r',current:()=>current}); current=false; release!(); await tick();
        assert.equal(btn('停止后续同步'),undefined);
    } finally { ui.panel?.close(); delete g.sheetHost; delete g.sheetRequest; delete g.window; await window.happyDOM.close(); }
});
