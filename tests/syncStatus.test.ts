import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

async function module() {
 const built = await build({ entryPoints: ['src/syncStatus.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'obsidian-ui', setup(builder) {
   builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
   builder.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export class Notice {} export function setIcon(el,icon){el.dataset.icon=icon;}' }));
  } }],
 });
 const result = { exports: {} as any };
 new Function('module', 'exports', built.outputFiles[0]!.text)(result, result.exports);
 return result.exports;
}
function events() {
 const listeners = new Map<string, Set<() => void>>();
 return {
  on(name: string, callback: () => void) {
   const group = listeners.get(name) ?? new Set(); group.add(callback); listeners.set(name, group);
   return { name, callback };
  },
  offref(ref: any) { listeners.get(ref.name)?.delete(ref.callback); },
  emit(name: string) { for (const callback of listeners.get(name) ?? []) callback(); },
  count(name: string) { return listeners.get(name)?.size ?? 0; },
 };
}

test('host completion requires its current ready connection, with explicit unavailable and disabled states', async () => {
 const { syncState } = await module();
 const host: any = { getStatus: () => 'synced', ready: true, server: { isConnected: () => true } };
 assert.equal(syncState(host), 'synced');
 host.syncStatus = 'Connecting to server'; assert.equal(syncState(host), 'connecting');
 delete host.syncStatus; host.ready = false; assert.equal(syncState(host), 'connecting');
 host.ready = true; host.server.isConnected = () => false; assert.equal(syncState(host), 'disconnected');
 host.server.isConnected = () => true; assert.equal(syncState(host, false), 'disconnected');
 for (const state of ['uninitialized', 'disconnected', 'error', 'paused', 'syncing']) {
  host.getStatus = () => state; assert.equal(syncState(host), state);
 }
 host.getStatus = () => 'future-state'; assert.equal(syncState(host), 'unknown');
 host.getStatus = () => { throw Error('unavailable'); }; assert.equal(syncState(host), 'unknown');
 assert.equal(syncState({}), 'unknown'); assert.equal(syncState(undefined), 'unknown'); assert.equal(syncState(null), 'disabled');
});

test('one header status follows any active view, refreshes on host and foreground events, and fully detaches', async () => {
 const { registerSyncStatus } = await module();
 const win = new Window(), doc = win.document;
 const workspaceEvents = events(), managerEvents = events(), hostEvents = events();
 let state = 'synced', clicks = 0;
 const host: any = { ...hostEvents, ready: true, server: { isConnected: () => true }, getStatus: () => state, showSyncLog: () => clicks++ };
 let selected: any = host;
 const manager: any = { ...managerEvents, getEnabledPluginById: (id: string) => { assert.equal(id, 'sync'); return selected; } };
 const container = doc.createElement('main'); doc.body.append(container);
 const page = () => {
  const containerEl = doc.createElement('section');
  containerEl.innerHTML = '<div class="view-header"><div class="view-header-title-container">Note</div><div class="view-actions"><button>More</button></div></div>';
  container.append(containerEl); return { view: { containerEl } };
 };
 const first = page(), second = page(); let active = first;
 const disposers: (() => void)[] = []; let ready!: () => void;
 const workspace: any = { ...workspaceEvents, containerEl: container, getMostRecentLeaf: () => active, onLayoutReady: (fn: () => void) => { ready = fn; } };
 const settings: string[] = [];
 const plugin: any = { app: { internalPlugins: manager, workspace, setting: { open: () => settings.push('open'), openTabById: (id: string) => settings.push(id) } },
  register: (fn: () => void) => disposers.push(fn),
  registerEvent: (ref: any) => disposers.push(() => workspace.offref(ref)),
  registerDomEvent: (el: any, type: string, fn: any) => { el.addEventListener(type, fn); disposers.push(() => el.removeEventListener(type, fn)); },
 };
 try {
  registerSyncStatus(plugin); ready();
  const button = doc.querySelector<HTMLButtonElement>('.gvkit-sync-status')!;
  assert.equal(button.dataset.state, 'synced'); assert.match(button.textContent!, /已同步/);
  assert.equal(first.view.containerEl.contains(button), true); button.click(); assert.equal(clicks, 1);
  state = 'syncing'; host.emit('status-change'); assert.equal(button.dataset.state, 'syncing');
  state = 'error'; host.emit('status-change'); assert.equal(button.dataset.state, 'error');
  state = 'synced'; host.syncStatus = 'Connecting to server'; host.emit('status-change'); assert.equal(button.dataset.state, 'connecting');
  delete host.syncStatus; doc.dispatchEvent(new win.Event('visibilitychange')); assert.equal(button.dataset.state, 'synced');
  active = second; workspace.emit('active-leaf-change'); workspace.emit('layout-change');
  assert.equal(second.view.containerEl.contains(button), true); assert.equal(doc.querySelectorAll('.gvkit-sync-status').length, 1);
  Object.defineProperty(win.navigator, 'onLine', { configurable: true, value: false });
  win.dispatchEvent(new win.Event('offline')); assert.equal(button.dataset.state, 'disconnected');
  Object.defineProperty(win.navigator, 'onLine', { configurable: true, value: true });
  win.dispatchEvent(new win.Event('online')); assert.equal(button.dataset.state, 'synced');
  selected = null; manager.emit('change'); assert.equal(button.dataset.state, 'disabled'); assert.equal(host.count('status-change'), 0);
  button.click(); assert.deepEqual(settings, ['open', 'core-plugins']);
  selected = { ...events(), getStatus: () => 'paused' }; manager.emit('change'); assert.equal(button.dataset.state, 'paused');
  assert.equal(selected.count('status-change'), 1); assert.equal(clicks, 1);
  manager.getEnabledPluginById = () => { throw Error('capability changed'); }; manager.emit('change'); assert.equal(button.dataset.state, 'unknown');
  for (const dispose of disposers.reverse()) dispose(); ready();
  assert.equal(doc.querySelector('.gvkit-sync-status'), null);
  assert.equal(manager.count('change'), 0); assert.equal(host.count('status-change'), 0);
 } finally { await win.happyDOM.close(); }
});
