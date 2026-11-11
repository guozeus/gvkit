import { App, Notice, requestUrl, getFrontMatterInfo, parseYaml, type TFile } from 'obsidian';
import type { PublishSettings } from './publishSettings';
import type { DeviceZhouyouSecret } from './publishSecretSettings';
import { isPublishableMarkdownPath, type PublishDocumentContext } from './documentActions';
import { sha256Utf8 } from './zhouyouClient';

type SyncPayload = {
  sourceId: string; operationId: string; documentId: string | null;
  recordVersion: number | null; title: string; content: string; sourceRevision: string;
};
type SmartPending = { action: 'sync_smart'; endpoint: string; operationId: string; payload: SyncPayload };
type OldPending = { operationId: string; content: string; title: string };
export type AutoBinding = { sourceId: string; documentId?: string; productId?: string; recordVersion?: number;
  version?: number; content?: string; path: string; blocked?: string; pending?: SmartPending | OldPending;
  legacyEvidence?: LegacyEvidence };
type Binding = AutoBinding;
type RecoveryApproval = { sourceIdHash: string; oldOperationIdHash: string; endpoint: string;
  backupPath: string; backupSha256: string };
type LegacyEvidence = { pending: OldPending; historicalEndpoint: 'unknown'; oldOutcome: 'unknown';
  backupPath: string; endpoint: string; identityHash: string; newOperationId: string; blocked?: boolean };
const recoveryFile = 'zhouyou-legacy-recovery.json';
type Remote = { sourceId: string; documentId: string; recordVersion: number; title: string;
  content: string; contentHash?: string; publishedContentHash?: string; productId?: string; productName?: string; currentVersionNo?: number;
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
  private timers = new Map<TFile, ReturnType<typeof setTimeout>>();
  private queuedDuringWrite = new Set<TFile>();
  private active = true;
  constructor(private app: App, private settings: PublishSettings, private secret: DeviceZhouyouSecret,
    private debounceMs = 2000) {}
  private rows(): Record<string, Binding> { return this.settings.getAutoPublishBindings(); }
  statusLabel(context: PublishDocumentContext): string {
    const b = this.rows()[this.key(context.file)];
    if (b?.blocked) return '已暂停同步，需核对';
    if (b?.pending) return '上次同步待确认';
    if (!b?.documentId) return '';
    if (b.content === undefined) return '已绑定';
    return publishBody(context.view.editor.getValue()) === b.content ? '已同步' : '有待同步修改';
  }
  private key(file: TFile): string {
    return String(this.app.metadataCache.getFileCache(file)?.frontmatter?.gvid || file.path);
  }
  private async save(key: string, binding: Binding): Promise<void> {
    await this.settings.updateNonSecret(data => {
      const rows = { ...(data.zhouyouAutoBindings as Record<string, Binding> ?? {}) };
      // A note may gain its GVID after it was first seen under its path key.
      for (const [oldKey, row] of Object.entries(rows)) {
        if (oldKey !== key && (row.sourceId === binding.sourceId || row.path === binding.path)) delete rows[oldKey];
      }
      rows[key] = binding;
      data.zhouyouAutoBindings = rows;
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
  private async recoveryApproval(b: Binding, endpoint: string): Promise<RecoveryApproval | null> {
    if (!b.pending || isSmartPending(b.pending) || b.documentId !== undefined ||
      b.recordVersion !== undefined || b.version !== undefined || b.legacyEvidence) return null;
    const root = this.app.vault.configDir + '/plugins/gvkit/';
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(root + recoveryFile)) return null;
    const approvals = JSON.parse(await adapter.read(root + recoveryFile));
    const digest = async (id: string) => (await sha256Utf8('obsidian-sync-diagnostic:v1:' + id.trim())).slice(0, 24);
    const sourceIdHash = await digest(b.sourceId), oldOperationIdHash = await digest(b.pending.operationId);
    const approval: RecoveryApproval | undefined = Array.isArray(approvals) ? approvals.find(a =>
      a.sourceIdHash === sourceIdHash && a.oldOperationIdHash === oldOperationIdHash) : undefined;
    if (!approval) return null;
    if (approval.endpoint !== endpoint || !/^zhouyou-legacy-backup-[a-z0-9-]+\.json$/.test(approval.backupPath))
      throw new Error('旧操作恢复入口或备份信息已变化，已暂停发布。');
    const backup = await adapter.read(root + approval.backupPath);
    if (await sha256Utf8(backup) !== approval.backupSha256)
      throw new Error('旧操作完整备份校验未通过，已暂停发布。');
    const original = Object.values(JSON.parse(backup).zhouyouAutoBindings ?? {}).find((row: any) =>
      row.sourceId === b.sourceId && JSON.stringify(row.pending) === JSON.stringify(b.pending)) as Binding | undefined;
    if (!original || original.documentId !== undefined || original.recordVersion !== undefined ||
      original.version !== undefined)
      throw new Error('旧操作与已核对备份不一致，已暂停发布。');
    return approval;
  }
  private async call(action: 'list_products' | 'read_current' | 'sync_smart', payload: object, endpoint: string, expectedToken?: string): Promise<any> {
    const token = this.secret.runtimeCredential();
    if (!token) throw new Error('请在 GVKit 设置中配置个人同步令牌。');
    const checkSession = () => {
      if (expectedToken !== undefined && (this.settings.getZhouyouUrl() !== endpoint ||
        this.secret.runtimeCredential() !== expectedToken))
        throw new Error('本次发布入口或身份已变化，原操作已保留，请先核对。');
    };
    checkSession();
    let response: Awaited<ReturnType<typeof requestUrl>>;
    try {
      response = await requestUrl({ url: endpoint, method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ action, ...payload }), throw: false });
    } catch {
      console.info('[GVKit Zhouyou]', { action, time: new Date().toISOString(), error: 'transport-failure' });
      throw new Error('文档中心连接或回执未确认，原操作已保留；请重新点击核对。');
    }
    checkSession();
    let result: any;
    try { result = response.json; } catch { result = null; }
    const requestId = Object.entries(response.headers ?? {}).find(([key]) =>
      key.toLowerCase() === 'x-obsidian-sync-request-id')?.[1];
    console.info('[GVKit Zhouyou]', { action, time: new Date().toISOString(),
      status: response.status, code: result?.code ?? null, requestId: requestId ?? null });
    if (response.status < 200 || response.status >= 300 || result?.code !== 0 || !result.data || typeof result.data !== 'object') {
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
    if (value.contentHash !== hash)
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
  /** Only native file events after layout-ready are queued: never scan/backfill the Vault. */
  queue(file: TFile): void {
    if (!this.active || !this.settings.getZhouyouAutoSync() || file.extension !== 'md'
      || !isPublishableMarkdownPath(file.path)) return;
    const old = this.timers.get(file);
    if (old !== undefined) clearTimeout(old);
    this.timers.set(file, setTimeout(() => {
      this.timers.delete(file);
      if (!this.active || !this.settings.getZhouyouAutoSync()) return;
      if (this.busy.has(file)) { this.queuedDuringWrite.add(file); return; }
      void this.sync(file, undefined, false);
    }, this.debounceMs));
  }

  async publish(context: PublishDocumentContext): Promise<void> {
    if (!context.isCurrent()) return;
    try {
      await (context.view as any).save();
      if (!context.isCurrent()) throw new Error('当前笔记已切换，请重新点击同步。');
      await this.sync(context.file, context, true);
    } catch (error) {
      new Notice(context.file.basename + '\n' + (error instanceof Error ? error.message : '同步结果待核对。'), 10000);
    }
  }

  private async sync(file: TFile, context?: PublishDocumentContext, manual = false): Promise<void> {
    if (this.busy.has(file)) {
      if (manual) new Notice('这篇笔记正在同步。');
      else this.queuedDuringWrite.add(file);
      return;
    }
    if (!this.active || file.extension !== 'md' || !isPublishableMarkdownPath(file.path)) return;
    if (!manual && !this.settings.getZhouyouAutoSync()) return;
    this.busy.add(file);
    const status = manual ? new Notice('宙游同步 · ' + file.basename + '\n正在核对原文档…', 0) : null;
    try {
      const path = file.path;
      const endpoint = this.settings.getZhouyouUrl();
      const token = this.secret.runtimeCredential();
      if (!endpoint || !token) {
        if (manual) throw new Error('请先在 GVKit 设置中配置同步地址和个人令牌。');
        return;
      }
      const raw = await this.app.vault.read(file);
      if (!this.active || file.path !== path || (context && (!context.isCurrent()
        || context.view.editor.getValue() !== raw))) throw new Error('当前笔记已变化，稍后重新核对。');
      const content = publishBody(raw), title = file.basename, hash = await sha256Utf8(content);
      let b = await this.binding(file, raw);
      const key = this.key(file);
      if (b.blocked) throw new Error('这篇笔记的同步已暂停：' + b.blocked + '。请先核对两端内容。');
      if (!uuidOrNull(b.sourceId)) throw new Error('来源 ID 无效，已停止同步以保护原文档。');
      if ((b.documentId !== undefined && (!b.documentId || typeof b.documentId !== 'string'))
        || (b.recordVersion !== undefined && (!Number.isSafeInteger(b.recordVersion) || b.recordVersion < 1)))
        throw new Error('旧绑定不完整，已暂停同步，请核对。');
      const identityHash = await sha256Utf8('gvkit-zhouyou-recovery-identity:v1:' + token);
      const approval = await this.recoveryApproval(b, endpoint);
      const recovering = b.legacyEvidence && b.pending && isSmartPending(b.pending)
        && b.pending.operationId === b.legacyEvidence.newOperationId;
      if (recovering && (b.legacyEvidence!.blocked || b.legacyEvidence!.endpoint !== endpoint
        || b.legacyEvidence!.identityHash !== identityHash))
        throw new Error('旧操作的身份或入口发生变化，请先核对。');
      await this.save(key, b);

      // Read-only credential/permission check, before any write. Never renew a token here.
      const products = await this.call('list_products', {}, endpoint, token);
      if (!Array.isArray(products.products) || products.products.length === 0 || (b.productId !== undefined
        && !products.products.some((p: any) => p && String(p.id) === String(b.productId))))
        throw new Error('当前令牌不可访问原文档所属项目，请先核对项目和文档权限。');

      const pending = b.pending;
      const expectedId = b.documentId ?? (pending && isSmartPending(pending)
        ? pending.payload.documentId ?? undefined : undefined);
      let remote: Remote | null = null;
      let remoteRead: unknown = null;
      try {
        remoteRead = await this.call('read_current',
          { sourceId: b.sourceId, documentId: expectedId ?? null }, endpoint, token);
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (expectedId) {
          b.blocked = '已绑定的服务端原文档不存在';
          await this.save(key, b);
          throw new Error('已绑定的原文档不存在，保留绑定，禁止重新建档。');
        }
      }
      if (remoteRead !== null) {
        try { remote = await this.verifiedCurrent(remoteRead, b.sourceId, expectedId); }
        catch {
          b.blocked = '服务端原文档身份或正文核对不一致';
          await this.save(key, b);
          throw new Error('服务端原文档身份或正文核对不一致，已暂停。');
        }
      }
      if (remote && b.productId && remote.productId && remote.productId !== b.productId) {
        b.blocked = '原项目归属发生变化';
        await this.save(key, b);
        throw new Error('文档项目归属不一致，已暂停。');
      }
      if (b.pending) {
        if (!isSmartPending(b.pending)) {
          if (approval && !remote && b.documentId === undefined && b.recordVersion === undefined
            && b.version === undefined && !b.legacyEvidence) {
            b = { ...b, pending: undefined, legacyEvidence: {
              pending: structuredClone(b.pending), historicalEndpoint: 'unknown', oldOutcome: 'unknown',
              backupPath: approval.backupPath, endpoint, identityHash, newOperationId: '',
            } };
            await this.save(key, b);
          } else {
            throw new Error('旧版同步遗留待确认操作缺少完整请求，请先人工核对；原记录保持。');
          }
        } else if (b.pending.endpoint !== endpoint
          || b.pending.operationId !== b.pending.payload.operationId
          || b.pending.payload.sourceId !== b.sourceId) {
          throw new Error('待确认操作的地址或来源已变化，原操作保持，请先核对。');
        }
      }
      if (b.legacyEvidence?.newOperationId && b.legacyEvidence.blocked)
        throw new Error('旧操作恢复后出现冲突，需人工核对。');
      // Any independently changed server version stops this note. Pending operations
      // are the exception: an ACK may have been lost after that exact operation applied.
      if (!b.pending && remote && b.recordVersion !== undefined
        && remote.recordVersion !== b.recordVersion) {
        b.blocked = '服务端记录版本已变化';
        await this.save(key, b);
        throw new Error('服务端记录版本与上次确认值不同，已暂停同步。');
      }
      if (!b.pending && remote && b.documentId === undefined
        && (remote.title !== title || remote.contentHash !== hash)) {
        b.blocked = '已有相同来源文档，但尚未核对原始绑定';
        await this.save(key, b);
        throw new Error('来源 ID 已存在服务端文档，两端内容不同，已暂停自动覆盖。');
      }
      if (!b.pending && remote && remote.title === title && remote.contentHash === hash) {
        await this.confirmed(key, b, remote);
        if (manual) new Notice(file.basename + '\n已同步，无新改动。', 5000);
        return;
      }

      if (!b.pending) {
        if (!remote && (b.documentId !== undefined || b.recordVersion !== undefined
          || b.version !== undefined || b.productId !== undefined)) {
          b.blocked = '旧绑定信息不完整，不能证明这篇笔记是首次同步';
          await this.save(key, b);
          throw new Error('旧绑定不完整，不能当作新笔记创建。');
        }
        const payload: SyncPayload = {
          sourceId: b.sourceId, operationId: crypto.randomUUID(),
          documentId: remote?.documentId ?? null,
          recordVersion: remote?.recordVersion ?? null,
          title, content, sourceRevision: hash,
        };
        b.pending = { action: 'sync_smart', endpoint, operationId: payload.operationId, payload };
        if (b.legacyEvidence && !b.legacyEvidence.newOperationId)
          b.legacyEvidence.newOperationId = payload.operationId;
      }
      const operation = b.pending;
      if (!isSmartPending(operation)) throw new Error('待确认操作不完整，已暂停。');
      const requestBody = JSON.stringify({ action: operation.action, ...operation.payload });
      if (new TextEncoder().encode(requestBody).length > 2 * 1024 * 1024)
        throw new Error('本次 JSON 请求超过 2MB，未发送。');
      if (operation.payload.sourceRevision !== await sha256Utf8(operation.payload.content))
        throw new Error('待确认操作的正文哈希与原请求不一致，已暂停。');
      if (!this.active || file.path !== path || (context && !context.isCurrent()))
        throw new Error('同步时笔记已移动或插件已退出，原操作保留。');
      // Persist the entire immutable request BEFORE invoking the transport.
      await this.save(key, b);
      let ack: any;
      try {
        ack = await this.call(operation.action, operation.payload, operation.endpoint, token);
      } catch (error) {
        if (isVersionConflict(error) || (error as { status?: number })?.status === 409) {
          b.blocked = '服务端版本冲突';
          if (b.legacyEvidence?.newOperationId === operation.operationId) b.legacyEvidence.blocked = true;
          await this.save(key, b);
          throw new Error('409 版本冲突，原操作已保留，请核对两端内容。');
        }
        throw error;
      }
      if (!ack || typeof ack.documentId !== 'string' || !ack.documentId
        || !Number.isSafeInteger(ack.recordVersion) || ack.recordVersion < 1
        || (operation.payload.documentId !== null && ack.documentId !== operation.payload.documentId)
        || (ack.sourceId !== undefined && ack.sourceId !== b.sourceId)
        || (ack.operationId !== undefined && ack.operationId !== operation.operationId))
        throw new Error('写入回执不完整，原操作保持待核对。');
      let readback: unknown;
      try {
        readback = await this.call('read_current',
          { sourceId: b.sourceId, documentId: ack.documentId }, endpoint, token);
      } catch (error) {
        if (isMissing(error)) {
          b.blocked = '写入后原文档不存在';
          await this.save(key, b);
          throw new Error('写入后原文档不存在，已暂停；原操作保留。');
        }
        // No response/connection/authorization is not a content mismatch.
        // Preserve the pending operation and allow the next read-first retry.
        throw error;
      }
      let checked: Remote;
      try {
        checked = await this.verifiedCurrent(readback, b.sourceId, ack.documentId);
        if (checked.recordVersion !== ack.recordVersion
          || checked.title !== operation.payload.title
          || checked.contentHash !== operation.payload.sourceRevision
          || (b.productId && checked.productId && b.productId !== checked.productId)) {
          throw new Error('写入读回的版本、标题、项目或正文不一致。');
        }
      } catch {
        b.blocked = '写入后独立读回数据不一致';
        await this.save(key, b);
        throw new Error('写入后独立读回数据不一致，已暂停；原操作保留。');
      }
      await this.confirmed(key, b, checked);
      const settledOlderEdit = operation.payload.content !== content || operation.payload.title !== title;
      if (settledOlderEdit && !manual) this.queuedDuringWrite.add(file);
      if (manual) new Notice(file.basename + (settledOlderEdit
        ? '\n原操作已确认，新修改请再次点击同步。'
        : '\n已同步到宙游文档中心。'), 6000);
      // A later edit must be sent as a separate operation, never mutate the pending payload.
    } catch (error) {
      if (manual) new Notice(file.basename + '\n' + (error instanceof Error ? error.message :
        '同步结果尚不明确，请核对。'), 10000);
      else console.info('[GVKit Zhouyou]', { action: 'auto-sync', status: 'held',
        reason: error instanceof Error ? error.message : 'unknown' });
    } finally {
      status?.hide();
      this.busy.delete(file);
      if (this.queuedDuringWrite.delete(file) && this.active) this.queue(file);
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
  stop(): void {
    this.active = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.queuedDuringWrite.clear();
    document.querySelectorAll('.gvkit-zhouyou-published').forEach(el => el.classList.remove('gvkit-zhouyou-published'));
  }
}
