import { App, TFile } from 'obsidian';
import { createGvid } from './fileIdCore';

/** Save the exact damaged bytes before a compare-and-replace. A later edit
 * wins the race; neither a backup nor a successful write substitutes for readback. */
export async function repairOriginal(app: App, file: TFile, damaged: string, restored: string): Promise<string> {
  const originalPath = file.path;
  const folder = 'settings/gvkit/arrange-v2/recovery';
  for (const path of ['settings', 'settings/gvkit', 'settings/gvkit/arrange-v2', folder]) {
    if (app.vault.getAbstractFileByPath(path)) continue;
    try { await app.vault.createFolder(path); }
    catch (error) { if (!app.vault.getAbstractFileByPath(path)) throw error; }
  }
  const backup = await app.vault.create(`${folder}/${file.name}.${createGvid()}.md`, damaged);
  if (await app.vault.read(backup) !== damaged) throw Error('异常原件备份读回不同');
  if (file.path !== originalPath || app.vault.getAbstractFileByPath(originalPath) !== file) return app.vault.read(file);
  await app.vault.process(file, current => current === damaged && file.path === originalPath ? restored : current);
  return app.vault.read(file);
}

type HistoryRecord = { path: string; ts: number; data: string };
type SyncItem = { uid: string | number; path: string; relatedpath?: string; deleted?: boolean; folder?: boolean };
interface HostSync {
  vaultId: string;
  ready: boolean;
  pause: boolean;
  gettingServer?: unknown;
  server?: { isConnected(): boolean };
  getHistory(path: string, last: null): Promise<{ items: SyncItem[]; more: boolean }>;
  getContentForVersion(uid: string | number): Promise<ArrayBuffer | null>;
}
interface HostRecovery {
  db?: { transaction(name: string, mode: 'readonly'): { store: { index(name: string): { getAll(path: string): Promise<HistoryRecord[]> } } } };
}
type HostApp = App & { internalPlugins?: { getEnabledPluginById(id: 'file-recovery' | 'sync'): unknown } };
type SelectOriginal = (sources: string[]) => string | null;
interface HistoryAttempt {
  damaged: string;
  sources: Set<string>;
  local?: Promise<string[]>;
  localAfter: number;
  remote?: Promise<void>;
  remoteAfter: number;
}
const HISTORY_RETRY_MS = 60_000;

/** Capability-checked adapters for the existing host histories. Only an abnormal
 * exact path reaches here. Network work never joins the list/operation queue. */
export class ArrangeHistory {
  private attempts = new Map<string, HistoryAttempt>();
  constructor(private app: App) {}
  forget(path: string): void { this.attempts.delete(path); }
  private plugin(id: 'file-recovery' | 'sync'): unknown {
    return (this.app as HostApp).internalPlugins?.getEnabledPluginById(id);
  }
  private async local(path: string): Promise<string[]> {
    try {
      const recovery = this.plugin('file-recovery') as HostRecovery | undefined;
      if (!recovery?.db) return [];
      // The latest snapshot alone cannot establish uniqueness.
      const rows = await recovery.db.transaction('backups', 'readonly').store.index('path').getAll(path);
      if (!Array.isArray(rows) || !rows.every(row => row?.path === path && typeof row.data === 'string' && Number.isFinite(row.ts))) return [];
      return rows.map(row => row.data);
    } catch { return []; }
  }
  private async remote(path: string): Promise<string[] | null> {
    const sync = this.plugin('sync') as HostSync | undefined;
    const server = sync?.server, vaultId = sync?.vaultId;
    // getHistory/getContentForVersion normally call getServer, which may connect.
    // Require the already-ready server before EACH call and after each await.
    const connected = () => !!sync && this.plugin('sync') === sync && !!vaultId && sync.vaultId === vaultId
      && sync.server === server && server?.isConnected?.() === true && sync.ready === true && !sync.pause && !sync.gettingServer;
    if (!connected() || typeof sync?.getHistory !== 'function' || typeof sync.getContentForVersion !== 'function') return null;
    const result = await sync.getHistory(path, null);
    if (!connected() || result?.more !== false || !Array.isArray(result.items)
      || !result.items.every(item => item?.path === path && !item.relatedpath && !item.deleted && !item.folder
        && (typeof item.uid === 'string' || typeof item.uid === 'number'))) return null;
    const originals: string[] = [];
    for (const item of result.items) {
      if (!connected()) return null;
      const bytes = await sync.getContentForVersion(item.uid);
      if (!connected() || !(bytes instanceof ArrayBuffer)) return null;
      originals.push(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    }
    return originals;
  }
  async recover(file: TFile, damaged: string, select: SelectOriginal): Promise<string> {
    const path = file.path;
    let attempt = this.attempts.get(path);
    if (!attempt || attempt.damaged !== damaged) {
      attempt = { damaged, sources: new Set(), localAfter: 0, remoteAfter: 0 };
      this.attempts.set(path, attempt);
    }
    const current = attempt;
    if (!attempt.local || Date.now() >= attempt.localAfter) {
      attempt.localAfter = Infinity; // dedupe even if another load arrives mid-read
      attempt.local = this.local(path).then(sources => {
        for (const raw of sources) current.sources.add(raw);
        return sources;
      }).finally(() => { current.localAfter = Date.now() + HISTORY_RETRY_MS; });
    }
    await attempt.local;
    const candidate = select([...attempt.sources]);
    if (candidate !== null) return repairOriginal(this.app, file, damaged, candidate);
    let sync: HostSync | undefined;
    try { sync = this.plugin('sync') as HostSync | undefined; } catch { /* capability unavailable */ }
    if (sync?.ready && !sync.pause && sync.server?.isConnected?.() === true && !sync.gettingServer
      && !attempt.remote && Date.now() >= attempt.remoteAfter) {
      attempt.remote = this.remote(path).then(async sources => {
        if (!sources || this.attempts.get(path) !== current || file.path !== path) return;
        for (const raw of sources) current.sources.add(raw);
        const original = select([...current.sources]);
        if (original !== null) await repairOriginal(this.app, file, damaged, original);
      }).catch(() => { /* offline, unsupported, incomplete: preserve the current original */ })
        .finally(() => { current.remote = undefined; current.remoteAfter = Date.now() + HISTORY_RETRY_MS; });
    }
    return damaged;
  }
}

/** Different legal bytes are different immutable records, even if their parsed
 * values look similar. Never turn the latest timestamp into a tie breaker. */
export function uniqueOriginal(sources: string[], validate: (raw: string) => unknown): string | null {
  const valid = new Set<string>();
  for (const raw of sources) { try { validate(raw); valid.add(raw); } catch { /* unusable history */ } }
  return valid.size === 1 ? [...valid][0]! : null;
}
