/** Narrow GVKit → existing collab-board publisher. No project grants or Vault scanning. */
import { getFrontMatterInfo, parseYaml, requestUrl, Modal, Setting, type App, type TFile } from 'obsidian';
import type { PublishDocumentContext } from './documentActions';
import type { PublishSettings } from './publishSettings';
import type { FileIdManager } from './fileIds';
import { validCollabPath, safeCurrent } from './collabBoardCore';
export { validCollabPath } from './collabBoardCore';

export const COLLAB_API = 'https://grealm.net/collab-board/api/machine/publications';
export const COLLAB_SECRET_REF = 'gvkit-collab-board-device';
export interface CollabCurrent {
  server_doc_uuid: string;
  active: boolean;
  epoch: number;
  revision: number;
  source_locator_revision: number;
  content_sha256: string | null;
}
export interface CollabBinding {
  gvid: string;
  path: string;
  docId: string;
  epoch: number;
  revision: number;
  locatorRevision: number;
  hash: string;
  pending?: { op: string; hash: string };
  pendingRevoke?: string; revoked?: boolean;
}
export interface PendingFirst { gvid: string; path: string; op: string; hash: string }

/** Mirror server-side eligible locator restrictions, not the broader Zhouyou menu. */
export async function hashMarkdown(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
}
export class CollabBoardPublisher {
  private busy = new Set<string>();
  private scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private app: App, private settings: PublishSettings, private fileIds: FileIdManager) {}
  stop(): void { for (const timer of this.scheduled.values()) clearTimeout(timer); this.scheduled.clear(); }

  private async call(method: 'GET'|'POST'|'PUT', suffix: string, body?: unknown): Promise<{ status: number; data: any }> {
    const secret = this.app.secretStorage?.getSecret(this.settings.getCollabSecretRef());
    if (!secret) throw Error('请先在 GVKit 设置中配置协作板设备凭据');
    // Fixed first-party host: never interpolate a token, user URL or arbitrary path.
    const response = await requestUrl({ url: COLLAB_API + suffix, method,
      headers: { Authorization: 'Bearer ' + secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), throw: false });
    let data: any = null;
    try { data = response.json; } catch { /* An HTTP error can have an empty body. */ }
    return { status: response.status, data };
  }
  private async readReceipt(space: string, gvid: string, op?: string) {
    const params = new URLSearchParams({ source_space_id: space, source_gvid: gvid });
    if (op) params.set('operation_id', op);
    return this.call('GET', '/receipt-by-source?' + params.toString());
  }
  private verified(response: { status: number; data: any }): CollabCurrent {
    const current = safeCurrent(response.data?.current);
    if (response.status !== 200 || response.data?.receipt?.committed !== true || !current || !current.active)
      throw Error('服务器尚未确认提交，请不要重复发布；请再次查看协作状态');
    return current;
  }
  private async source(file: TFile, current?: PublishDocumentContext) {
    if (!validCollabPath(file.path) || file.extension !== 'md') throw Error('协作板只接受「项目/」「安排/」内合规的单篇 Markdown');
    if (current && (!current.isCurrent() || current.file !== file)) throw Error('当前文档已切换，请重新操作');
    let text = await this.app.vault.read(file);
    let fm = getFrontMatterInfo(text);
    let fields = fm.exists ? parseYaml(fm.frontmatter) : null;
    if (!fields || typeof fields.gvid !== 'string') {
      if (!this.fileIds.isTargetFile(file) || (fields && Object.prototype.hasOwnProperty.call(fields,'gvid'))) throw Error('文档 GVID 无效');
      await this.fileIds.ensureGvid(file);
      throw Error('已为文档补齐 GVID；请等编辑器保存刷新后再次发布');
    }
    const gvid: string = fields.gvid;
    if (gvid.length > 128 || !gvid.trim() || /[\u0000-\u001f\u007f]/.test(gvid)) throw Error('文档 GVID 无效');
    if (this.app.vault.getMarkdownFiles().some(other => other !== file && this.app.metadataCache.getFileCache(other)?.frontmatter?.gvid === gvid))
      throw Error('发现重复 GVID，已阻止可能覆盖其他文档的发布');
    if (current && (!current.isCurrent() || current.view.editor.getValue() !== text)) throw Error('请先保存当前文档再发布');
    const path = file.path;
    const hash = await hashMarkdown(text);
    if (file.path !== path || (current && !current.isCurrent())) throw Error('当前文档已改变');
    return { gvid, path, text, hash };
  }
  async publish(context: PublishDocumentContext): Promise<string> {
    const file = context.file;
    if (this.busy.has(file.path)) throw Error('当前文档已有操作正在进行');
    this.busy.add(file.path);
    try {
      const src = await this.source(file, context);
      const space = await this.settings.ensureCollabSpaceId();
      const linked = this.settings.getCollabBinding(src.gvid);
      if (linked) {
        if (linked.revoked || linked.pendingRevoke) throw Error('该来源已撤回或等待撤回，不会自动重发');
        if (linked.path !== src.path) throw Error('文档已移动；当前首版不允许跨路径直接更新');
        await this.syncFile(file, src);
        return '此文档已在协作板发布，当前内容已核对/同步；请在协作板分配给策划项目';
      }
      const pending = this.settings.getCollabPendingFirst();
      if (pending && (pending.gvid !== src.gvid || pending.path !== src.path || pending.hash !== src.hash))
        throw Error('之前有未确认的首发操作，请先处理该原文档，避免重复提交');
      let op = pending?.op;
      const remote = await this.readReceipt(space, src.gvid, op);
      if (remote.status === 200) {
        const current = safeCurrent(remote.data?.current);
        if (!current || !current.active) throw Error('该来源已撤回；不能未经明确授权自动重新发布');
        if (current.content_sha256 !== src.hash) throw Error('协作板已有不同版本；请在原发布设备核对后处理');
        await this.settings.saveCollabBinding({ gvid: src.gvid, path: src.path, docId: current.server_doc_uuid,
          epoch: current.epoch, revision: current.revision, locatorRevision: current.source_locator_revision, hash: src.hash }, true);
        return '协作板已确认这篇文档处于协作状态；请在管理页勾选策划项目';
      }
      if (remote.status !== 404) throw Error('无法核实协作板是否已有此文档（HTTP ' + remote.status + '）');
      if (!op) { op = crypto.randomUUID(); await this.settings.saveCollabPendingFirst({ gvid: src.gvid, path: src.path, hash: src.hash, op }); }
      const result = await this.call('POST', '', { action: 'first', source_space_id: space, source_gvid: src.gvid,
        source_locator: src.path, markdown: src.text, body_sha256: src.hash, operation_id: op });
      const verified = this.verified(result);
      if (verified.content_sha256 !== src.hash) throw Error('协作板首发正文哈希核对失败');
      await this.settings.saveCollabBinding({ gvid: src.gvid, path: src.path, docId: verified.server_doc_uuid,
        epoch: verified.epoch, revision: verified.revision, locatorRevision: verified.source_locator_revision, hash: src.hash }, true);
      return '已发布到协作板全局文档池；默认仅管理员可见，请在协作板管理页勾选策划所属项目';
    } finally { this.busy.delete(file.path); }
  }
  /** No global scan: only an exact known, previously published path can auto-sync. */
  onModify(file: TFile): void {
    if (!this.settings.isLoaded() || !this.settings.hasCollabPath(file.path)) return;
    const old = this.scheduled.get(file.path);
    if (old) clearTimeout(old);
    const path = file.path;
    this.scheduled.set(path, setTimeout(() => {
      this.scheduled.delete(path);
      void this.syncFile(file).catch(() => { /* keep pending; manual publish shows actionable error */ });
    }, 1000));
  }
  /** Leaving the eligible source tree must revoke old access, not just stop syncing. */
  async onRename(file: TFile, previousPath: string): Promise<void> {
    const binding = this.settings.getCollabBindings().find(b => b.path === previousPath);
    if (!binding || validCollabPath(file.path) || binding.revoked) return;
    // A withheld or offline device cannot revoke instantly. Durable pending action is retried on startup.
    const updated = { ...binding, pendingRevoke: binding.pendingRevoke ?? crypto.randomUUID() };
    await this.settings.saveCollabBinding(updated);
    await this.revokeIneligible(updated);
  }
  private async revokeIneligible(binding: CollabBinding): Promise<void> {
    if (!binding.pendingRevoke) return;
    const space = await this.settings.ensureCollabSpaceId();
    const result = await this.readReceipt(space, binding.gvid, binding.pendingRevoke);
    if (result.status !== 200) throw Error('禁发位置的协作撤回状态暂无法核对');
    const current = safeCurrent(result.data?.current);
    if (!current || current.server_doc_uuid !== binding.docId) throw Error('待撤回来源身份不匹配');
    if (current.active) {
      const revoked = await this.call('POST', '/' + encodeURIComponent(binding.docId) + '/revoke', {
        source_space_id: space, source_gvid: binding.gvid, operation_id: binding.pendingRevoke,
        expected_epoch: binding.epoch,
      });
      if (revoked.status !== 200 || revoked.data?.receipt?.committed !== true || safeCurrent(revoked.data?.current)?.active !== false)
        throw Error('协作板撤回尚未确认，请联网后重试');
    }
    await this.settings.saveCollabBinding({ ...binding, revoked: true, pendingRevoke: undefined });
  }
  async resumeKnown(): Promise<void> {
    for (const binding of this.settings.getCollabBindings()) {
      if (binding.pendingRevoke) {
        void this.revokeIneligible(binding).catch(() => { /* stays pending until an authorized retry */ });
        continue;
      }
      if (binding.revoked) continue;
      const file = this.app.vault.getAbstractFileByPath(binding.path);
      if (file && 'extension' in file && file.extension === 'md') this.onModify(file as TFile);
    }
  }
  private async syncFile(file: TFile, preRead?: Awaited<ReturnType<CollabBoardPublisher['source']>>): Promise<void> {
    const src = preRead ?? await this.source(file);
    const binding = this.settings.getCollabBinding(src.gvid);
    if (!binding || binding.revoked || binding.pendingRevoke || binding.path !== src.path || this.busy.has('sync:'+src.gvid)) return;
    this.busy.add('sync:'+src.gvid);
    try {
      const space = await this.settings.ensureCollabSpaceId();
      const remote = await this.readReceipt(space, src.gvid, binding.pending?.op);
      if (remote.status !== 200) throw Error('协作板同步状态无法读取');
      const c = safeCurrent(remote.data?.current);
      if (!c || !c.active || c.server_doc_uuid !== binding.docId || c.epoch !== binding.epoch || c.source_locator_revision !== binding.locatorRevision)
        throw Error('协作板协作关系已变化，自动同步已暂停');
      if (binding.pending && remote.data?.receipt?.committed === true && c.content_sha256 === binding.pending.hash) {
        await this.settings.saveCollabBinding({ ...binding, revision: c.revision, hash: c.content_sha256!, pending: undefined });
        if (src.hash === c.content_sha256) return;
      } else if (binding.pending && src.hash !== binding.pending.hash) {
        throw Error('待确认同步后源文档又有改动，须先核对原操作');
      }
      const latest = this.settings.getCollabBinding(src.gvid)!;
      if (c.revision !== latest.revision || c.content_sha256 !== latest.hash) throw Error('协作板版本与设备基线不一致，自动同步暂停');
      if (src.hash === latest.hash) return;
      const op = latest.pending?.op ?? crypto.randomUUID();
      if (!latest.pending) await this.settings.saveCollabBinding({ ...latest, pending: { op, hash: src.hash } });
      const result = await this.call('PUT', '/' + encodeURIComponent(latest.docId) + '/content', {
        source_space_id: space, source_gvid: src.gvid, operation_id: op, source_locator: src.path,
        markdown: src.text, body_sha256: src.hash, expected_epoch: latest.epoch,
        expected_revision: latest.revision, expected_locator_revision: latest.locatorRevision,
      });
      const updated = this.verified(result);
      if (updated.server_doc_uuid !== latest.docId || updated.content_sha256 !== src.hash) throw Error('服务器同步回执不一致');
      await this.settings.saveCollabBinding({ ...latest, revision: updated.revision, hash: src.hash, pending: undefined });
    } finally { this.busy.delete('sync:'+src.gvid); }
  }
}

/** One explicit consent gesture; no automatic publish from startup or a change event. */
export function confirmCollabPublish(app: App, path: string): Promise<boolean> {
  return new Promise(resolve => {
    class Confirm extends Modal {
      private resolved = false;
      onOpen(): void {
        this.titleEl.setText('发布到协作板');
        this.contentEl.createEl('p', { text: `当前文档：${path}` });
        this.contentEl.createEl('p', { text: '确认后将发送这篇完整 Markdown 到协作板的全局文档池。初始不授权任何业务项目；请发布后在协作板管理页勾选策划所属项目。' });
        new Setting(this.contentEl).addButton(b => b.setButtonText('取消').onClick(() => this.finish(false)))
          .addButton(b => b.setButtonText('确认发布').setCta().onClick(() => this.finish(true)));
      }
      private finish(yes: boolean) { this.resolved = true; resolve(yes); this.close(); }
      onClose(): void { if (!this.resolved) resolve(false); this.contentEl.empty(); }
    }
    new Confirm(app).open();
  });
}
