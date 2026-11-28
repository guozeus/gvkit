import { Modal, Plugin, requestUrl } from 'obsidian';
import { COLLAB_API } from './collabBoard';
import type { ArrangeStore } from './arrangeStore';
import type { PublishSettings } from './publishSettings';
import { isUuidV7 } from './fileIdCore';

const BASE = COLLAB_API.replace(/\/publications$/, '/sheets');
type Row = { id: string; parent: string; title: string };
type Preview = { title: string; parent: string | null; rows: Row[] };
export type SheetTarget = { root: string; current(): boolean };
type Binding = { id: string; version: number; root: string; title: string; sheet: string; url: string; status: string };

const messages: Record<string, string> = {
    connection_required: '钉钉连接暂时不可用，请稍后重试。',
    rate_limited: '钉钉调用额度受限，服务将在恢复后继续。',
    choose_sheet: '请选择可编辑的普通表格页签。',
    waiting_source: '等待原件同步，请核对事项标题和层级。',
    checking: '正在核对…', syncing: '正在同步…', synced: '当前内容已同步',
    pending: '上次写入待核对', stopped: '后续同步已停止',
    stopped_pending: '已停止后续同步，上次写入待核对。',
    refresh_preview: '事项内容已变化，请重新确认。', refresh_binding: '绑定已更新，请刷新。',
    target_changed: '页签中的发布区域已变化，请核对后重试。',
    official_unconfirmed: '钉钉结果待核对，服务会继续确认。',
    batch_too_large: '本次同步内容过多，请稍后重试。',
    binding_exists: '事项或目标页已绑定，请刷新。',
    permission_required: '请先在 GVKit 设置中保存协作板发布 Key。',
};
const label = (code: string) => messages[code] ?? '暂时无法核对，请刷新。';

export class DingTalkSheets {
    private panel?: Modal;
    constructor(private plugin: Plugin, private store: ArrangeStore, private preferences: () => PublishSettings | null) {}
    private key() {
        const ref = this.preferences()?.getCollabSecretRef();
        try { return ref ? this.plugin.app.secretStorage?.getSecret(ref) : null; } catch { return null; }
    }
    private async api<T>(path: string, body?: unknown): Promise<T> {
        const key = this.key();
        if (!key) throw Error(label('permission_required'));
        const response = await requestUrl({ url: BASE + path, method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: 'Bearer ' + key }, contentType: 'application/json',
            body: body === undefined ? undefined : JSON.stringify(body), throw: false });
        if (response.status !== 200) {
            const code = response.status === 401 || response.status === 403 ? 'permission_required' : response.json?.detail;
            throw Error(label(code));
        }
        return response.json as T;
    }
    private preview(root: string): Preview {
        const items = this.store.items.filter(row => !row.occurrenceOf || row.occurrenceOf === row.id);
        const current = items.find(row => row.id === root);
        if (!current || !this.store.sheetSourceReady(root)) throw Error(label('waiting_source'));
        const children = (parent: string): Row[] => items.filter(row => row.parent === parent)
            .sort((a, b) => Number(isUuidV7(a.id)) - Number(isUuidV7(b.id))
                || (isUuidV7(a.id) ? a.id.localeCompare(b.id) : 0))
            .map(({ id, title }) => ({ id, title, parent }));
        const rows = children(root).flatMap(group => [group, ...children(group.id)]);
        return { title: current.title, parent: current.parent, rows };
    }
    settings(el: HTMLElement) {
        if (!this.key()) return;
        void this.api<{ bindings: Binding[] }>('?blocked=true').then(({ bindings }) => {
            if (!el.isConnected || !bindings.length) return;
            el.createEl('h3', { text: '钉钉表格同步' });
            for (const binding of bindings) el.createEl('button', { text: binding.title + ' · ' + binding.sheet }).onclick = () =>
                this.open({ root: binding.root, current: () => el.isConnected }, true);
        }).catch(() => undefined);
    }
    open(target: SheetTarget, settings = false) {
        this.panel?.close();
        const modal = new Modal(this.plugin.app);
        this.panel = modal;
        modal.setTitle('发布到钉钉文档表格');
        const el = modal.contentEl; el.addClass('gvkit-sheet'); modal.open();
        let generation = 0, timer = 0;
        const current = (n: number) => this.panel === modal && el.isConnected && target.current() && generation === n;
        modal.onClose = () => { generation++; window.clearTimeout(timer); if (this.panel === modal) this.panel = undefined; };
        const failure = (error: unknown) => error instanceof Error && Object.values(messages).includes(error.message)
            ? error.message : '暂时无法核对，请刷新。';
        const render = async () => {
            const n = ++generation;
            if (!current(n)) return;
            el.empty();
            const msg = el.createEl('p', { text: label('checking') });
            const button = (text: string, action: () => Promise<void>, parent: HTMLElement = el) => {
                const control = parent.createEl('button', { text });
                control.onclick = async () => {
                    if (!current(n) || control.disabled) return;
                    control.disabled = true;
                    msg.setText(label('checking'));
                    try { await action(); } catch (error) { if (current(n)) msg.setText(failure(error)); }
                    finally { if (current(n)) control.disabled = false; }
                };
                return control;
            };
            try {
                if (!this.key()) { msg.setText(label('permission_required')); return; }
                const { binding } = await this.api<{ binding: Binding | null }>('?root=' + encodeURIComponent(target.root));
                if (!current(n)) return;
                if (binding) {
                    msg.setText(label(binding.status));
                    el.createEl('p', { text: binding.title + ' · ' + binding.sheet });
                    if (binding.status === 'synced') el.createEl('a', { text: '打开表格', href: binding.url,
                        attr: { target: '_blank', rel: 'noopener' } });
                    if (!binding.status.startsWith('stopped')) button('停止后续同步', async () => {
                        await this.api('/command', { id: binding.id, root: binding.root, version: binding.version, action: 'stop' });
                        if (current(n)) await render();
                    });
                    else button('解除此页绑定', async () => {
                        await this.api('/command', { id: binding.id, root: binding.root, version: binding.version, action: 'release' });
                        if (current(n)) await render();
                    });
                    if (['syncing', 'checking', 'pending', 'stopped_pending'].includes(binding.status))
                        timer = window.setTimeout(() => { if (current(n)) void render(); }, 4000);
                } else if (!settings) {
                    msg.setText('粘贴钉钉表格页签链接');
                    const input = el.createEl('input', { type: 'url', placeholder: '粘贴钉钉表格链接' });
                    input.style.fontSize = '16px';
                    let choices: HTMLElement | undefined;
                    input.oninput = () => choices?.remove();
                    button('核对页签', async () => {
                        choices?.remove();
                        const link = input.value.trim();
                        const { sheets } = await this.api<{ sheets: { id: string; name: string }[] }>('/targets', { link });
                        if (!current(n) || input.value.trim() !== link) return;
                        const sheet = sheets[0];
                        if (sheets.length !== 1 || !sheet) throw Error(label('choose_sheet'));
                        choices = el.createDiv();
                        msg.setText('发布到「' + sheet.name + '」');
                        await this.confirmPreview(choices, target, n, current, button, async preview => {
                            if (input.value.trim() !== link) throw Error(label('choose_sheet'));
                            await this.api('', { root: target.root, sheet: sheet.id, link, preview });
                            if (current(n)) await render();
                        });
                    });
                } else msg.setText('此事项已解除绑定。');
            } catch (error) { if (current(n)) msg.setText(failure(error)); }
            if (current(n)) button('刷新', render);
        };
        void render();
    }
    private async confirmPreview(el: HTMLElement, target: SheetTarget, n: number,
        current: (n: number) => boolean,
        button: (text: string, action: () => Promise<void>, parent: HTMLElement) => HTMLButtonElement,
        publish: (preview: Preview) => Promise<void>) {
        await this.store.load('sheet-preview');
        if (!current(n) || !el.isConnected) return;
        let preview = this.preview(target.root);
        const list = el.createDiv();
        const paint = () => {
            list.empty();
            list.createEl('p', { text: preview.title + ' · ' + preview.rows.length + ' 项（含已完成）' });
        };
        paint();
        el.createEl('p', { text: '发布两层标题，之后自动同步。' });
        button('发布', async () => {
            await this.store.load('sheet-confirm');
            if (!current(n) || !el.isConnected) return;
            const latest = this.preview(target.root);
            if (JSON.stringify(latest) !== JSON.stringify(preview)) { preview = latest; paint(); throw Error(label('refresh_preview')); }
            await publish(preview);
        }, el);
    }
}
