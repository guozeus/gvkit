import { getFrontMatterInfo, parseYaml, requestUrl, Modal, Setting, type App, type TFile } from 'obsidian';
import type { CollabPendingAction, CollabSavedBinding, CollabSourceKind, PublishSettings } from './publishSettings';
import type { FileIdManager } from './fileIds';
import { validCollabPath, safeCurrent } from './collabBoardCore';

export const COLLAB_API = 'https://grealm.net/collab-board/api/machine/publications';
export interface CollabCurrent {
  server_doc_uuid: string;
  active: boolean;
  epoch: number;
  revision: number;
  source_locator_revision: number;
  content_sha256: string | null;
  source_kind?: CollabSourceKind;
  link?: string;
}

export interface CollabTarget {
  file: TFile;
  isCurrent(): boolean;
  editorText?(): string;
  expectedGvid?: string;
}

type BoardResponse = { status: number; data: any };
type BoardStatus = {
  current: CollabCurrent | null;
  pending: CollabPendingAction[];
  legacyPublishPending: boolean;
  legacyRevokePending: boolean;
};
type Source = { gvid: string; path: string; kind: CollabSourceKind; text: string };
class MissingGvid extends Error {}

async function hashMarkdown(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function committed(response: BoardResponse, op: string, operation?: string): boolean {
  const receipt = response.data?.receipt;
  return response.status === 200 && receipt?.committed === true && receipt.operation_id === op
    && (!operation || receipt.operation === operation);
}

function boardError(response: BoardResponse): Error {
  const code = response.data?.detail?.code ?? response.data?.detail;
  if (code === 'source_not_ready' || code === 'source_read_incomplete')
    return Error('中心库暂未确认原件，请确认文件已同步后重试。');
  if (response.status === 401 || response.status === 403)
    return Error('协作板拒绝此操作，请检查 GVKit 的发布 Key 与账号权限。');
  if (response.status === 409) return Error('协作板状态有变化，请重新查看后再操作。');
  if (response.status === 422) return Error('中心库中此原件的路径或类型不符合发布要求。');
  return Error('暂无法核对协作板结果，请稍后重试。');
}

export class CollabBoardPublisher {
  private busy = new Map<string, Promise<unknown>>();
  private scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private dialog: Modal | null = null;

  constructor(private app: App, private settings: PublishSettings, private fileIds: FileIdManager) {}
  get hasPendingWork(): boolean { return this.busy.size > 0 || this.scheduled.size > 0; }

  stop(): void {
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    this.dialog?.close();
  }

  private async call(method: 'GET'|'POST'|'PUT', suffix: string, body?: unknown): Promise<BoardResponse> {
    const secret = this.app.secretStorage?.getSecret(this.settings.getCollabSecretRef());
    if (!secret) throw Error('请先在 GVKit 设置中配置协作板发布 Key。');
    const response = await requestUrl({ url: COLLAB_API + suffix, method,
      headers: { Authorization: 'Bearer ' + secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), throw: false });
    let data: any = null;
    try { data = response.json; } catch { /* An HTTP error can have an empty body. */ }
    return { status: response.status, data };
  }

  private async readReceipt(gvid: string, op?: string) {
    const params = new URLSearchParams({ source_gvid: gvid });
    if (op) params.set('operation_id', op);
    const response = await this.call('GET', '/receipt-by-source?' + params.toString());
    const current = safeCurrent(response.data?.current);
    if (response.status === 404) return { response, current: null };
    if (response.status !== 200 || !current) throw boardError(response);
    return { response, current };
  }

  private async source(file: TFile, target?: CollabTarget, publish = false): Promise<Source> {
    const path = file.path;
    if (!validCollabPath(path) || file.extension !== 'md') throw Error('此文件不在协作板可发布范围内。');
    if (target && !target.isCurrent()) throw Error('当前文档已切换，请重新操作。');
    const text = await this.app.vault.read(file);
    if (file.path !== path || (target && !target.isCurrent())) throw Error('当前文档已改变，请重新操作。');
    const fm = getFrontMatterInfo(text);
    const fields = fm.exists ? parseYaml(fm.frontmatter) : null;
    const gvid = fields?.gvid;
    if (typeof gvid !== 'string' || !gvid.trim() || gvid.length > 128 || /[\u0000-\u001f\u007f]/.test(gvid)) {
      if (!target || target.expectedGvid || !this.fileIds.isTargetFile(file)
          || (fields && Object.prototype.hasOwnProperty.call(fields, 'gvid'))) throw Error('文档 GVID 无效。');
      throw new MissingGvid('此文档还缺少 GVID。');
    }
    if (target?.expectedGvid && gvid !== target.expectedGvid) throw Error('事项身份已变化，请重新打开。');
    if (this.app.vault.getMarkdownFiles().some(other => other !== file && this.app.metadataCache.getFileCache(other)?.frontmatter?.gvid === gvid))
      throw Error('发现重复 GVID，请先处理重复文档。');
    if (publish && target?.editorText && target.editorText() !== text) throw Error('请先保存当前文档再发布。');
    return { gvid, path, text, kind: fields?.gvkit_arrange === true ? 'arrange_root' : 'document' };
  }

  private async withSource<T>(gvid: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(gvid)) throw Error('此文档的协作板操作正在进行，请稍后重试。');
    const running = action();
    this.busy.set(gvid, running);
    try { return await running; } finally { this.busy.delete(gvid); }
  }

  private binding(gvid: string, path: string, current: CollabCurrent): CollabSavedBinding {
    return {
      gvid, path, docId: current.server_doc_uuid, epoch: current.epoch, revision: current.revision,
      locatorRevision: current.source_locator_revision, hash: current.content_sha256,
      kind: current.source_kind, revoked: !current.active,
    };
  }

  private async status(gvid: string, path: string): Promise<BoardStatus> {
    const existing = this.settings.getCollabBinding(gvid);
    const pending = this.settings.getCollabPendingActions().filter(action => action.gvid === gvid);
    const first = this.settings.getCollabPendingFirst();
    const firstOp = first?.gvid === gvid ? first.op : undefined;
    const updateOp = existing?.pending?.op;
    const revokeOp = existing?.pendingRevoke;
    const operations = [firstOp, updateOp, revokeOp, ...pending.map(action => action.op)].filter((op): op is string => !!op);
    const settled = new Set<string>();
    let current: CollabCurrent | null = null;
    for (const op of operations.length ? operations : [undefined]) {
      const read = await this.readReceipt(gvid, op);
      current = read.current;
      const action = pending.find(row => row.op === op);
      if (op && committed(read.response, op, action?.operation)) settled.add(op);
    }

    // A live binding or an inactive/newer epoch fences off old snapshot writes.
    const legacyFenced = !!current && (!!current.source_kind || !current.active
      || (!!existing && current.epoch !== existing.epoch));
    if (legacyFenced) {
      if (firstOp) settled.add(firstOp);
      if (updateOp) settled.add(updateOp);
      if (revokeOp) settled.add(revokeOp);
    }
    for (const action of pending) {
      if (current && action.epoch !== null && current.epoch !== action.epoch) settled.add(action.op);
    }
    let binding = existing ?? undefined;
    if (current?.source_kind || (current && !current.active)
        || (current && first && firstOp && settled.has(firstOp) && !existing && current.content_sha256 === first.hash)) {
      binding = this.binding(gvid, current.source_kind || !current.active ? path : first!.path, current);
    } else if (current && existing?.pending && settled.has(existing.pending.op)) {
      // Advance only the confirmed snapshot baseline, never adopt someone else's content.
      const hash = existing.pending.hash;
      if (current.server_doc_uuid === existing.docId && current.epoch === existing.epoch && current.content_sha256 === hash)
        binding = { ...existing, revision: current.revision, hash, pending: undefined };
      else binding = { ...existing, pending: undefined };
    }
    if (revokeOp && settled.has(revokeOp) && binding?.pendingRevoke) {
      binding = { ...binding, pendingRevoke: undefined };
    }
    if ((binding && JSON.stringify(binding) !== JSON.stringify(existing)) || settled.size)
      await this.settings.saveCollabBinding(binding, [...settled]);

    return {
      current,
      pending: pending.filter(action => !settled.has(action.op)),
      legacyPublishPending: !!((firstOp && !settled.has(firstOp)) || binding?.pending),
      legacyRevokePending: !!binding?.pendingRevoke,
    };
  }

  private async submit(action: CollabPendingAction) {
    const common = { source_gvid: action.gvid, operation_id: action.op, expected_epoch: action.epoch };
    if (action.operation === 'publish_live') {
      return this.call('POST', '/live', { ...common, source_locator: action.path, source_kind: action.kind });
    }
    const suffix = action.docId ? '/' + encodeURIComponent(action.docId) + '/revoke' : '/revoke-by-source';
    return this.call('POST', suffix, common);
  }

  private async change(target: CollabTarget, original: Source, state: BoardStatus, operation: CollabPendingAction['operation']) {
    await this.withSource(original.gvid, async () => {
      const { gvid, path, kind } = await this.source(target.file, target, operation === 'publish_live');
      if (gvid !== original.gvid || path !== original.path || kind !== original.kind)
        throw Error('发布来源已变化，请重新打开协作板。');
      const current = state.current;
      if (operation === 'publish_live' && (state.legacyPublishPending || state.legacyRevokePending
          || state.pending.some(action => action.operation === 'revoke'))) {
        throw Error('此来源仍有未确认操作，请先处理原操作。');
      }
      const savedRevoke = this.settings.getCollabBinding(gvid)?.pendingRevoke;
      const saved = state.pending.find(action => action.operation === operation);
      if (saved?.operation === 'publish_live' && (saved.path !== path || saved.kind !== kind))
        throw Error('原发布操作的来源位置已变化，请先撤回待确认发布。');
      const action: CollabPendingAction = saved ?? (operation === 'publish_live'
        ? { gvid, op: crypto.randomUUID(), operation, path, kind, epoch: current?.epoch ?? 0 }
        : { gvid, op: savedRevoke ?? crypto.randomUUID(), operation,
            docId: current?.server_doc_uuid ?? null, epoch: current?.epoch ?? null });
      if (operation === 'revoke' && savedRevoke && !saved) {
        const binding = this.settings.getCollabBinding(gvid)!;
        const observed = await this.revokeSnapshot(binding);
        if (observed.active) throw Error('协作板当前状态已变化，请重新查看。');
        return;
      }
      if (!saved) await this.settings.saveCollabAction(action);
      if (!target.isCurrent() || target.file.path !== path) {
        if (!saved) await this.settings.saveCollabBinding(undefined, [action.op]);
        throw Error('当前文档已切换，请重新操作。');
      }

      let response: BoardResponse;
      try { response = await this.submit(action); }
      catch {
        // A lost reply can still mean the write committed. Check this same operation.
        response = (await this.readReceipt(gvid, action.op)).response;
        if (!committed(response, action.op, operation)) throw Error('操作尚未确认，请重新打开协作板核对。');
      }
      if (response.status === 409) {
        const originalResponse = response;
        response = (await this.readReceipt(gvid, action.op)).response;
        if (!committed(response, action.op, operation)) {
          const code = originalResponse.data?.detail?.code ?? originalResponse.data?.detail;
          if (code !== 'operation_id_conflict' && code !== 'source_not_ready')
            await this.settings.saveCollabBinding(undefined, [action.op]);
          throw boardError(originalResponse);
        }
      }
      if (response.status !== 200) throw boardError(response);
      const observed = safeCurrent(response.data?.current);
      if (!observed || !committed(response, action.op, operation)) throw Error('操作尚未确认，请重新打开协作板核对。');
      await this.settings.saveCollabBinding(this.binding(gvid, path, observed), [action.op]);
      if (operation === 'revoke' ? observed.active : (!observed.active || observed.source_kind !== kind || !observed.link))
        throw Error('协作板当前状态已变化，请重新查看。');
    });
  }

  open(target: CollabTarget): void {
    if (this.dialog) return;
    const dialog = new Modal(this.app);
    this.dialog = dialog;
    dialog.setTitle('协作板');
    const path = target.file.path;
    dialog.contentEl.createEl('p', { text: path });
    const controls = dialog.contentEl.createDiv();
    const notice = controls.createEl('p', { text: '正在查看发布状态…', attr: { role: 'status' } });
    const actions = new Setting(controls);
    const active = () => this.dialog === dialog && target.isCurrent() && target.file.path === path;
    const showError = (error: unknown) => {
      if (this.dialog !== dialog) return;
      notice.setText(error instanceof Error ? error.message : '暂无法核对协作板结果，请稍后重试。');
    };
    const refresh = async (confirmed?: CollabPendingAction['operation']) => {
      actions.settingEl.hide();
      actions.controlEl.empty();
      try {
        const source = await this.source(target.file, target);
        if (!active()) throw Error('当前文档已切换，请重新操作。');
        const state = await this.withSource(source.gvid, () => this.status(source.gvid, source.path));
        if (!active()) throw Error('当前文档已切换，请重新操作。');
        const current = state.current;
        const livePublish = state.pending.find(action => action.operation === 'publish_live');
        const revokePending = state.legacyRevokePending || state.pending.some(action => action.operation === 'revoke');
        const publishPending = state.legacyPublishPending || !!livePublish;
        const link = current?.active && current.source_kind ? current.link : undefined;
        const doChange = async (operation: CollabPendingAction['operation']) => {
          actions.settingEl.hide();
          notice.setText(operation === 'revoke' ? '正在撤回…' : '正在发布…');
          try {
            if (!active()) throw Error('当前文档已切换，请重新操作。');
            await this.change(target, source, state, operation);
            if (this.dialog === dialog) await refresh(operation);
          } catch (error) {
            if (active()) await refresh();
            showError(error);
          }
        };
        notice.setText(revokePending ? '撤回待确认。' : state.legacyPublishPending ? '旧发布尚未确认，可撤回后重新发布。'
          : publishPending ? '发布待确认。' : (link ? '已发布实时链接。'
          : confirmed === 'revoke' && current?.active === false ? '已撤回发布。'
          : current?.active ? '此文档已发布快照，可转为实时链接。'
          : source.kind === 'arrange_root' ? '发布此事项及下级，默认仅管理员可见。' : '发布当前文档，默认仅管理员可见。'));
        if (link && !revokePending) actions.addButton(b => b.setButtonText('复制链接').setCta().onClick(async () => {
          if (!active()) { showError(Error('当前文档已切换，请重新操作。')); return; }
          try { await navigator.clipboard.writeText(link); notice.setText('链接已复制。'); }
          catch { notice.style.userSelect = 'text'; notice.setText(link); }
        }));
        if (!link && !state.legacyPublishPending && !revokePending) actions.addButton(b => b
          .setButtonText(livePublish ? '继续发布' : current?.active ? '改为实时链接' : '发布实时链接')
          .setCta().onClick(() => doChange('publish_live')));
        if (current?.active || publishPending || revokePending) actions.addButton(b => b
          .setButtonText(revokePending ? '继续撤回' : '撤回发布').onClick(() => doChange('revoke')));
        actions.settingEl.show();
      } catch (error) {
        showError(error);
        if (error instanceof MissingGvid && active()) {
          actions.addButton(b => b.setButtonText('补齐 GVID').setCta().onClick(async () => {
            if (!active()) return;
            b.setDisabled(true);
            try {
              await this.fileIds.ensureGvid(target.file);
              if (active()) await refresh();
            } catch {
              showError(Error('GVID 未能保存，请重试。'));
              b.setDisabled(false);
            }
          }));
          actions.settingEl.show();
        }
      }
    };
    dialog.onClose = () => {
      if (this.dialog === dialog) this.dialog = null;
      dialog.contentEl.empty();
    };
    dialog.open();
    void refresh();
  }

  /** Unconverted snapshots still use the existing exact-path push policy. */
  onModify(file: TFile): void {
    if (!this.settings.isLoaded() || !this.settings.getCollabBindings()
      .some(b => b.path === file.path && !b.kind && !b.revoked && !b.pendingRevoke)) return;
    const path = file.path;
    const old = this.scheduled.get(path);
    if (old) clearTimeout(old);
    this.scheduled.set(path, setTimeout(() => {
      this.scheduled.delete(path);
      void this.syncSnapshot(file).catch(() => { /* keep original operation for reconciliation */ });
    }, 1000));
  }

  async onRename(file: TFile, previousPath: string): Promise<void> {
    const binding = this.settings.getCollabBindings().find(b => b.path === previousPath);
    if (!binding || binding.kind || validCollabPath(file.path) || binding.revoked) return;
    while (this.busy.has(binding.gvid)) await this.busy.get(binding.gvid)?.catch(() => {});
    await this.withSource(binding.gvid, async () => {
      const latest = this.settings.getCollabBinding(binding.gvid);
      if (!latest || latest.kind || latest.revoked) return;
      const updated = { ...latest, pendingRevoke: latest.pendingRevoke ?? crypto.randomUUID() };
      await this.settings.saveCollabBinding(updated);
      await this.revokeSnapshot(updated);
    });
  }

  private async revokeSnapshot(binding: CollabSavedBinding, resumeOnly = false): Promise<CollabCurrent> {
    const op = binding.pendingRevoke!;
    const { response, current } = await this.readReceipt(binding.gvid, op);
    if (!current || current.server_doc_uuid !== binding.docId) throw Error('待撤回来源身份不匹配。');
    if (current.source_kind || !current.active) {
      await this.settings.saveCollabBinding(this.binding(binding.gvid, binding.path, current));
      return current;
    }
    if (current.epoch !== binding.epoch || committed(response, op, 'revoke')) throw Error('协作板状态有变化，请重新查看。');
    // Reload reconciliation is read-only: an unknown previous send is not a new authorization.
    if (resumeOnly) throw Error('撤回尚未确认，保留原操作记录。');
    const result = await this.submit({ operation: 'revoke', gvid: binding.gvid, op, docId: binding.docId, epoch: binding.epoch });
    const observed = safeCurrent(result.data?.current);
    if (!observed || observed.active || !committed(result, op, 'revoke'))
      throw Error('协作板撤回尚未确认，请联网后重试。');
    await this.settings.saveCollabBinding(this.binding(binding.gvid, binding.path, observed));
    return observed;
  }

  resumeKnown(): void {
    for (const binding of this.settings.getCollabBindings()) {
      if (binding.kind || binding.revoked) continue;
      if (binding.pendingRevoke) {
        void this.withSource(binding.gvid, () => this.revokeSnapshot(binding, true)).catch(() => { /* keep the original action */ });
        continue;
      }
      const file = this.app.vault.getFileByPath(binding.path);
      if (file?.extension === 'md') this.onModify(file);
    }
  }

  private async syncSnapshot(file: TFile): Promise<void> {
    const source = await this.source(file);
    const { gvid, path } = source;
    await this.withSource(gvid, async () => {
      const binding = this.settings.getCollabBinding(gvid);
      if (!binding || binding.kind || binding.revoked || binding.pendingRevoke || binding.path !== path
        || this.settings.getCollabPendingActions().some(action => action.gvid === gvid)) return;
      const { response, current } = await this.readReceipt(gvid, binding.pending?.op);
      if (!current || current.server_doc_uuid !== binding.docId) return;
      if (current.source_kind || !current.active) {
        await this.settings.saveCollabBinding(this.binding(gvid, path, current));
        return;
      }
      if (current.epoch !== binding.epoch || current.source_locator_revision !== binding.locatorRevision) return;
      if (binding.pending) {
        if (!committed(response, binding.pending.op) || current.content_sha256 !== binding.pending.hash) return;
        await this.settings.saveCollabBinding({ ...binding, revision: current.revision, hash: binding.pending.hash, pending: undefined });
      } else if (current.revision !== binding.revision || current.content_sha256 !== binding.hash) return;

      const latest = this.settings.getCollabBinding(gvid)!;
      const hash = await hashMarkdown(source.text);
      if (hash === latest.hash || file.path !== path) return;
      const op = crypto.randomUUID();
      await this.settings.saveCollabBinding({ ...latest, pending: { op, hash } });
      const result = await this.call('PUT', '/' + encodeURIComponent(latest.docId) + '/content', {
        source_gvid: gvid, operation_id: op, source_locator: path,
        markdown: source.text, body_sha256: hash, expected_epoch: latest.epoch,
        expected_revision: latest.revision, expected_locator_revision: latest.locatorRevision,
      });
      const updated = safeCurrent(result.data?.current);
      if (updated?.source_kind && updated.server_doc_uuid === latest.docId) {
        await this.settings.saveCollabBinding(this.binding(gvid, path, updated));
      } else if (updated?.active && updated.server_doc_uuid === latest.docId
        && committed(result, op) && updated.content_sha256 === hash) {
        await this.settings.saveCollabBinding({ ...latest, revision: updated.revision, hash, pending: undefined });
      }
    });
  }
}
