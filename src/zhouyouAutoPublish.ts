import { App, Notice, requestUrl, getFrontMatterInfo, parseYaml, type TFile } from 'obsidian';
import type { PublishSettings } from './publishSettings';
import type { DeviceZhouyouSecret } from './publishSecretSettings';
import type { PublishDocumentContext } from './documentActions';
import { sha256Utf8 } from './zhouyouClient';

type SyncPayload = {
  sourceId: string; operationId: string; documentId: string | null;
  recordVersion: number | null; title: string; content: string;
};
type SmartPending = { action: 'sync_smart'; endpoint: string; operationId: string; payload: SyncPayload };
type OldPending = { operationId: string; content: string; title: string };
export type AutoBinding = { sourceId: string; documentId?: string; productId?: string; recordVersion?: number;
  version?: number; content?: string; path: string; pending?: SmartPending | OldPending };
type Binding = AutoBinding;
type Remote = { sourceId: string; documentId: string; recordVersion: number; title: string;
  content: string; contentHash?: string; productId?: string; productName?: string; currentVersionNo?: number;
  documentStatus?: string };
function isSmartPending(p: SmartPending | OldPending): p is SmartPending {
  return 'action' in p && p.action === 'sync_smart' && 'payload' in p;
}
function isMissing(e: unknown): boolean {
  return e instanceof Error && (e as Error & {status?: number}).status === 404
    && (e as Error & {code?: string}).code === 'PRODUCER_DOCUMENT_NOT_FOUND';
}
function isVersionConflict(e: unknown): boolean {
  return e instanceof Error && (e as Error & {code?: string}).code === 'OBSIDIAN_SYNC_RECORD_VERSION_CONFLICT';
}
function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
const managed = ['zhou_source_id', 'zhou_document_id', 'zhou_product_id', 'zhou_record_version',
  'zhou_operation_id', 'zhou_operation_hash', 'zhou_operation_record_version', 'zhou_operation_document_id'];
// Only the former plugin's own metadata is excluded from the outgoing body.
export function publishBody(content: string): string {
  const info = getFrontMatterInfo(content);
  if (!info.exists) return content.replace(/\r\n/g, '\n');
  const lines = info.frontmatter.split(/\r?\n/);
  const kept = lines.filter(line => !managed.some(key => line.startsWith(key + ':')));
  if (kept.length === lines.length) return content.replace(/\r\n/g, '\n');
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  return ((kept.some(line => line.trim()) ? '---' + nl + kept.join(nl) + nl + '---' + nl : '') + content.slice(info.contentStart)).replace(/\r\n/g, '\n');
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
    return { sourceId: legacy.zhou_source_id || uuidOrNull(front.gvid) || crypto.randomUUID(), documentId: legacy.zhou_document_id,
      productId: legacy.zhou_product_id, recordVersion: legacy.zhou_record_version, path: file.path,
      ...(legacy.zhou_operation_id ? { pending: { operationId: legacy.zhou_operation_id, content: '', title: '' } } : {}) };
  }
  private async call(action: 'read_current' | 'sync_smart', payload: object, endpoint: string): Promise<any> {
    const token = this.secret.runtimeCredential();
    if (!token) throw new Error('请在 GVKit 设置中配置个人同步令牌。');
    let response: Awaited<ReturnType<typeof requestUrl>>;
    try {
      response = await requestUrl({ url: endpoint, method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ action, ...payload }), throw: false });
    } catch {
      console.info('[GVKit Zhouyou]', { action, time: new Date().toISOString(), error: 'transport-failure' });
      throw new Error('文档中心连接或回执未确认，原操作已保留；请重新点击核对。');
    }
    let result: any;
    try { result = response.json; } catch { result = null; }
    const requestId = Object.entries(response.headers ?? {}).find(([key]) =>
      key.toLowerCase() === 'x-obsidian-sync-request-id')?.[1];
    console.info('[GVKit Zhouyou]', { action, time: new Date().toISOString(),
      status: response.status, code: result?.code ?? null, requestId: requestId ?? null });
    if (response.status !== 200 || result?.code !== 0 || !result.data || typeof result.data !== 'object') {
      if (response.status === 401 || response.status === 403)
        throw Object.assign(new Error('个人令牌无效或无权访问文档中心（HTTP ' + response.status + '）。'),
          { status: response.status, code: result?.code });
      throw Object.assign(new Error('文档中心请求未确认（HTTP ' + response.status +
        ' · ' + (result?.code ?? '未知返回') + '）。原操作已保留。'),
        { status: response.status, code: result?.code });
    }
    return result.data;
  }
  private async verifiedCurrent(value: any, sourceId: string, expectedDocumentId?: string): Promise<Remote> {
    if (!value || value.sourceId !== sourceId || typeof value.documentId !== 'string' ||
      !value.documentId || (expectedDocumentId && value.documentId !== expectedDocumentId) ||
      !Number.isSafeInteger(value.recordVersion) || value.recordVersion < 1 ||
      typeof value.content !== 'string' || typeof value.title !== 'string' ||
      (value.currentVersionNo !== undefined &&
        (!Number.isSafeInteger(value.currentVersionNo) || value.currentVersionNo < 0)))
      throw new Error('原文档标识或返回字段不完整，已停止发布。');
    if (value.documentStatus === 'archived') throw new Error('原文档已归档，已暂停发布且保留绑定。');
    if (value.documentStatus !== undefined && value.documentStatus !== 'active')
      throw new Error('原文档状态无法确认，已暂停发布。');
    const hash = await sha256Utf8(value.content);
    if (value.contentHash !== undefined && value.contentHash !== hash)
      throw new Error('原文档正文哈希不一致，已暂停发布。');
    return value as Remote;
  }
  private async confirmed(key: string, b: Binding, remote: Remote): Promise<Binding> {
    const updated: Binding = { ...b, documentId: remote.documentId,
      productId: remote.productId ?? b.productId, recordVersion: remote.recordVersion,
      version: remote.currentVersionNo ?? b.version, content: remote.content, pending: undefined };
    await this.save(key, updated);
    return updated;
  }
  async publish(context: PublishDocumentContext): Promise<void> {
    const file = context.file;
    if (this.busy.has(file)) { new Notice('这篇笔记正在发布，请等待结果。'); return; }
    this.busy.add(file);
    const status = new Notice('宙游发布 · ' + file.basename + '\n正在读取当前笔记…', 0);
    try {
      const endpoint = this.settings.getZhouyouUrl();
      if (!endpoint) throw new Error('请在 GVKit 设置中填写宙游文档中心同步地址。');
      await (context.view as any).save();
      if (!context.isCurrent()) throw new Error('当前笔记已切换，请重新点击发布。');
      const raw = await this.app.vault.read(file);
      const content = publishBody(raw), title = file.basename;
      let b = await this.binding(file, raw);
      const key = this.key(file);
      if (!uuidOrNull(b.sourceId)) throw new Error('来源 ID 不是有效 UUID，已停止发布以免创建错误关联。');
      if (b.documentId !== undefined && (typeof b.documentId !== 'string' || !b.documentId))
        throw new Error('历史文档绑定无效，不能当作首次发布。');
      if (!this.secret.runtimeCredential()) throw new Error('请在 GVKit 设置中配置个人同步令牌。');
      await this.save(key, b);
      status.setMessage('宙游发布 · ' + file.basename + '\n正在核对原文档…');

      for (let attempt = 0; attempt < 3; attempt++) {
        const pending = b.pending;
        const expectedId = b.documentId ?? (pending && isSmartPending(pending) ?
          pending.payload.documentId ?? undefined : undefined);
        let remote: Remote | null = null;
        try {
          const result = await this.call('read_current',
            { sourceId: b.sourceId, documentId: expectedId ?? null }, endpoint);
          remote = await this.verifiedCurrent(result, b.sourceId, expectedId);
        } catch (error) {
          if (!isMissing(error)) throw error;
          if (expectedId) throw new Error('已绑定的原文档不存在，已暂停发布；不会清空绑定重建。');
        }

        if (b.pending) {
          const previous = b.pending;
          const oldContent = isSmartPending(previous) ? previous.payload.content : previous.content;
          const oldTitle = isSmartPending(previous) ? previous.payload.title : previous.title;
          if (remote && remote.content === oldContent && remote.title === oldTitle &&
            (!isSmartPending(previous) || previous.payload.documentId === null ||
              remote.documentId === previous.payload.documentId)) {
            b = await this.confirmed(key, b, remote);
            if (remote.content === content && remote.title === title) {
              new Notice(file.basename + '\n已确认原操作成功，无需重复创建。', 6000);
              return;
            }
          } else {
            if (!isSmartPending(previous))
              throw new Error('旧版发布遗留待确认操作，缺少完整原请求。请核对原文档后再继续，不能变更原操作重发。');
            if (previous.endpoint !== endpoint || previous.operationId !== previous.payload.operationId ||
              previous.payload.sourceId !== b.sourceId || previous.payload.content !== content ||
              previous.payload.title !== title)
              throw new Error('上次发布尚未确认，来源、地址或正文已变化。已保留原请求，请先核对。');
            if (remote && (previous.payload.documentId === null ||
              remote.documentId !== previous.payload.documentId ||
              remote.recordVersion !== previous.payload.recordVersion))
              throw new Error('原文档状态已变化，不能重新发送未确认的原操作。');
            if (!remote && previous.payload.documentId !== null)
              throw new Error('原文档缺失，不能重发已绑定文档的待确认操作。');
          }
        }
        if (!b.pending && remote && remote.content === content && remote.title === title &&
          (remote.currentVersionNo === undefined || remote.currentVersionNo > 0)) {
          b = await this.confirmed(key, b, remote);
          new Notice(file.basename + '\n已发布，正文无新改动。', 6000);
          return;
        }
        if (!b.pending) {
          const payload: SyncPayload = { sourceId: b.sourceId, operationId: crypto.randomUUID(),
            documentId: remote?.documentId ?? null, recordVersion: remote?.recordVersion ?? null,
            title, content };
          b.pending = { action: 'sync_smart', endpoint, operationId: payload.operationId, payload };
        }
        const toSend = b.pending;
        if (!isSmartPending(toSend)) throw new Error('待确认操作不完整，已暂停发布。');
        if (new TextEncoder().encode(JSON.stringify({ action: toSend.action, ...toSend.payload })).length > 2 * 1024 * 1024)
          throw new Error('请求超过 2MB 限制，未发送文档。');
        if (!context.isCurrent() || publishBody(context.view.editor.getValue()) !== content)
          throw new Error('当前文档已变化，未发送；原操作已保留。');
        await this.save(key, b); // Durable exact endpoint/action/operationId/payload before send.
        let ack: any;
        try {
          ack = await this.call(toSend.action, toSend.payload, toSend.endpoint);
        } catch (error) {
          if (isVersionConflict(error)) {
            // A definite CAS rejection is not an ambiguous transport outcome.
            b = { ...b, pending: undefined };
            await this.save(key, b);
            if (attempt < 2) continue;
            throw new Error('连续三次版本冲突，已停止发布，请核对原文档。');
          }
          throw error;
        }
        if (typeof ack.documentId !== 'string' || !ack.documentId ||
          !Number.isSafeInteger(ack.recordVersion) || ack.recordVersion < 1 ||
          (toSend.payload.documentId !== null && ack.documentId !== toSend.payload.documentId) ||
          (ack.sourceId !== undefined && ack.sourceId !== b.sourceId) ||
          (ack.operationId !== undefined && ack.operationId !== toSend.operationId))
          throw new Error('发布回执不完整，原操作已保留，尚未确认成功。');
        const verified = await this.verifiedCurrent(await this.call('read_current',
          { sourceId: b.sourceId, documentId: ack.documentId }, endpoint),
          b.sourceId, ack.documentId);
        if (verified.recordVersion !== ack.recordVersion ||
          verified.content !== toSend.payload.content || verified.title !== toSend.payload.title)
          throw new Error('独立读回的文档与发布回执不一致，原操作已保留。');
        b = await this.confirmed(key, b, verified);
        const versionText = typeof verified.currentVersionNo === 'number' ?
          ' · V' + verified.currentVersionNo : '';
        new Notice(file.basename + '\n已发布到宙游文档中心' + versionText, 6000);
        return;
      }
    } catch (error) {
      new Notice(file.basename + '\n' + (error instanceof Error ? error.message :
        '发布结果尚不明确，请核对原文档。'), 10000);
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
