import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Real view + Store, disk-backed test Vault. No user information is accessed.
const shim = `
export class ItemView {
 constructor(leaf) { Object.assign(this, leaf); this.disposers=[]; }
 register(fn) { this.disposers.push(fn); } registerEvent(ref) { this.register(()=>ref.off?.()); }
 // Keep this long disk/UI fixture independent of the wall-clock minute repaint.
 registerInterval(id) { window.clearInterval(id); }
 registerDomEvent(el,type,fn,options) { el.addEventListener(type,fn,options); this.register(()=>el.removeEventListener(type,fn,options)); }
}
export const Platform={isMobileApp:true,isIosApp:false,isTablet:false};
export class Scope {
 constructor(parent) { this.parent=parent;this.handlers=[]; }
 register(modifiers,key,func) { const handler={modifiers,key,func};this.handlers.push(handler);return handler; }
}
export class Modal {
 constructor() { this.contentEl=document.createElement('div'); }
 setTitle() {} open() { window.lastModal=this;document.body.append(this.contentEl); if(this.contentEl.classList.contains('gvkit-arrange-date-menu')) window.dateMenus=(window.dateMenus??0)+1; } close() { this.contentEl.remove(); this.onClose?.(); }
}
export class Menu {
 constructor(){this.entries=[];}
 addItem(fn){const entry={setTitle(v){this.title=v;return this},setIcon(){return this},setDisabled(){return this},onClick(fn){this.click=fn;return this}};fn(entry);this.entries.push(entry);return this;}
 showAtMouseEvent(event){(window.menus??=[]).push({entries:this.entries,x:event.clientX,y:event.clientY,type:event.constructor.name});}
} export class Setting {
 constructor(el){this.el=el;} addButton(fn){const el=this.el.createEl('button'); const b={setButtonText(t){el.textContent=t;return this},setCta(){return this},onClick(f){el.onclick=f;return this}};fn(b);return this;}
}
export class Notice { constructor(message) { (window.notices ??= []).push(message); } }
export class TFile { constructor(path) { this.path=path;this.name=path.split('/').pop();this.basename=this.name.slice(0,-3); } }
export class TFolder {} export class Plugin {} export class WorkspaceLeaf {}
export const setIcon=(el,icon)=>{el.dataset.icon=icon};
export const MarkdownRenderer={render:async(app,text,el)=>{el.textContent=text}};
export function sanitizeHTMLToDom(html) { const el=document.createElement('template');el.innerHTML=html;return el.content; }
export function getFrontMatterInfo(s) { const end=s.indexOf('\\n---',4);return s.startsWith('---\\n')&&end>=0?{exists:true,frontmatter:s.slice(4,end),contentStart:end+5}:{exists:false,frontmatter:'',contentStart:0}; }
export const parseYaml=JSON.parse;
export const stringifyYaml=value=>JSON.stringify(value,null,2)+'\\n';
`;

test('list drag preview follows the viewport while ordinary gestures and reminder rows remain usable', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'gvkit-list-test-'));
	const window = new Window();
	const globals = new Map(['window', 'document', 'MouseEvent', 'navigator', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'Node', 'NodeFilter', 'Text', 'HTMLElement', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	let view: any;
	try {
		Object.assign(globalThis, { window, document: window.document, MouseEvent: window.MouseEvent });
		for (const key of ['MutationObserver', 'ResizeObserver', 'Node', 'NodeFilter', 'Text', 'HTMLElement']) (globalThis as any)[key] = (window as any)[key];
		Object.assign(globalThis, { requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), getComputedStyle: window.getComputedStyle.bind(window) });
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => {
		} } } });
		const proto: any = window.HTMLElement.prototype;
		proto.empty = function () { this.replaceChildren(); };
		proto.addClass = function (...names: string[]) { this.classList.add(...names); };
		proto.removeClass = function (...names: string[]) { this.classList.remove(...names); };
		proto.toggleClass = function (name: string, on: boolean) { this.classList.toggle(name, on); };
		proto.createEl = function (tag: string, options: any = {}) {
			if (typeof options === 'string') options = { cls: options };
			const el = window.document.createElement(tag);
			if (options.cls) el.className = options.cls;
			if (options.text) el.textContent = options.text;
			if (options.value !== undefined) (el as any).value = options.value;
			if (options.type) (el as any).type = options.type;
			for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
			this.append(el); return el;
		};
		proto.createDiv = function (options: unknown) { return this.createEl('div', options); };
		proto.createSpan = function (options: unknown) { return this.createEl('span', options); };
		proto.scrollIntoView = () => {};
		await build({ stdin: { contents: `export {ArrangeView} from './src/arrangeView';export {defaultArrangeState} from './src/arrangeCore';export {V2_ACTIVATION,encodeV2} from './src/arrangeV2';export {ArrangeDatePicker} from './src/arrangeDatePicker';export {ArrangeStore} from './src/arrangeStore';export {TFile,TFolder,Platform} from 'obsidian';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'view.mjs'), plugins: [{ name: 'test-vault', setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
			b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: shim, loader: 'js' }));
		} }] });
		const { ArrangeView, ArrangeStore, TFile, TFolder, defaultArrangeState, V2_ACTIVATION, encodeV2, Platform: platform } = await import(pathToFileURL(join(dir, 'view.mjs')).href);
		const files = new Map<string, any>();
		for (const path of ['安排/待执行', '安排/已完成', '安排/历史', 'settings/gvkit']) files.set(path, new TFolder());
		const disk = (path: string) => join(dir, encodeURIComponent(path));
		const vaultEvents = new Map<string, ((file: any) => void)[]>();
		const vault = {
			on: (name: string, callback: (file: any) => void) => {
				vaultEvents.set(name, [...vaultEvents.get(name) ?? [], callback]); return {};
			}, getMarkdownFiles: () => [...files.values()].filter(f => f instanceof TFile),
			getAbstractFileByPath: (path: string) => files.get(path), read: (file: any) => readFile(disk(file.path), 'utf8'),
			createFolder: async (path: string) => { files.set(path, new TFolder()); },
			create: async (path: string, source: string) => { await writeFile(disk(path), source); const f = new TFile(path); files.set(path, f); return f; },
			process: async (file: any, change: (source: string) => string) => {
				await writeFile(disk(file.path), change(await vault.read(file)));
			},
		};
		let active = true;
		const events = new Map<string, () => void>();
		const listeners = new Map<string, Set<() => void>>();
		const app = { vault, fileManager: { renameFile: async (file: any, path: string) => {
			await rename(disk(file.path), disk(path)); files.delete(file.path); file.path = path; files.set(path, file);
		} }, workspace: { onLayoutReady: (fn: () => void) => fn(), getActiveViewOfType: () => active ? view : null,
			on: (name: string, callback: () => void) => {
				const group = listeners.get(name) ?? new Set<() => void>(); listeners.set(name, group); group.add(callback);
				events.set(name, () => { for (const fn of group) fn(); }); return { off: () => group.delete(callback) };
			} } };
		await vault.createFolder('settings/gvkit/arrange-v2');
		await vault.create(V2_ACTIVATION, encodeV2({ schema: 2, epoch: 'list-fixture', state: defaultArrangeState(), legacy: '' }));
		const store = new ArrangeStore(app); await store.load();
		const parent = await store.create('Parent', null);
		const first = await store.create('Child', parent);
		const second = await store.create('Row', null);
		const host = window.document.createElement('div'); window.document.body.append(host);
		host.innerHTML = '<div class="view-header"><div class="view-header-title-container"><div class="view-header-title">Arrange</div></div></div>';
		const root = window.document.createElement('main'); host.append(root);
		view = new ArrangeView({ app, contentEl: root, containerEl: host }, store); await view.onOpen();
		const css = window.document.createElement('style'); css.textContent = await readFile('styles.css', 'utf8'); window.document.head.append(css);
		await store.toggleSpecialReminder(first); await view.reload();
		assert.ok(view.list.querySelector(`[data-id="${first}"].is-special-reminder`));
		await view.select(parent);
		assert.ok(view.children.querySelector(`[data-id="${first}"].is-special-reminder`));
		await store.toggleSpecialReminder(first); await view.reload(); await view.select(null);
		assert.equal(view.list.querySelector(`[data-id="${first}"].is-special-reminder`), null);
		const waitHold = () => new Promise(resolve => setTimeout(resolve, 410));
		const pointer = (el: any, type: string, x: number, y: number) => el.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y }));
		let label = root.querySelector<HTMLElement>(`[data-id="${second}"] .gvkit-arrange-title`)!;
		const target = root.querySelector<HTMLElement>(`[data-id="${first}"]`)!;
		target.getBoundingClientRect = () => ({ top: 100, height: 44 } as any);
		window.document.elementFromPoint = () => target as any;
		// Scrolling the source cannot move the viewport preview away from a held finger.
		label = root.querySelector<HTMLElement>(`[data-id="${second}"] .gvkit-arrange-title`)!;
		const sourceRow = label.parentElement!;
		const sourceBounds = sourceRow.getBoundingClientRect;
		const listBounds = view.list.getBoundingClientRect;
		sourceRow.getBoundingClientRect = () => ({ top: 80, left: 12, width: 300, height: 44 } as any);
		view.list.getBoundingClientRect = () => ({ top: 60, bottom: 300, height: 240 } as any);
		view.list.scrollTop = 120;
		const dragTouch = (el: any, type: string, x: number, y: number) => {
			const event = new window.Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, { touches: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] });
			el.dispatchEvent(event); return event;
		};
		dragTouch(label, 'touchstart', 100, 100); await waitHold();
		assert.equal(dragTouch(label, 'touchmove', 110, 280).defaultPrevented, true);
		const dragPreview = window.document.querySelector<HTMLElement>('.gvkit-arrange-drag-preview')!;
		assert.equal(dragPreview.parentElement, window.document.body);
		assert.equal(dragPreview.style.top, '80px');
		assert.equal(dragPreview.style.width, '300px');
		assert.equal(dragPreview.style.transform, 'translate3d(10px, 180px, 0)');
		assert.equal(sourceRow.style.transform, '');
		assert.equal(view.list.scrollTop, 134, 'only the edge zone scrolls the list');
		view.list.scrollTop = 200;
		dragTouch(label, 'touchmove', 110, 290);
		assert.equal(dragPreview.style.transform, 'translate3d(10px, 190px, 0)');
		assert.equal(sourceRow.style.transform, '');
		dragTouch(label, 'touchcancel', 110, 290);
		assert.equal(window.document.querySelector('.gvkit-arrange-drag-preview'), null);
		assert.equal(sourceRow.classList.contains('is-dragging'), false);
		sourceRow.getBoundingClientRect = sourceBounds; view.list.getBoundingClientRect = listBounds;
		view.list.scrollTop = 0;
		// A short touch move remains native scrolling, a stationary hold enters multiselect.
		dragTouch(label, 'touchstart', 100, 100);
		assert.equal(dragTouch(label, 'touchmove', 100, 140).defaultPrevented, false);
		dragTouch(label, 'touchend', 100, 140);
		assert.equal(window.document.querySelector('.gvkit-arrange-drag-preview'), null);
		dragTouch(label, 'touchstart', 100, 100); await waitHold(); dragTouch(label, 'touchend', 100, 100);
		assert.equal(view.multi.has(second), true); assert.equal(view.multiPreview, false);
		view.setMulti([]);
		await store.configure({ swipeAction: 'top' }); await view.reload();
		label = root.querySelector<HTMLElement>(`[data-id="${second}"] .gvkit-arrange-title`)!;
		const originalAction = view.action; let swipeAction = '';
		view.action = (key: string) => { swipeAction = key; };
		dragTouch(label, 'touchstart', 100, 100);
		assert.equal(dragTouch(label, 'touchmove', 20, 100).defaultPrevented, true);
		dragTouch(label, 'touchend', 20, 100);
		assert.equal(swipeAction, 'top'); assert.equal(window.document.querySelector('.gvkit-arrange-drag-preview'), null);
		view.action = originalAction;
		await view.select(parent);
		const childLabel = view.children.querySelector<HTMLElement>(`[data-id="${first}"] .gvkit-arrange-title`)!;
		dragTouch(childLabel, 'touchstart', 100, 100); await waitHold(); dragTouch(childLabel, 'touchmove', 100, 140);
		assert.ok(window.document.querySelector('.gvkit-arrange-drag-preview'));
		assert.equal(childLabel.parentElement!.style.transform, ''); assert.equal(view.detail.style.transform, '');
		dragTouch(childLabel, 'touchcancel', 100, 140); await view.select(null);
		label = root.querySelector<HTMLElement>(`[data-id="${second}"] .gvkit-arrange-title`)!;
		platform.isMobileApp = false;
		const desktopTarget = view.list.querySelector(`[data-id="${first}"]`)!;
		desktopTarget.getBoundingClientRect = () => ({ top: 100, height: 44 } as any);
		window.document.elementFromPoint = () => desktopTarget;
		pointer(label, 'pointerdown', 100, 100); pointer(window.document, 'pointermove', 100, 140);
		assert.ok(window.document.querySelector('.gvkit-arrange-drag-preview'));
		pointer(window.document, 'pointerup', 100, 140);
		while (view.busy) await new Promise(resolve => setTimeout(resolve, 1));
		assert.equal(window.document.querySelector('.gvkit-arrange-drag-preview'), null);
		assert.equal(store.state.order.indexOf(second), store.state.order.indexOf(first) + 1);
	} finally {
		if (view && !view.closed) await view.onClose();
		view?.disposers.forEach((fn: () => void) => fn());
		await window.happyDOM.close();
		for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
		await rm(dir, { recursive: true, force: true });
	}
});
