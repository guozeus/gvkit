import { Modal, Notice, Plugin, requestUrl, Setting, type TAbstractFile } from 'obsidian';
import { COLLAB_API } from './collabBoard';
import type { ArrangeStore } from './arrangeStore';
import { isUuidV7 } from './fileIdCore';

const BASE = COLLAB_API.replace(/\/publications$/, '/sheets');
const REF = 'gvkit-dingtalk-sheet-device';
const credentialPage = new URL('../../credentials', BASE).href;
type Row = { id: string; parent: string; title: string };
type Preview = { title: string; parent: string | null; rows: Row[] };
export type SheetTarget = { root: string; current(): boolean };
type Binding = { id: string; version: number; root: string; title: string; sheet: string; url: string; status: string;
    designated: boolean; requests: Record<string,{ request: string; members: string[] }>;
    removals: { id: string; e: string; title: string; group: string; row: number; group_title?: string }[] };
const messages: Record<string,string> = {
    protect_page:'请配置专用页保护或改选页签。', connection_required:'请联系连接管理者恢复钉钉授权。',
    rate_limited:'钉钉调用额度受限，服务将在恢复后继续。',
    choose_sheet:'请选择可编辑的同组织普通表格页签。', waiting_source:'等待原件同步，请核对缺失、冲突的事项及其标题。',
    waiting_order:'等待指定设备确认旧事项顺序。', checking:'正在核对页签…', syncing:'正在同步…',
    synced:'当前内容已同步', pending:'上次写入待核对', stopped:'后续同步已停止',
    stopped_pending:'已停止后续同步，上次写入待核对。', refresh_preview:'中心原件与预览有变化，请刷新后确认。',
    refresh_binding:'绑定已更新，请刷新。', target_changed:'页签结构已变化，请核对原页和保护设置。',
    official_unconfirmed:'钉钉结果待核对，请联系连接管理者。', batch_too_large:'本次重排超出钉钉单批能力。',
    binding_exists:'事项或目标页已绑定，请刷新。', permission_required:'请配置钉钉发布凭据。',
};
const label = (code: string) => messages[code] ?? '暂时无法核对，请刷新。';

export class DingTalkSheets {
    private alive = true;
    private timer = 0;
    private busy = false;
    private dirty = false;
    private panel?: Modal;
    private readonly lastOrder = new Map<string,string>();
    constructor(private plugin: Plugin, private store: ArrangeStore) {}
    private key() { try { return this.plugin.app.secretStorage?.getSecret(REF); } catch { return null; } }
    private async api<T>(path: string, body?: unknown): Promise<T> {
        const key = this.key();
        if (!this.alive || !key) throw Error(label('permission_required'));
        const response = await requestUrl({url:BASE+path, method:body===undefined?'GET':'POST',
            headers:{Authorization:'Bearer '+key}, contentType:'application/json',
            body:body===undefined?undefined:JSON.stringify(body), throw:false});
        if (response.status !== 200) {
            const code = response.status===401 || response.status===403 ? 'permission_required' : response.json?.detail;
            throw Error(label(code));
        }
        return response.json as T;
    }
    private command(b: Binding, action: string, values: object = {}) {
        return this.api<Binding>('/command',{id:b.id, root:b.root, version:b.version, action,...values});
    }
    private preview(root: string): Preview {
        const items=this.store.items.filter(r=>!r.occurrenceOf || r.occurrenceOf===r.id);
        const current=items.find(r=>r.id===root);
        if (!current || !this.store.sheetSourceReady(root)) throw Error(label('waiting_source'));
        const children=(parent:string): Row[] => items.filter(r=>r.parent===parent)
            .sort((a,b)=>Number(isUuidV7(a.id))-Number(isUuidV7(b.id)) || (isUuidV7(a.id)?a.id.localeCompare(b.id):0))
            .map(({id,title})=>({id,title,parent}));
        const rows=children(root).flatMap(g=>[g,...children(g.id)]);
        return {title:current.title,parent:current.parent,rows};
    }
    listen() {
        const app=this.plugin.app;
        const schedule=(changed:boolean) => {
            if (!this.alive || !this.key()) return;
            this.dirty ||= changed;
            window.clearTimeout(this.timer);
            this.timer=window.setTimeout(()=>void this.refreshDevices(),500);
        };
        const relevant=(p:string)=>p==='安排' || p.startsWith('安排/') || p.startsWith('settings/gvkit/');
        const changed = (f:TAbstractFile)=>{ if(relevant(f.path)) schedule(true); };
        this.plugin.registerEvent(app.vault.on('create',changed));
        this.plugin.registerEvent(app.vault.on('modify',changed));
        this.plugin.registerEvent(app.vault.on('delete',changed));
        this.plugin.registerEvent(app.vault.on('rename',(f,old)=>{ if(relevant(f.path)||relevant(old)) schedule(true); }));
        this.plugin.registerDomEvent(window,'online',()=>schedule(true));
        this.plugin.registerDomEvent(document,'visibilitychange',()=>{ if(!document.hidden) schedule(true); });
        this.plugin.registerInterval(window.setInterval(()=>schedule(false),90000));
        app.workspace.onLayoutReady(()=>schedule(true));
        this.plugin.register(()=>{ this.alive=false; window.clearTimeout(this.timer); this.panel?.close(); });
    }
    private async refreshDevices() {
        if (this.busy || !this.alive) return;
        this.busy=true;
        const changed=this.dirty; this.dirty=false;
        try {
            const {bindings}=await this.api<{bindings:Binding[]}>('');
            let loaded=false;
            for(const b of bindings) {
                if(!this.alive || b.status.startsWith('stopped')) continue;
                if(changed) await this.command(b,'changed');
                if(!b.designated || (!changed && !Object.keys(b.requests).length)) continue;
                if(!loaded) { await this.store.load('sheet-order'); loaded=true; }
                let preview: Preview;
                try { preview=this.preview(b.root); } catch { continue; }
                const parents=new Set([...preview.rows.map(r=>r.parent), ...Object.keys(b.requests)]);
                for(const group of parents) {
                    const order=preview.rows.filter(r=>r.parent===group).map(r=>r.id);
                    const req=b.requests[group];
                    if(req && [...order].sort().join('\0')===[...req.members].sort().join('\0')) {
                        await this.command(b,'order',{group,order,request:req.request});
                        break;
                    }
                    if(changed && order.filter(id=>!isUuidV7(id)).length>=2) {
                        const k=b.id+'|'+group, serialized=JSON.stringify(order);
                        if(this.lastOrder.get(k)!==serialized) {
                            await this.command(b,'changed',{group,order});
                            this.lastOrder.set(k,serialized);
                        }
                    }
                }
            }
        } catch { /* A later foreground/network event or the center scan reconciles this binding. */ }
        finally { this.busy=false; if(this.dirty && this.alive) void this.refreshDevices(); }
    }
    private credential(el: HTMLElement, saved?:()=>void) {
        el.createEl('a',{text:'签发本机钉钉表格发布凭据',href:credentialPage,attr:{target:'_blank',rel:'noopener'}});
        if(!this.plugin.app.secretStorage) { el.createEl('p',{text:'请更新 Obsidian 以使用本机安全存储。'}); return; }
        let input: HTMLInputElement;
        new Setting(el).setName('本机发布凭据').addText(t=>{
            input=t.inputEl; input.type='password'; input.autocomplete='off'; input.style.fontSize='16px';
        }).addButton(bt=>bt.setButtonText('保存').onClick(()=>{
            const value=input.value.trim();
            if(!/^cbm_[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(value)) { new Notice('请粘贴完整的专用凭据。'); return; }
            try { this.plugin.app.secretStorage.setSecret(REF,value); input.value='';
                if(this.key()!==value) throw Error(); new Notice('本机凭据已保存'); void this.refreshDevices(); saved?.();
            } catch { new Notice('本机凭据保存失败，请检查安全存储。'); }
        }));
    }
    settings(el: HTMLElement) {
        el.addClass('gvkit-sheet');
        const section=el.createEl('details');
        section.createEl('summary',{text:'配置钉钉发布凭据'}); this.credential(section,()=>{ if(el.isConnected) { el.empty(); this.settings(el); } });
        if(!this.key()) return;
        void this.api<{bindings:Binding[]}>('?blocked=true').then(({bindings})=>{
            if(!el.isConnected || !bindings.length) return;
            el.createEl('h3',{text:'受阻的表格同步'});
            for(const b of bindings) el.createEl('button',{text:b.title+' · '+b.sheet}).onclick=()=>
                this.open({root:b.root,current:()=>el.isConnected},true);
        }).catch(()=>{ if(el.isConnected) section.createEl('p',{text:'受阻绑定暂时无法读取，请检查凭据后重新打开设置。'}); });
    }
    open(target: SheetTarget, settings=false) {
        this.panel?.close();
        const modal=new Modal(this.plugin.app);
        this.panel=modal;
        modal.setTitle('发布到钉钉文档表格');
        const el=modal.contentEl; el.addClass('gvkit-sheet');
        modal.open();
        let generation=0, timer=0;
        const current=(n:number)=>this.alive && this.panel===modal && el.isConnected && target.current() && generation===n;
        modal.onClose=()=>{ generation++; window.clearTimeout(timer); if(this.panel===modal) this.panel=undefined; };
        const failure=(e:unknown)=>e instanceof Error && Object.values(messages).includes(e.message)?e.message:'暂时无法核对，请刷新。';
        const render=async()=>{
            const n=++generation;
            if(!current(n)) return;
            el.empty();
            const msg=el.createEl('p',{text:label('checking')});
            const button=(text:string,fn:()=>Promise<void>,parent:HTMLElement=el)=>{
                const bt=parent.createEl('button',{text});
                bt.onclick=async()=>{
                    if(!current(n) || bt.disabled) return;
                    bt.disabled=true; msg.setText(label('checking'));
                    try { await fn(); } catch(e) { if(current(n)) msg.setText(failure(e)); }
                    finally { if(current(n)) bt.disabled=false; }
                };
                return bt;
            };
            try {
                if(!this.key()) { msg.setText(label('permission_required')); this.credential(el,()=>{ if(current(n)) void render(); }); return; }
                const {binding:b}=await this.api<{binding:Binding|null}>('?root='+encodeURIComponent(target.root));
                if(!current(n)) return;
                if(b) {
                    msg.setText(label(b.status)); el.createEl('p',{text:b.title+' · '+b.sheet});
                    const command=async(action:string,fields:object={})=>{await this.command(b,action,fields); if(current(n)) await render();};
                    if(b.status==='synced') el.createEl('a',{text:'打开表格',href:b.url,attr:{target:'_blank',rel:'noopener'}});
                    if(!b.status.startsWith('stopped')) {
                        button('停止后续同步',()=>command('stop'));
                        if(b.status==='waiting_order' && !b.designated) button('用本设备确认排序',()=>command('takeover'));
                        for(const row of b.removals) {
                            const text='第 '+row.row+' 行 · '+(row.group_title ?? '')+' / '+row.title;
                            const detail=el.createEl('details'); detail.createEl('summary',{text:'核对缺失事项 · '+text});
                            button('确认移除这项',()=>command('remove',{row:row.e,group:row.id}),detail);
                        }
                        if(b.status==='refresh_preview' && !settings) await this.confirmPreview(el,target,n,current,button,p=>command('resume',{preview:p}));
                    } else if(b.status==='stopped') {
                        if(!settings) await this.confirmPreview(el,target,n,current,button,p=>command('resume',{preview:p}));
                        button('解除此页绑定',()=>command('release'));
                    }
                    if(['syncing','checking','pending','stopped_pending'].includes(b.status))
                        timer=window.setTimeout(()=>{ if(current(n)) void render(); },4000);
                } else if(!settings) {
                    msg.setText('选择要发布到的空白专用页');
                    const input=el.createEl('input',{type:'url',placeholder:'粘贴钉钉表格链接'});
                    input.style.fontSize='16px';
                    let choices:HTMLElement|undefined;
                    input.oninput=()=>{ choices?.remove(); };
                    button('核对页签',async()=>{
                        choices?.remove();
                        const link=input.value.trim();
                        const {sheets}=await this.api<{sheets:{id:string;name:string}[]}>('/targets',{link});
                        if(!current(n)||input.value.trim()!==link) return;
                        if(!sheets.length) { msg.setText(label('choose_sheet')); return; }
                        choices=el.createDiv();
                        const select=choices.createEl('select',{attr:{'aria-label':'目标页签'}});
                        select.style.fontSize='16px';
                        for(const tab of sheets) select.createEl('option',{text:tab.name,value:tab.id});
                        const hint=new URL(link).searchParams.get('sheetId');
                        if(hint && sheets.some(tab=>tab.id===hint)) select.value=hint;
                        else if(sheets.length>1) select.selectedIndex=-1;
                        msg.setText('确认页签与本次发布内容');
                        await this.confirmPreview(choices,target,n,current,button,async preview=>{
                            if(!select.value || !choices?.isConnected || input.value.trim()!==link) throw Error(label('choose_sheet'));
                            await this.api('',{root:target.root,sheet:select.value,link,preview});
                            if(current(n)) await render();
                        });
                    });
                } else msg.setText('此事项已解除绑定。');
            } catch(e) { if(current(n)) msg.setText(failure(e)); }
            if(current(n)) button('刷新',render);
        };
        void render();
    }
    private async confirmPreview(el:HTMLElement,target:SheetTarget,n:number,current:(n:number)=>boolean,
        button:(text:string,fn:()=>Promise<void>,parent:HTMLElement)=>HTMLButtonElement,publish:(p:Preview)=>Promise<void>) {
        await this.store.load('sheet-preview');
        if(!current(n) || !el.isConnected) return;
        let preview=this.preview(target.root);
        const list=el.createDiv();
        const paint=()=>{
            list.empty();
            list.createEl('p',{text:preview.title+' · '+preview.rows.length+' 项（含已完成）'});
            for(const r of preview.rows) list.createEl(r.parent===target.root?'strong':'div',{text:r.title});
        };
        paint();
        el.createEl('p',{text:'发布当前可见内容，后续自动同步。团队在受保护的专用页勾选已实现和已验收。'});
        button('确认发布',async()=>{
            await this.store.load('sheet-confirm');
            if(!current(n) || !el.isConnected) return;
            const latest=this.preview(target.root);
            if(JSON.stringify(latest)!==JSON.stringify(preview)) { preview=latest; paint(); throw Error(label('refresh_preview')); }
            await publish(preview);
        },el);
    }
}
