import { Notice, setIcon, type App, type EventRef, type Plugin } from 'obsidian';

interface NativeEvents {
 on?(name: string, callback: () => void): EventRef;
 offref?(ref: EventRef): void;
}
export interface NativeSync extends NativeEvents {
 getStatus?(): unknown;
 syncStatus?: string;
 ready?: boolean;
 gettingServer?: unknown;
 server?: { isConnected?(): boolean; isConnecting?(): boolean } | null;
 showSyncLog?(): void;
}
interface NativePlugins extends NativeEvents {
 getEnabledPluginById?(id: string): NativeSync | null;
}
type SyncApp = App & {
 internalPlugins?: NativePlugins;
 setting?: { open(): void; openTabById(id: string): void };
};
const states = {
 uninitialized: { text: '初始化中', icon: 'refresh-cw' },
 disconnected: { text: '未连接', icon: 'cloud-off' },
 error: { text: '同步异常', icon: 'alert-circle' },
 paused: { text: '已暂停', icon: 'pause' },
 syncing: { text: '同步中', icon: 'refresh-cw' },
 connecting: { text: '连接中', icon: 'refresh-cw' },
 synced: { text: '已同步', icon: 'check' },
 disabled: { text: '同步未启用', icon: 'cloud-off' },
 unknown: { text: '同步状态未知', icon: 'circle-help' },
} as const;
type SyncState = keyof typeof states;

/** The host getStatus can say synced while its server is still connecting.
 * Only the current ready connection can support the completed presentation. */
export function syncState(sync: NativeSync | null | undefined, online = true): SyncState {
 if (sync === null) return 'disabled';
 if (!sync || typeof sync.getStatus !== 'function') return 'unknown';
 try {
  const state = sync.getStatus();
  if (state === 'uninitialized' || state === 'disconnected' || state === 'error' || state === 'paused') return state;
  if (!online) return 'disconnected';
  if (sync.syncStatus === 'Connecting to server' || sync.gettingServer || sync.server?.isConnecting?.()) return 'connecting';
  if (state === 'syncing') return 'syncing';
  if (state !== 'synced' || typeof sync.server?.isConnected !== 'function') return 'unknown';
  if (!sync.server.isConnected()) return 'disconnected';
  return sync.ready === true ? 'synced' : 'connecting';
 } catch { return 'unknown'; }
}

/** A single native header control follows the active document on every device. */
export function registerSyncStatus(plugin: Plugin): void {
 const app = plugin.app as SyncApp;
 const manager = app.internalPlugins;
 let sync: NativeSync | null | undefined;
 let statusRef: EventRef | null = null;
 let button: HTMLButtonElement | null = null;
 let icon: HTMLElement | null = null;
 let label: HTMLElement | null = null;
 let disposed = false;
 const detach = () => {
  if (statusRef) sync?.offref?.(statusRef);
  statusRef = null;
 };
 const current = (): NativeSync | null | undefined => {
  try { return manager?.getEnabledPluginById?.('sync'); }
  catch { return undefined; }
 };
 const open = () => {
  try {
   const active = current();
   if (typeof active?.showSyncLog === 'function') active.showSyncLog();
   else { app.setting?.open(); app.setting?.openTabById(active ? 'sync' : 'core-plugins'); }
  } catch { new Notice('无法打开同步状态，请在 Obsidian 设置中查看同步'); }
 };
 const refresh = () => {
  if (disposed) return;
  const next = current();
  if (next !== sync) {
   detach(); sync = next;
   if (typeof sync?.on === 'function' && typeof sync.offref === 'function') statusRef = sync.on('status-change', refresh);
  }
  const view = app.workspace.getMostRecentLeaf()?.view;
  const parent = view?.containerEl.querySelector<HTMLElement>('.view-header .view-actions')
   ?? view?.containerEl.querySelector<HTMLElement>('.view-header');
  if (!parent) { button?.remove(); return; }
  const doc = parent.ownerDocument;
  if (!button) {
   button = doc.createElement('button');
   button.type = 'button'; button.className = 'gvkit-sync-status clickable-icon';
   icon = button.appendChild(doc.createElement('span')); icon.setAttribute('aria-hidden', 'true');
   label = button.appendChild(doc.createElement('span')); label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
   button.onclick = open;
  }
  if (button.parentElement !== parent) parent.prepend(button);
  const state = syncState(sync, doc.defaultView?.navigator.onLine !== false);
  const presentation = states[state];
  if (button.dataset.state !== state) {
   button.dataset.state = state;
   setIcon(icon!, presentation.icon); label!.textContent = presentation.text;
   button.title = `Obsidian Sync · ${presentation.text}`;
   button.setAttribute('aria-label', `${button.title}，查看同步日志或设置`);
  }
 };
 const listen = (doc: Document) => {
  plugin.registerDomEvent(doc, 'visibilitychange', refresh);
  const win = doc.defaultView;
  if (win) {
   plugin.registerDomEvent(win, 'focus', refresh);
   plugin.registerDomEvent(win, 'online', refresh);
   plugin.registerDomEvent(win, 'offline', refresh);
  }
 };
 if (typeof manager?.on === 'function' && typeof manager.offref === 'function') {
  const ref = manager.on('change', refresh);
  plugin.register(() => manager.offref!(ref));
 }
 plugin.registerEvent(app.workspace.on('active-leaf-change', refresh));
 plugin.registerEvent(app.workspace.on('layout-change', refresh));
 plugin.registerEvent(app.workspace.on('window-open', (_win, win) => listen(win.document)));
 listen(app.workspace.containerEl.ownerDocument);
 plugin.register(() => { disposed = true; detach(); button?.remove(); });
 app.workspace.onLayoutReady(refresh);
}
