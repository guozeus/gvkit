import { App, Notice, requestUrl, getFrontMatterInfo, parseYaml, type TFile } from 'obsidian';
import type { PublishSettings } from './publishSettings';
import type { DeviceZhouyouSecret } from './publishSecretSettings';
import type { PublishDocumentContext } from './documentActions';
import { sha256Utf8 } from './zhouyouClient';

export type AutoBinding = { sourceId: string; documentId?: string; productId?: string; recordVersion?: number;
  version?: number; content?: string; path: string; pending?: { operationId: string; content: string; title: string } };
type Binding = AutoBinding;
const managed = ['zhou_source_id', 'zhou_document_id', 'zhou_product_id', 'zhou_record_version',
  'zhou_operation_id', 'zhou_operation_hash', 'zhou_operation_record_version', 'zhou_operation_document_id'];
// Only the former plugin's own metadata is excluded from the outgoing body.
export function publishBody(content: string): string {
  const info = getFrontMatterInfo(content);
  if (!info.exists) return content;
  const lines = info.frontmatter.split(/\r?\n/);
  const kept = lines.filter(line => !managed.some(key => line.startsWith(key + ':')));
  if (kept.length === lines.length) return content;
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  return (kept.some(line => line.trim()) ? '---' + nl + kept.join(nl) + nl + '---' + nl : '') + content.slice(info.contentStart);
}

export class ZhouyouAutoPublisher {
  private busy = new Set<TFile>();
  constructor(private app: App, private settings: PublishSettings, private secret: DeviceZhouyouSecret) {}
  private rows(): Record<string, Binding> { return this.settings.getAutoPublishBindings(); }
  statusLabel(context: PublishDocumentContext): string {
    const b = this.rows()[this.key(context.file)];
    if (!b?.version) return '';
    if (b.content === undefined) return '✅ 已发布';
    return publishBody(context.view.editor.getValue()) === b.content ? '✅ 已发布，无新改动' : '🟠 上次发布后有更新';
  }
  private key(file: TFile): string {
    return String(this.app.metadataCache.getFileCache(file)?.frontmatter?.gvid || file.path);
  }
  private async save(key: string, binding: Binding): Promise<void> {
    await this.settings.updateNonSecret(data => {
      data.zhouyouAutoBindings = { ...(data.zhouyouAutoBindings as Record<string, Binding> ?? {}), [key]: binding };
    });
    this.refreshMarkers();
  }
  async renamed(file: TFile, oldPath: string): Promise<void> {
    const entries = Object.entries(this.rows());
    const found = entries.find(([, b]) => b.path === oldPath);
    if (!found) return;
    await this.settings.updateNonSecret(data => {
      const rows = { ...(data.zhouyouAutoBindings as Record<string, Binding> ?? {}) };
      delete rows[found[0]];
      rows[this.key(file)] = { ...found[1], path: file.path };
      data.zhouyouAutoBindings = rows;
    });
    this.refreshMarkers();
  }
  private async binding(file: TFile, raw: string): Promise<Binding> {
    const key = this.key(file), rows = this.rows();
    const own = rows[key] || Object.values(rows).find(b => b.path === file.path);
    if (own) return { ...own, path: file.path };
    const fm = getFrontMatterInfo(raw);
    const front = fm.exists ? parseYaml(fm.frontmatter) ?? {} : {};
    const gv = (this.settings.getPublishBindingsSnapshot() as any[] | undefined)?.find(b => b.gvid === front.gvid);
    if (gv) return { sourceId: gv.sourceId, documentId: gv.documentId || undefined, productId: gv.productId,
      recordVersion: gv.recordVersion || undefined, version: gv.currentVersionNo, path: file.path,
      ...(gv.pending ? { pending: { operationId: gv.pending.operationId, content: '', title: '' } } : {}) };
    const legacyPath = this.app.vault.configDir + '/plugins/zhouyou-producer-sync/data.json';
    let legacy = front;
    if (await this.app.vault.adapter.exists(legacyPath)) {
      const data = JSON.parse(await this.app.vault.adapter.read(legacyPath));
      legacy = data.noteBindings?.[file.path] ?? front;
      // Upgrade the existing personal token locally; it never leaves this runtime.
      if (!this.secret.runtimeCredential() && data.token) {
        this.app.secretStorage.setSecret(this.secret.reference(), data.token);
        this.secret.enable();
      }
    }
    return { sourceId: legacy.zhou_source_id || crypto.randomUUID(), documentId: legacy.zhou_document_id,
      productId: legacy.zhou_product_id, recordVersion: legacy.zhou_record_version, path: file.path,
      ...(legacy.zhou_operation_id ? { pending: { operationId: legacy.zhou_operation_id, content: '', title: '' } } : {}) };
  }
  private async call(action: string, payload: object): Promise<any> {
    const token = this.secret.runtimeCredential();
    if (!token) throw new Error('请在 GVKit 设置中配置个人同步令牌。');
    const response = await requestUrl({ url: this.settings.getZhouyouUrl(), method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ action, ...payload }), throw: false });
    const result = response.json;
    if (response.status < 200 || response.status >= 300 || result?.code !== 0)
      throw Object.assign(new Error(`宙游接口未确认本次操作（HTTP ${response.status} · ${result?.code ?? '未知返回'}）。已保留原操作，请稍后核对原文档。`),
        { status: response.status, code: result?.code });
    return result.data;
  }
  async publish(context: PublishDocumentContext): Promise<void> {
    const file = context.file;
    if (this.busy.has(file)) { new Notice('这篇笔记正在发布，请等待结果。'); return; }
    this.busy.add(file);
    const status = new Notice(`宙游发布 · ${file.basename}\n正在读取当前笔记…`, 0);
    try {
      if (!this.settings.getZhouyouUrl()) throw new Error('请在 GVKit 设置中填写宙游文档中心同步地址。');
      // Flush the active editor before reading so the click always publishes current text.
      await (context.view as any).save();
      if (!context.isCurrent()) throw new Error('当前笔记已切换，请重新点击发布。');
      const raw = await this.app.vault.read(file), content = publishBody(raw), title = file.basename;
      let b = await this.binding(file, raw);
      if (!this.secret.runtimeCredential()) throw new Error('请在 GVKit 设置中配置个人同步令牌。');
      const key = this.key(file);
      await this.save(key, b);
      const changed = b.content !== undefined && b.content !== content;
      status.setMessage(`宙游发布 · ${file.basename}\n` + (b.documentId ? changed ? '🟠 上次发布后有更新，正在发布…' : b.content === content
        ? '✅ 已发布，正文无新改动，正在核对…' : '正在核对已绑定的原文档…' : '首次发布：由系统 AI 识别项目，无法判断时放入 Inbox。'));
      let operationId = b.pending?.operationId;
      if (b.documentId || b.pending) {
        let current;
        try { current = await this.call('read_current', { sourceId: b.sourceId, documentId: b.documentId || null }); }
        catch (error) {
          // This click may retry the SAME first operation only after authoritative absence.
          if (!(error instanceof Error && (error as any).status === 404 &&
            (error as any).code === 'PRODUCER_DOCUMENT_NOT_FOUND' && !b.documentId &&
            b.pending?.content === content && b.pending?.title === title)) throw error;
        }
        if (current) {
        if (current.sourceId !== b.sourceId || (b.documentId && current.documentId !== b.documentId))
          throw new Error('原文档标识不一致，已停止发布。');
        if (current.documentStatus === 'archived') throw new Error('原文档已归档，未发布。');
        if (b.pending) {
          if (current.content === b.pending.content && current.title === b.pending.title && current.currentVersionNo > 0) {
            b = { ...b, documentId: current.documentId, productId: current.productId, recordVersion: current.recordVersion,
              version: current.currentVersionNo, content: current.content, pending: undefined };
            await this.save(key, b);
            new Notice(`${file.basename}\n✅ 已核对上次发布成功；本次没有重复发布。`, 6000); return;
          }
          if (current.recordVersion !== b.recordVersion || b.pending.content !== content || b.pending.title !== title)
            throw new Error('上次结果尚不明确，已读取原文档；请先核对，未重建或覆盖。');
        }
        if (b.recordVersion && current.recordVersion !== b.recordVersion)
          throw new Error('系统原文档已被更新，请先核对；未覆盖。');
        b.recordVersion = current.recordVersion;
        }
      }
      b.pending = { operationId: operationId || crypto.randomUUID(), content, title };
      await this.save(key, b);
      const result = await this.call('publish_auto', { sourceId: b.sourceId, documentId: b.documentId || null,
        recordVersion: b.recordVersion || null, title, content,
        sourceRevision: await sha256Utf8(content), operationId: b.pending.operationId });
      if (!result.documentId || !result.productId || !result.recordVersion || !result.currentVersionNo ||
        (b.documentId && result.documentId !== b.documentId)) throw new Error('发布结果尚不明确，请先核对原文档。');
      const current = await this.call('read_current', { sourceId: b.sourceId, documentId: result.documentId });
      if (current.documentId !== result.documentId || current.content !== content || current.recordVersion !== result.recordVersion)
        throw new Error('已收到发布回执，但原文档读取尚未确认，请核对原文档。');
      b = { sourceId: b.sourceId, path: file.path, documentId: result.documentId, productId: result.productId,
        recordVersion: result.recordVersion, version: result.currentVersionNo, content };
      await this.save(key, b);
      new Notice(`${file.basename}\n` + (result.outcome === 'unchanged' ? '✅ 已发布，正文无新改动；没有重复发版。' :
        `✅ 已发布到 ${result.productName || '原项目'} · V${result.currentVersionNo}`), 6000);
    } catch (error) {
      new Notice(`${file.basename}\n` + (error instanceof Error ? error.message : '发布结果尚不明确，请核对原文档。'), 10000);
    } finally {
      status.hide();
      this.busy.delete(file);
    }
  }
  refreshMarkers(): void {
    const rows = this.rows();
    const published = (path: string) => Object.values(rows).some(b => b.path === path && b.version && b.version > 0)
      || (this.settings.getPublishBindingsSnapshot() as any[] | undefined)?.some(b => b.pathHint === path && b.currentVersionNo > 0);
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view as any;
      const title = view.containerEl.querySelector('.inline-title');
      title?.classList.toggle('gvkit-zhouyou-published', !!view.file && !!published(view.file.path));
      const tab = (leaf as any).tabHeaderInnerTitleEl;
      tab?.classList.toggle('gvkit-zhouyou-published', !!view.file && !!published(view.file.path));
    }
    document.querySelectorAll<HTMLElement>('.nav-file-title[data-path]').forEach(el =>
      el.classList.toggle('gvkit-zhouyou-published', !!published(el.dataset.path || '')));
  }
  stop(): void { document.querySelectorAll('.gvkit-zhouyou-published').forEach(el => el.classList.remove('gvkit-zhouyou-published')); }
}
