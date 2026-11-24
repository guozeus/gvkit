import { App, TFile } from 'obsidian';
import { createGvid } from './fileIdCore';
import { ArrangeHistory, repairOriginal, uniqueOriginal } from './arrangeRecovery';
import type { ArrangeTrace } from './arrangeTrace';
import { activation, businessKey, clone, decodeV2, encodeV2, equal, operation, project, V2_ACTIVATION, V2_ROOT,
  type Activation, type ArrangeOperation, type OrderIntent, type Projection } from './arrangeV2';

/** Shared files are create-only Markdown; localStorage is this device's durable
 * outbox and last verified records. No Sync completion inference or v1 fallback. */
export class ArrangeV2Store {
  base: Activation | null = null;
  projection: Projection | null = null;
  private records = new Map<string, { raw: string; op: ArrangeOperation }>();
  private invalid = new Set<string>();
  private signatures = new Map<string, string>();
  private outbox = new Map<string, string>();
  private dirty = true;
  private baseRaw: string | null = null;
  private competing = new Set<string>();
  private history: ArrangeHistory;
  private key: string;
  constructor(private app: App, private storage: Storage | null, private trace?: ArrangeTrace) {
    this.history = new ArrangeHistory(app);
    this.key = `gvkit:arrange:v2:${app.vault.getName?.() ?? ''}:`;
    try {
      const raw = storage?.getItem(this.key + 'activation');
      if (raw) { this.base = activation(decodeV2(raw)); this.baseRaw = raw; }
    } catch { /* a bad activation must not hide this device's durable ops */ }
    try {
      for (let i = 0; storage && i < storage.length; i++) {
        const key = storage.key(i)!;
        if (!key.startsWith(this.key + 'op:')) continue;
        try {
          const raw = storage.getItem(key)!, op = operation(decodeV2(raw));
          if (key !== this.key + 'op:' + op.id) continue;
          this.records.set(op.id, { raw, op });
          if (storage.getItem(this.key + 'pending:' + op.id)) this.outbox.set(op.id, raw);
        } catch { /* preserve the invalid local bytes until a verified original arrives */ }
      }
    } catch { /* unavailable local storage does not prevent reading shared originals */ }
    this.rebuild();
  }
  invalidate(path: string): void { this.signatures.delete(path); }
  private remember(key: string, raw: string, required = false): void {
    try {
      if (!this.storage) throw Error('本机保存空间不可用');
      this.storage.setItem(this.key + key, raw);
      if (this.storage.getItem(this.key + key) !== raw) throw Error('本机保存读回不一致');
    } catch (error) { if (required) throw error; }
  }
  private rebuild(): void {
    if (!this.base || !this.dirty) return;
    this.projection = project(this.base, [...this.records.values()].map(x => x.op), new Set(this.invalid));
    this.dirty = false;
    if (this.projection.deferred.size || this.projection.conflicts.size || this.invalid.size)
      this.trace?.record('v2.projection.conflict', { stage: 'rebuild', size: this.invalid.size + this.projection.deferred.size + this.projection.conflicts.size });
  }
  private readOperation(raw: string, id: string): ArrangeOperation {
    const op = operation(decodeV2(raw));
    if (op.id !== id || op.epoch !== this.base?.epoch) throw Error('Wrong operation identity');
    return op;
  }
  private hasCompeting(key: string): boolean {
    try { return this.competing.has(key) || !!this.storage?.getItem(this.key + 'conflict:' + key); }
    catch { return true; }
  }
  private markCompeting(key: string, raw: string): void {
    this.competing.add(key);
    // Retain the first legal alternative across restarts; do not choose it.
    try { if (!this.storage?.getItem(this.key + 'conflict:' + key)) this.remember('conflict:' + key, raw); } catch { /* still isolated in memory */ }
  }
  private clearCompeting(key: string): void {
    this.competing.delete(key);
    try { this.storage?.removeItem(this.key + 'conflict:' + key); } catch { /* a later exact read can retry */ }
  }
  private restoreLocal(key: string, raw: string, validate: (raw: string) => unknown): void {
    const current = this.storage?.getItem(this.key + key);
    if (current === raw) return;
    if (current != null) {
      let valid = false;
      try { validate(current); valid = true; } catch { /* damaged copy */ }
      if (valid) { this.markCompeting(key, current); throw Error('Immutable local record changed'); }
      this.remember('recovery:' + key + ':' + createGvid(), current, true);
      if (this.storage?.getItem(this.key + key) !== current) throw Error('Local record changed during recovery');
    }
    this.remember(key, raw, current != null);
  }
  async load(): Promise<Projection | null> {
    const file = this.app.vault.getAbstractFileByPath(V2_ACTIVATION);
    try {
      if (file instanceof TFile) {
        let raw = await this.app.vault.read(file);
        let next: Activation;
        try { next = activation(decodeV2(raw)); }
        catch (error) {
          if (this.hasCompeting('activation')) throw error;
          if (this.baseRaw) {
            activation(decodeV2(this.baseRaw));
            this.restoreLocal('activation', this.baseRaw, value => activation(decodeV2(value)));
            raw = await repairOriginal(this.app, file, raw, this.baseRaw);
          } else {
            let epoch: unknown;
            try { epoch = (decodeV2(raw) as Partial<Activation>)?.epoch; } catch { /* unreadable envelope */ }
            raw = await this.history.recover(file, raw, sources => uniqueOriginal(sources, value => {
              const candidate = activation(decodeV2(value));
              if (typeof epoch === 'string' && candidate.epoch !== epoch) throw Error('Wrong activation epoch');
              return candidate;
            }));
          }
          next = activation(decodeV2(raw));
        }
        if (this.baseRaw && this.baseRaw !== raw) { this.markCompeting('activation', raw); throw Error('Activation is immutable'); }
        this.restoreLocal('activation', raw, value => activation(decodeV2(value)));
        if (!this.base) { this.base = next; this.dirty = true; }
        this.baseRaw = raw; this.clearCompeting('activation'); this.history.forget(file.path);
      }
    } catch (error) {
      this.trace?.failure('v2.activation.invalid', error);
      this.projection = null; this.dirty = true;
      return null;
    }
    if (!this.base) return null;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(V2_ROOT + '/ops/')) continue;
      const signature = `${file.stat?.mtime}:${file.stat?.size}`;
      const id = file.basename;
      if (!this.invalid.has(id) && this.signatures.get(file.path) === signature) continue;
      if (file.path !== `${V2_ROOT}/ops/${id}.md`) continue;
      try {
        let raw = await this.app.vault.read(file);
        const previous = this.records.get(id);
        let op: ArrangeOperation;
        try { op = this.readOperation(raw, id); }
        catch (error) {
          if (this.hasCompeting('op:' + id)) throw error;
          let envelope: Partial<ArrangeOperation> | undefined;
          try { envelope = decodeV2(raw) as Partial<ArrangeOperation>; } catch { /* unreadable envelope */ }
          if ((typeof envelope?.epoch === 'string' && envelope.epoch !== this.base.epoch)
            || (typeof envelope?.id === 'string' && envelope.id !== id)) throw Error('Wrong damaged record identity');
          // A structurally valid record of another identity/epoch is not damage
          // that we can decide to overwrite.
          let structurallyValid = false;
          try { operation(decodeV2(raw)); structurallyValid = true; } catch { /* malformed */ }
          if (structurallyValid) { this.markCompeting('op:' + id, raw); throw Error('Valid foreign record'); }
          if (previous) {
            this.readOperation(previous.raw, id);
            this.restoreLocal('op:' + id, previous.raw, value => operation(decodeV2(value)));
            raw = await repairOriginal(this.app, file, raw, previous.raw);
          } else {
            raw = await this.history.recover(file, raw, sources => uniqueOriginal(sources, value => this.readOperation(value, id)));
          }
          op = this.readOperation(raw, id);
        }
        if (previous && previous.raw !== raw) { this.markCompeting('op:' + id, raw); throw Error('Immutable record changed'); }
        this.restoreLocal('op:' + id, raw, value => operation(decodeV2(value)));
        if (!previous) { this.records.set(id, { raw, op }); this.dirty = true; }
        if (this.invalid.delete(id)) this.dirty = true;
        this.clearCompeting('op:' + id);
        this.history.forget(file.path);
        this.signatures.set(file.path, signature);
      } catch (error) {
        this.invalid.add(id); this.dirty = true;
        this.trace?.failure('v2.operation.invalid', error, { stage: 'read' });
      }
    }
    for (const [id, raw] of this.outbox) {
      if (this.invalid.has(id)) continue;
      try { this.readOperation(raw, id); await this.publish(id, raw); }
      catch (error) { this.trace?.failure('v2.outbox.fail', error, { operationId: id }); }
    }
    this.rebuild();
    return this.projection;
  }
  private async publish(id: string, raw: string): Promise<void> {
    const folder = V2_ROOT + '/ops';
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      try { await this.app.vault.createFolder(folder); }
      catch (error) { if (!this.app.vault.getAbstractFileByPath(folder)) throw error; }
    }
    const path = `${folder}/${id}.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      try { file = await this.app.vault.create(path, raw); }
      catch (error) { file = this.app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw error; }
    }
    if (await this.app.vault.read(file as TFile) !== raw) throw Error('操作读回不同，已保留本机原记录');
    this.outbox.delete(id);
    try { this.storage?.removeItem(this.key + 'pending:' + id); } catch { /* idempotent retry */ }
    this.trace?.record('v2.write.readback.ok', { operationId: id, epoch: this.base!.epoch });
  }
  async commit(changes: Record<string, unknown>, order?: OrderIntent, automatic?: ArrangeOperation['automatic'], resolves?: ArrangeOperation['resolves']): Promise<Projection> {
    if (!this.base || !this.projection) throw Error('配置正在等待同步，请稍后重试；普通事项仍可使用');
    const fields = [...Object.keys(changes), ...(order ? ['order'] : [])];
    if (automatic && !fields.includes('dailyGoal')) fields.push('dailyGoal');
    if (fields.some(field => this.projection!.pending.has(field) && !equal(resolves?.[field]?.slice().sort(), this.projection!.pending.get(field)))) throw Error('设置有冲突，请先点击“设置待确认”选择保留值');
    const expected = Object.fromEntries(fields.map(key => [key, this.projection!.versions[key] ?? '']));
    const op: ArrangeOperation = { schema: 2, epoch: this.base.epoch, id: createGvid(), clock: this.projection.clock + 1,
      parents: [...new Set(Object.values(expected).filter(Boolean))], expected, changes, ...(order ? { order } : {}), ...(automatic ? { automatic } : {}), ...(resolves ? { resolves } : {}) };
    operation(op);
    const raw = encodeV2(op);
    // Durability precedes shared creation. Recovery always retries these exact bytes/ID.
    this.remember('pending:' + op.id, '1', true);
    this.remember('op:' + op.id, raw, true);
    this.records.set(op.id, { raw, op }); this.outbox.set(op.id, raw); this.dirty = true;
    this.rebuild();
    try { await this.publish(op.id, raw); }
    catch (error) { this.trace?.failure('v2.outbox.fail', error, { operationId: op.id, epoch: op.epoch }); }
    if (!this.projection!.applied.has(op.id)) throw Error('设置尚未生效，请在“设置待确认”中检查');
    return this.projection!;
  }
  conflictChoices(field: string): { id: string; value: unknown; order?: OrderIntent }[] {
    return (this.projection?.pending.get(field) ?? []).flatMap(id => {
      const op = this.records.get(id)?.op;
      if (!op) return [];
      if (field === 'order') return op.order ? [{ id, value: op.order, order: op.order }] : [];
      return Object.prototype.hasOwnProperty.call(op.changes, field) ? [{ id, value: op.changes[field] }] : [];
    });
  }
  async resolve(field: string, ids: string[], choice?: string): Promise<Projection> {
    await this.load();
    if (!equal(ids, this.projection?.pending.get(field))) throw Error('冲突内容已变化，请重新打开确认');
    const selected = choice ? this.conflictChoices(field).find(value => value.id === choice) : undefined;
    if (choice && !selected) throw Error('待确认记录已变化，请重新打开确认');
    const state = this.projection!.state;
    const value = selected ? selected.value : field.startsWith('achieved:') ? state.achievedDays.includes(field.slice(9)) : (state as unknown as Record<string, unknown>)[field];
    return this.commit(field === 'order' ? {} : { [field]: field === 'specialReminderDay' ? value ?? null : value }, field === 'order' ? selected?.order ?? {kind:'remove',ids:[],pins:[]} : undefined, undefined, { [field]: ids });
  }
  get pending(): boolean { return this.outbox.size > 0; }
}
