import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// Real view + Store, disk-backed test Vault. No user information is accessed.
const shim = `
export class ItemView {
 constructor(leaf) { Object.assign(this, leaf); this.disposers=[]; }
 register(fn) { this.disposers.push(fn); } registerEvent() {}
 registerInterval(id) { this.register(()=>window.clearInterval(id)); }
 registerDomEvent(el,type,fn) { el.addEventListener(type,fn); this.register(()=>el.removeEventListener(type,fn)); }
}
export const Platform={isMobileApp:true,isIosApp:false};
export class Modal {
 constructor() { this.contentEl=document.createElement('div'); }
 setTitle() {} open() { document.body.append(this.contentEl); } close() { this.contentEl.remove(); }
}
export class Menu {
 constructor(){this.entries=[];}
 addItem(fn){const entry={setTitle(v){this.title=v;return this},setIcon(){return this},setDisabled(){return this},onClick(fn){this.click=fn;return this}};fn(entry);this.entries.push(entry);return this;}
 showAtMouseEvent(event){(window.menus??=[]).push({entries:this.entries,x:event.clientX,y:event.clientY,type:event.constructor.name});}
} export class Setting {}
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

test('inline edits persist to Markdown, switch safely, and retain drafts on invalid or failed saves', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'gvkit-detail-test-'));
	const window = new Window();
	const globals = new Map(['window', 'document', 'MouseEvent', 'navigator', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'Node', 'HTMLElement', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	let view: any;
	try {
		Object.assign(globalThis, { window, document: window.document, MouseEvent: window.MouseEvent });
		for (const key of ['MutationObserver', 'Node', 'HTMLElement']) (globalThis as any)[key] = (window as any)[key];
		Object.assign(globalThis, { requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), getComputedStyle: window.getComputedStyle.bind(window) });
		const copied: string[] = [];
		let copyFails = false;
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => {
			if (copyFails) throw Error('clipboard unavailable');
			copied.push(text);
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
		await build({ stdin: { contents: `export {ArrangeView} from './src/arrangeView';export {ArrangeStore} from './src/arrangeStore';export {TFile,TFolder,Platform} from 'obsidian';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'view.mjs'), plugins: [{ name: 'test-vault', setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
			b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: shim, loader: 'js' }));
		} }] });
		const { ArrangeView, ArrangeStore, TFile, TFolder } = await import(pathToFileURL(join(dir, 'view.mjs')).href);
		const files = new Map<string, any>();
		for (const path of ['安排/待执行', '安排/已完成', '安排/历史', 'settings/gvkit']) files.set(path, new TFolder());
		const disk = (path: string) => join(dir, encodeURIComponent(path));
		let fail = false;
		let pause: (() => Promise<void>) | null = null;
		const vaultEvents = new Map<string, ((file: any) => void)[]>();
		const vault = {
			on: (name: string, callback: (file: any) => void) => {
				vaultEvents.set(name, [...vaultEvents.get(name) ?? [], callback]); return {};
			}, getMarkdownFiles: () => [...files.values()].filter(f => f instanceof TFile),
			getAbstractFileByPath: (path: string) => files.get(path), read: (file: any) => readFile(disk(file.path), 'utf8'),
			createFolder: async (path: string) => { files.set(path, new TFolder()); },
			create: async (path: string, source: string) => { await writeFile(disk(path), source); const f = new TFile(path); files.set(path, f); return f; },
			process: async (file: any, change: (source: string) => string) => {
				if (fail) throw Error('模拟写入失败');
				if (pause) await pause();
				await writeFile(disk(file.path), change(await vault.read(file)));
			},
		};
		let active = true;
		const events = new Map<string, () => void>();
		const app = { vault, fileManager: { renameFile: async (file: any, path: string) => {
			await rename(disk(file.path), disk(path)); files.delete(file.path); file.path = path; files.set(path, file);
		} }, workspace: { getActiveViewOfType: () => active ? view : null,
			on: (name: string, callback: () => void) => { events.set(name, callback); return {}; } } };
		const store = new ArrangeStore(app);
		assert.equal(store.state.rootItemStyle, 'background');
		await store.configure({ rootItemStyle: 'text' });
		const rootStyleReload = new ArrangeStore(app); await rootStyleReload.load();
		assert.equal(rootStyleReload.state.rootItemStyle, 'text');
		await store.configure({ rootItemStyle: 'background' });
		assert.equal(store.state.composerMaxRows, 6);
		assert.equal(store.state.bodyMinRows, 3);
		await store.configure({ composerMaxRows: 4, bodyMinRows: 2 });
		const settingsReload = new ArrangeStore(app); await settingsReload.load();
		assert.equal(settingsReload.state.composerMaxRows, 4);
		assert.equal(settingsReload.state.bodyMinRows, 2);
		await store.configure({ composerMaxRows: 6, bodyMinRows: 3 });
		const parent = await store.create('父事项', null);
		const first = await store.create('第一项完整标题', parent);
		const second = await store.create('第二项', null);
		const host = window.document.createElement('div'); window.document.body.append(host);
		host.innerHTML = '<div class="view-header"><button id="nav">导航</button><div class="view-header-title-container"><div class="view-header-title">自御安排</div></div><button id="native-more">宿主更多</button></div>';
		const hostHeader = host.querySelector<HTMLElement>('.view-header')!;
		hostHeader.getBoundingClientRect = () => ({ height: 44 } as any);
		const root = window.document.createElement('main'); host.append(root);
		view = new ArrangeView({ app, contentEl: root, containerEl: host }, store); await view.onOpen();
		// Exercise real menu actions, persistence, deep descendants and intersecting filters.
		{
		const grandchild = await store.create('孙事项', first);
		const completedChild = await store.create('已完成下级', second);
		await store.complete(completedChild, true);
		await view.reload();
		const stableOrder = [...store.state.order], stableFacts = store.facts();
		const stableRelations = store.items.map((item: any) => [item.id, item.parent, item.completedAt]);
		const visible = () => [...view.list.querySelectorAll('.gvkit-arrange-row')].map((row: any) => row.dataset.id);
		const chooseHierarchy = (label: string) => {
			view.hierarchyButton.click();
			window.menus.at(-1).entries.find((entry: any) => entry.title.replace('✓ ', '') === label).click();
		};
		assert.equal(view.hierarchyButton.nextElementSibling, view.searchButton);
		view.itemMenu(store.items.find((item: any) => item.id === parent), new window.MouseEvent('click'));
		const projectAction = [...window.document.querySelectorAll('.gvkit-arrange-menu-action')].find(button => button.textContent === '开发工程') as any;
		assert.ok(projectAction); projectAction.click();
		while (view.busy) await new Promise(resolve => setTimeout(resolve, 1));
		assert.equal(store.items.find((item: any) => item.id === parent).developmentProject, true);
		assert.equal(store.items.find((item: any) => item.id === parent).developmentCompleted, false);
		assert.ok(visible().includes(parent)); assert.ok(!visible().includes(first)); assert.ok(!visible().includes(grandchild));
		assert.ok(view.list.querySelector(`[data-id="${parent}"].is-development-project`));
		await view.select(parent);
		assert.ok(view.children.querySelector(`[data-id="${first}"]`));
		assert.equal(view.children.querySelector(`[data-id="${grandchild}"]`), null);
		assert.ok(view.detail.querySelector('.gvkit-arrange-detail-title-row.is-development-project'));
		chooseHierarchy('无下级');
		assert.ok(!visible().includes(second), 'completed direct children still prevent leaf classification');
		assert.ok(!visible().includes(parent));
		view.toggleSearch();
		assert.deepEqual(visible(), [grandchild], 'search can find project descendants');
		chooseHierarchy('无上级'); assert.deepEqual(new Set(visible()), new Set([parent, second]));
		const firstItem = store.items.find((item: any) => item.id === first);
		const oldParent = firstItem.parent; firstItem.parent = 'archived-parent'; view.paintLists();
		assert.ok(!visible().includes(first), 'missing parent reference is not a root'); firstItem.parent = oldParent;
		chooseHierarchy('全部');
		view.searchInput.value = '孙'; view.searchInput.oninput(); assert.deepEqual(visible(), [grandchild]);
		await store.setDate(grandchild, stableFacts.day); await view.reload();
		view.searchDate = { day: stableFacts.day, grain: 'day' }; view.paintLists();
		assert.deepEqual(visible(), [grandchild]);
		chooseHierarchy('无下级'); assert.deepEqual(visible(), [grandchild]);
		chooseHierarchy('无上级'); assert.deepEqual(visible(), []);
		chooseHierarchy('全部'); view.searchDate = null; view.toggleSearch();
		view.setFilter('today'); assert.ok(visible().includes(grandchild), 'today exposes a folded descendant');
		view.setFilter('all'); assert.ok(!visible().includes(grandchild));
		assert.deepEqual(store.state.order, stableOrder);
		assert.deepEqual(store.items.map((item: any) => [item.id, item.parent, item.completedAt]), stableRelations);
		await store.setDate(grandchild, null);
		assert.deepEqual(store.facts(), stableFacts);
		view.itemMenu(store.items.find((item: any) => item.id === parent), new window.MouseEvent('click'));
		([...window.document.querySelectorAll('.gvkit-arrange-menu-action')].find(button => button.textContent === '取消开发工程') as any).click();
		while (view.busy) await new Promise(resolve => setTimeout(resolve, 1));
		assert.ok(visible().includes(first) && visible().includes(grandchild));
		assert.equal(view.list.querySelector(`[data-id="${parent}"].is-development-project`), null);
		// Remove only temporary test fixtures so the existing regression scenarios stay intact.
		await view.select(null); await store.archive(grandchild);
		await store.complete(completedChild, false); await store.archive(completedChild); await view.reload();
		}
		assert.ok(view.list.querySelector(`[data-id="${parent}"].is-root-item`));
		assert.equal(view.list.querySelector(`[data-id="${second}"].is-root-item`), null, 'root without children keeps ordinary appearance');
		assert.equal(view.list.querySelector(`[data-id="${first}"].is-root-item`), null);
		const beforeAppearance = { order: [...store.state.order], facts: store.facts(), items: structuredClone(store.items) };
		for (const style of ['text', 'none', 'background']) {
			await store.configure({ rootItemStyle: style }); await view.reload();
			assert.equal(root.dataset.rootItemStyle, style);
			assert.deepEqual(store.state.order, beforeAppearance.order);
			assert.deepEqual(store.facts(), beforeAppearance.facts);
			assert.deepEqual(store.items, beforeAppearance.items);
		}
		// A missing/archived parent is still a real parent reference.
		const child = store.items.find((item: any) => item.id === first)!;
		child.parent = 'archived-parent'; view.paintLists();
		assert.equal(view.list.querySelector(`[data-id="${first}"].is-root-item`), null);
		child.parent = parent;
		await store.setDate(first, '2020-01-01'); await view.reload(); await view.select(first);
		const overdueLabel = view.detail.querySelector('.gvkit-arrange-detail-date')!;
		assert.equal(overdueLabel.querySelector('.gvkit-arrange-detail-overdue')?.textContent, '已逾期，2020年1月1号');
		assert.match(overdueLabel.textContent!, /^已逾期，2020年1月1号$/);
		assert.equal(overdueLabel.title, '2020-01-01');
		// Exercise the real plugin CSS against CodeMirror's own important flex rule.
		const css = window.document.createElement('style');
		css.textContent = await readFile(join(process.cwd(), 'styles.css'), 'utf8');
		window.document.head.append(css);
		assert.equal(window.getComputedStyle(view.editing.body.dom).display, 'none', 'preview must not also display the hidden Markdown editor');
		view.editing.preview.click();
		assert.equal(window.getComputedStyle(view.editing.preview).display, 'none');
		assert.notEqual(window.getComputedStyle(view.editing.body.dom).display, 'none', 'editor becomes the only visible body when editing');
		css.remove();
		await store.setDate(first, store.facts().day); await view.reload();
		assert.equal(view.detail.querySelector('.gvkit-arrange-detail-overdue'), null);
		await store.setDate(first, null); await view.reload(); await view.select(null);
		assert.ok(view.list.querySelector(`[data-id="${parent}"] .gvkit-arrange-has-children`));
		assert.equal(view.list.querySelector(`[data-id="${first}"] .gvkit-arrange-has-children`), null);
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-checkbox'), '17.6px');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-detail-checkbox'), '16.8px');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-right-gap'), '34px');
		await store.togglePin(first); await store.togglePin(second); await view.reload();
		assert.ok(view.list.querySelector(`[data-id="${first}"] [aria-label="置顶"]`));
		(view.list.querySelector(`[data-id="${first}"] [aria-label="置顶"]`) as any).click();
		while (view.busy) await new Promise(resolve => setTimeout(resolve, 1));
		assert.equal(store.state.order[0], first);
		await store.togglePin(first); await store.togglePin(second); await view.reload();
		const slot = host.querySelector('.view-header-title-container')!;
		assert.equal(slot.querySelectorAll('.gvkit-arrange-header').length, 1);
		assert.equal(root.querySelector('.gvkit-arrange-header'), null);
		assert.equal(host.querySelector('.gvkit-arrange-status-icon')?.getAttribute('data-icon'), 'circle-check');
		active = false; events.get('active-leaf-change')!();
		assert.equal(slot.classList.contains('gvkit-arrange-host-title'), false);
		assert.equal(slot.querySelector('.gvkit-arrange-header'), null);
		active = true; events.get('active-leaf-change')!();
		assert.ok(host.querySelector('#nav')); assert.ok(host.querySelector('#native-more'));
		// A long hold moves the same global sequence; early movement remains scrolling/swiping.
		const pointer = (el: any, type: string, x: number, y: number) => el.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y }));
		const waitHold = () => new Promise(resolve => setTimeout(resolve, 410));
		let label = root.querySelector<HTMLElement>(`[data-id="${second}"] .gvkit-arrange-title`)!;
		let target = root.querySelector<HTMLElement>(`[data-id="${parent}"]`)!;
		target.getBoundingClientRect = () => ({ top: 100, height: 48 } as any);
		window.document.elementFromPoint = () => target as any;
		pointer(label, 'pointerdown', 100, 20); await waitHold();
		assert.ok(label.parentElement!.classList.contains('is-dragging'));
		pointer(window.document, 'pointermove', 100, 140);
		assert.ok(target.classList.contains('is-drop-target'));
		pointer(window.document, 'pointerup', 100, 140);
		while (view.busy) await new Promise(resolve => setTimeout(resolve, 1));
		assert.deepEqual(store.state.order, [first, parent, second]);
		label = root.querySelector<HTMLElement>(`[data-id="${second}"] .gvkit-arrange-title`)!;
		pointer(label, 'pointerdown', 100, 20); pointer(window.document, 'pointermove', 100, 40); await waitHold();
		assert.equal(label.parentElement!.classList.contains('is-dragging'), false);
		pointer(window.document, 'pointerup', 100, 40); label.click();
		assert.equal(view.selected, null, 'scroll must not trigger the following click');
		pointer(label, 'pointerdown', 100, 20); await waitHold(); pointer(window.document, 'pointercancel', 100, 20);
		const checkbox = label.parentElement!.querySelector<HTMLInputElement>('input')!;
		const completeClick = checkbox.onclick;
		let clicked = 0; checkbox.onclick = event => { event.stopPropagation(); clicked++; };
		checkbox.click(); assert.equal(clicked, 0, 'old gesture synthetic click stays suppressed');
		pointer(checkbox, 'pointerdown', 20, 20); checkbox.click();
		assert.equal(clicked, 1, 'a new deliberate checkbox press immediately after cancellation is accepted');
		checkbox.onclick = completeClick;
		await store.togglePin(parent); view.paintLists();
		label = root.querySelector<HTMLElement>(`[data-id="${parent}"] .gvkit-arrange-title`)!;
		pointer(label, 'pointerdown', 100, 20); await waitHold();
		assert.equal(label.parentElement!.classList.contains('is-dragging'), false);
		pointer(window.document, 'pointercancel', 100, 20);
		await store.togglePin(parent); view.paintLists();
		assert.equal(root.querySelector('.gvkit-arrange-grip'), null);
		await view.select(first);
		const input = root.querySelector<HTMLTextAreaElement>('.gvkit-arrange-composer textarea')!;
		input.value = '底部未提交草稿';
		view.list.scrollTop = 144;
		assert.equal(root.querySelector('[aria-label="编辑事项"]'), null);
		assert.equal(root.querySelector('select'), null);
		assert.equal(root.querySelector('.gvkit-arrange-parent-name')?.textContent, '父事项');
		let title = root.querySelector<HTMLTextAreaElement>('.gvkit-arrange-detail-title')!;
		assert.equal(title.value, '第一项完整标题');
		title.setSelectionRange(3, 3); title.click(); assert.equal(title.selectionStart, 3, 'first title click must not override native hit testing');
		const previewText = root.querySelector('.gvkit-arrange-body')!.firstChild;
		title.focus(); title.blur(); await view.saveEdit();
		assert.equal(root.querySelector('.gvkit-arrange-body')!.firstChild, previewText, 'title blur must not replace the text a pending pointer click is landing on');
		title.value += '\n第二行'; title.dispatchEvent(new window.Event('input'));
		(root.querySelector('.gvkit-arrange-body') as any).click();
		let body = view.editing.body;
		assert.equal(root.querySelector('textarea.gvkit-arrange-inline-body'), null);
		assert.equal(body.hidden, false);
		assert.equal(body.placeholder, '记录正文、链接、思路…');
		for (const hint of ['写下下一步', '']) {
			await store.configure({ detailShadow: 0, bodyPlaceholder: hint }); view.applyComposerSettings();
			assert.equal(body.placeholder, hint);
			assert.equal(root.querySelector('.gvkit-arrange-body-placeholder')?.textContent, hint);
			assert.equal(body.hidden, false); assert.equal(body.value, '');
			assert.equal(root.style.getPropertyValue('--gvkit-arrange-detail-shadow'), 'none');
		}
		body.value = '## 附注\n[[原链接]]\n';
		await store.configure({ detailShadow: 16, bodyPlaceholder: '提示不是正文' }); view.applyComposerSettings();
		assert.equal(body.value, '## 附注\n[[原链接]]\n');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-detail-shadow'), '0 -7px 16px #0003');
		await view.select(second);
		const fresh = new ArrangeStore(app); await fresh.load();
		assert.equal(fresh.items.find((x: any) => x.id === first).title, '第一项完整标题\n第二行');
		assert.equal(fresh.items.find((x: any) => x.id === first).body, body.value);
		assert.equal(view.selected, second); assert.equal(view.list.scrollTop, 144);
		assert.equal(input.value, '底部未提交草稿');
		await view.create();
		assert.equal(store.items.find((x: any) => x.title === '底部未提交草稿').parent, second);
		assert.equal(view.selected, second);
		title = root.querySelector<HTMLTextAreaElement>('.gvkit-arrange-detail-title')!;
		title.value = ''; title.dispatchEvent(new window.Event('input'));
		for (let n = 0; n < 3; n++) await view.select(first);
		assert.equal(view.selected, second); assert.equal(title.value, '');
		assert.equal(root.querySelectorAll('.gvkit-arrange-edit-error:not([hidden])').length, 1);
		await fresh.load(); assert.equal(fresh.items.find((x: any) => x.id === second).title, '第二项');
		title.value = '失败时保留的标题'; title.dispatchEvent(new window.Event('input')); fail = true;
		await view.select(first); assert.equal(view.selected, second); assert.equal(title.value, '失败时保留的标题');
		assert.ok(root.querySelector('.gvkit-arrange-detail .gvkit-arrange-edit-error')!.textContent!.includes('模拟写入失败'));
		fail = false; await view.select(first); assert.equal(view.selected, first);
		await fresh.load(); assert.equal(fresh.items.find((x: any) => x.id === second).title, '失败时保留的标题');
		// A pending write and a simultaneous switch share one flush, including later keystrokes.
		title = root.querySelector<HTMLTextAreaElement>('.gvkit-arrange-detail-title')!;
		title.value = '慢保存开始';
		let release!: () => void;
		pause = () => new Promise<void>(resolve => { release = resolve; pause = null; });
		const saving = view.saveEdit();
		while (!release) await new Promise(resolve => setTimeout(resolve, 1));
		title.value = '慢保存中继续输入';
		const switching = view.select(second); release(); await Promise.all([saving, switching]);
		await fresh.load(); assert.equal(fresh.items.find((x: any) => x.id === first).title, '慢保存中继续输入');
		assert.equal(view.selected, second);
		// Composition is never committed midway, and routine refresh preserves the active editor.
		title = root.querySelector<HTMLTextAreaElement>('.gvkit-arrange-detail-title')!; title.focus();
		title.dispatchEvent(new window.Event('compositionstart')); title.value = '拼音组合中';
		await view.select(first); assert.equal(view.selected, second);
		await view.reload(); assert.equal(root.querySelector('.gvkit-arrange-detail-title'), title);
		title.dispatchEvent(new window.Event('compositionend')); await view.saveEdit();
		await fresh.load(); assert.equal(fresh.items.find((x: any) => x.id === second).title, '拼音组合中');
		// P0: use the real view and disk-backed Store for today's mixed list.
		await view.select(null);
		const settle = async () => { while (view.busy || view.savingEdit) await new Promise(resolve => setTimeout(resolve, 1)); };
		const rowIds = () => [...view.list.querySelectorAll('.gvkit-arrange-row')].map((el: any) => el.dataset.id);
		const today = view.today;
		const A = await store.create('今天必做 A', null), B = await store.create('今天必做 B', null);
		const C = await store.create('无日期完成 C', null), D = await store.create('明天安排完成 D', null);
		const E = await store.create('今天必做完成 E', null);
		for (const id of [A, B, E]) await store.setDate(id, today);
		await store.setDate(D, '2099-01-01');
		// Complete in reverse storage order, then assign precise same-day times.
		for (const [id, time] of [[E, '12:00'], [C, '09:00'], [D, '10:00']]) {
			await store.complete(id, true);
			const item = store.items.find((x: any) => x.id === id);
			await vault.process(files.get(item.path), source => source.replace(item.completedAt, today + 'T' + time + ':00+08:00'));
		}
		await view.reload();
		const allOrder = [...store.state.order];
		input.value = '第四轮草稿'; view.updateComposer();
		view.list.scrollTop = 188; view.headline.click();
		assert.deepEqual(rowIds(), [B, A, C, D, E]);
		assert.equal(view.headline.textContent, '今天达成 3/3');
		assert.equal(view.headline.dataset.color, 'red');
		assert.equal(root.querySelectorAll('.gvkit-arrange-row [aria-label="事项更多"]').length, 0);
		for (const id of [C, D, E]) assert.equal(view.list.querySelector('[data-id="' + id + '"] input').checked, true);
		assert.equal(root.dataset.completedStyle, 'background');
		// A completed result is not a slot in the global pending order.
		const pendingBeforeDrag = [...store.state.order];
		label = view.list.querySelector('[data-id="' + A + '"] .gvkit-arrange-title');
		target = view.list.querySelector('[data-id="' + C + '"]');
		target.getBoundingClientRect = () => ({ top: 100, height: 44 } as any);
		window.document.elementFromPoint = () => target as any;
		pointer(label, 'pointerdown', 100, 20); await waitHold();
		pointer(window.document, 'pointermove', 100, 120);
		assert.equal(target.classList.contains('is-drop-target'), false);
		pointer(window.document, 'pointerup', 100, 120); await settle();
		assert.deepEqual(store.state.order, pendingBeforeDrag);
		await store.configure({ completedStyle: 'text' }); view.paintLists();
		assert.equal(root.dataset.completedStyle, 'text'); await fresh.load(); assert.equal(fresh.state.completedStyle, 'text');
		view.list.querySelector('[data-id="' + C + '"] input').click(); await settle();
		assert.deepEqual(rowIds(), [B, A, D, E]);
		view.list.querySelector('[data-id="' + E + '"] input').click(); await settle();
		assert.deepEqual(rowIds(), [E, B, A, D]); assert.equal(view.headline.textContent, '今天达成 1/3');
		assert.deepEqual(store.state.order.filter((id: string) => id !== C && id !== E), allOrder);
		view.headline.click(); assert.equal(view.list.scrollTop, 188); assert.ok(rowIds().includes(C));
		assert.equal(input.value, '第四轮草稿');
		// Search always covers pending titles, then restores the prior today list/scroll.
		const english = await store.create('Review Alpha', null);
		view.setFilter('today'); view.list.scrollTop = 76;
		view.searchButton.click();
		const search = (query: string) => { view.searchInput.value = query; view.searchInput.dispatchEvent(new window.Event('input')); };
		search('aLPHa'); assert.deepEqual(rowIds(), [english]);
		search('今天必做'); assert.deepEqual(rowIds(), [E, B, A]);
		search('不存在关键词'); assert.equal(rowIds().length, 0); assert.match(view.list.textContent, /没有符合条件/);
		search(''); assert.deepEqual(rowIds(), store.state.order);
		view.toggleSearch(); assert.equal(view.filter, 'today'); assert.equal(view.list.scrollTop, 76);
		// Navigation flushes inline edits; candidate mode includes completed parents.
		await view.select(first);
		title = root.querySelector<HTMLTextAreaElement>('.gvkit-arrange-detail-title')!;
		title.value = '导航前编辑'; title.dispatchEvent(new window.Event('input'));
		(root.querySelector('.gvkit-arrange-parent-name') as any).click(); await settle();
		assert.equal(view.selected, parent); await fresh.load(); assert.equal(fresh.items.find((x: any) => x.id === first).title, '导航前编辑');
		await view.select(first);
		const grandchild = await store.create('自己的下级', first);
		view.toggleSearch(); search('aLPHa'); view.list.scrollTop = 42;
		view.full = true; view.detail.style.height = '100%'; view.detailScroll.scrollTop = 33;
		await view.changeParent(first);
		assert.equal(view.detail.hidden, true); assert.equal(input.disabled, true);
		assert.equal(view.searchOpen, false); assert.ok(rowIds().includes(D));
		assert.ok(rowIds().includes(first)); assert.ok(rowIds().includes(grandchild));
		for (const [id, message] of [[first, '不能选择自己作为上级'], [grandchild, '不能选择自己的下级事项作为上级']]) {
			const candidate = view.list.querySelector('[data-id="' + id + '"]');
			assert.ok(candidate.classList.contains('is-invalid-parent'));
			const previous = store.items.find((x: any) => x.id === first).parent;
			const notices = (window as any).notices?.length ?? 0;
			candidate.querySelector('button').click(); await settle();
			assert.equal((window as any).notices.length, notices + 1);
			assert.equal((window as any).notices.at(-1), message);
			assert.ok(view.choosingParent); assert.equal(store.items.find((x: any) => x.id === first).parent, previous);
		}
		assert.equal(view.list.querySelector('input'), null); assert.equal(view.list.querySelector('.gvkit-arrange-actions'), null);
		const originalOrder = [...store.state.order], count = store.items.length;
		label = view.list.querySelector('.gvkit-arrange-title');
		pointer(label, 'pointerdown', 100, 20); await waitHold();
		assert.equal(label.parentElement!.classList.contains('is-dragging'), false);
		await view.create(); assert.equal(store.items.length, count);
		assert.deepEqual(store.state.order, originalOrder);
		view.toggleSearch(); search('明天安排'); assert.deepEqual(rowIds(), [D]);
		fail = true; await view.chooseParent(D);
		assert.ok(view.choosingParent); assert.match(view.parentError.textContent, /模拟写入失败/); fail = false;
		view.list.querySelector('.gvkit-arrange-title').click(); await settle();
		assert.equal(view.choosingParent, null); assert.equal(view.selected, first);
		assert.equal(view.searchInput.value, 'aLPHa'); assert.equal(view.searchOpen, true);
		assert.equal(view.list.scrollTop, 42); assert.equal(view.detailScroll.scrollTop, 33); assert.equal(view.full, true);
		assert.equal(input.value, '第四轮草稿'); assert.equal(input.disabled, false);
		await fresh.load(); assert.equal(fresh.items.find((x: any) => x.id === first).parent, D);
		assert.equal(fresh.items.find((x: any) => x.id === first).title, '导航前编辑');
		await view.changeParent(first); view.toggleSearch(); search('取消查询'); view.finishParentChoice();
		assert.equal(view.searchInput.value, 'aLPHa'); assert.equal(store.items.find((x: any) => x.id === first).parent, D);
		await view.changeParent(first); await view.chooseParent(null);
		assert.equal(store.items.find((x: any) => x.id === first).parent, null);
		// The two targets in a menu row are independent: toggle pin shortcut, then execute pin.
		const current = store.items.find((x: any) => x.id === first);
		view.itemMenu(current, new window.MouseEvent('click'));
		const menu = window.document.querySelector('.gvkit-arrange-item-menu')!;
		const pinToggle = menu.querySelector<HTMLElement>('[aria-label="列表显示钉住位置"]')!;
		const beforePin = current.pinned;
		pinToggle.click(); await settle();
		assert.equal(store.items.find((x: any) => x.id === first).pinned, beforePin);
		assert.equal(pinToggle.getAttribute('aria-checked'), 'true');
		await fresh.load(); assert.ok(fresh.state.rowActions.includes('pin'));
		(pinToggle.parentElement!.querySelector('.gvkit-arrange-menu-action') as any).click(); await settle();
		assert.equal(store.items.find((x: any) => x.id === first).pinned, !beforePin);
		assert.equal(window.document.querySelector('.gvkit-arrange-item-menu'), null);
		// Independent list/detail preferences: all four combinations persist without executing.
		view.itemMenu(store.items.find((x: any) => x.id === first), new window.MouseEvent('click'));
		const dualMenu = window.document.querySelector('.gvkit-arrange-item-menu')!;
		assert.deepEqual([...dualMenu.querySelectorAll('.gvkit-arrange-menu-headings span')].map(el => el.textContent), ['列表', '详情']);
		const rowToggle = dualMenu.querySelector<HTMLElement>('[aria-label="列表显示修改上级"]')!;
		const detailToggle = dualMenu.querySelector<HTMLElement>('[aria-label="详情显示修改上级"]')!;
		for (const [listOn, detailOn] of [[true, true], [true, false], [false, false], [false, true]]) {
			for (const [toggle, on] of [[rowToggle, listOn], [detailToggle, detailOn]] as const) {
				if (toggle.getAttribute('aria-checked') !== String(on)) { toggle.click(); await settle(); }
			}
			await fresh.load();
			assert.equal(fresh.state.rowActions.includes('changeParent'), listOn);
			assert.equal(fresh.state.detailActions.includes('changeParent'), detailOn);
			assert.equal(Boolean(view.detail.querySelector('.gvkit-arrange-detail-actions [aria-label="修改上级"]')), detailOn);
			assert.equal(view.choosingParent, null);
		}
		(detailToggle.parentElement!.querySelector('.gvkit-arrange-menu-action') as any).click(); await settle();
		assert.equal(view.choosingParent.id, first); view.finishParentChoice();
		await store.configure({ rowActions: ['changeParent'] }); view.paintLists();
		if (view.searchOpen) view.toggleSearch(); view.setFilter('all');
		view.list.querySelector('[data-id="' + first + '"] [aria-label="修改上级"]').click(); await settle();
		assert.equal(view.choosingParent.id, first); view.finishParentChoice();
		// Match spans preserve text, match case-insensitively, and disappear on close.
		const repeated = await store.create('家园 Alpha 家园 ALPHA', null);
		view.toggleSearch(); search('家园');
		let hitTitle = view.list.querySelector('[data-id="' + repeated + '"] .gvkit-arrange-title');
		assert.equal(hitTitle.textContent, '家园 Alpha 家园 ALPHA');
		assert.deepEqual([...hitTitle.querySelectorAll('.gvkit-arrange-match')].map((el: any) => el.textContent), ['家园', '家园']);
		search('alpha'); hitTitle = view.list.querySelector('[data-id="' + repeated + '"] .gvkit-arrange-title');
		assert.deepEqual([...hitTitle.querySelectorAll('.gvkit-arrange-match')].map((el: any) => el.textContent), ['Alpha', 'ALPHA']);
		view.toggleSearch(); assert.equal(view.list.querySelectorAll('.gvkit-arrange-match').length, 0);
		// Only direct children; completed children follow pending global order, then completion time.
		const family = await store.create('详情分组', null);
		const children = [];
		for (const name of ['未完成1', '未完成2', '完成晚', '完成早']) children.push(await store.create(name, family));
		const descendant = await store.create('更深层', children[0]);
		for (const [id, time] of [[children[2], '12:00'], [children[3], '09:00']]) {
			await store.complete(id, true); const child = store.items.find((x: any) => x.id === id);
			await vault.process(files.get(child.path), source => source.replace(child.completedAt, today + 'T' + time + ':00+08:00'));
		}
		await view.reload(); await view.select(family);
		const childIds = () => [...view.children.querySelectorAll('.gvkit-arrange-row')].map((el: any) => el.dataset.id);
		assert.deepEqual(childIds(), [children[1], children[0], children[3], children[2]]);
		assert.ok(!childIds().includes(descendant));
		title = view.editing.title; title.value = '未保存详情草稿';
		await store.configure({ showCompletedChildren: false }); view.paintLists();
		assert.deepEqual(childIds(), [children[1], children[0]]); assert.equal(view.editing.title, title); assert.equal(title.value, '未保存详情草稿');
		await fresh.load(); assert.equal(fresh.state.showCompletedChildren, false);
		await store.configure({ showCompletedChildren: true }); view.paintLists();
		view.children.querySelector('[data-id="' + children[3] + '"] input').click(); await settle();
		assert.deepEqual(childIds(), [children[3], children[1], children[0], children[2]]);
		assert.ok(store.items.find((x: any) => x.id === children[2]).completedAt);
		await view.select(null);
		// Above-list release remains global top, with the first two pinned slots protected.
		const pinnedIds = store.state.order.slice(0, 2);
		for (const id of pinnedIds) if (!store.items.find((x: any) => x.id === id).pinned) await store.togglePin(id);
		view.paintLists();
		const moving = store.state.order.findLast((id: string) => !store.items.find((x: any) => x.id === id).pinned);
		const original = [...store.state.order];
		const pinned = new Set(store.items.filter((x: any) => x.pinned && !x.completedAt).map((x: any) => x.id));
		view.list.getBoundingClientRect = () => ({ top: 90, bottom: 600 } as any);
		for (const [index, row] of [...view.list.querySelectorAll('.gvkit-arrange-row')].entries()) (row as any).getBoundingClientRect = () => ({ top: 90 + index * 44, height: 44 } as any);
		label = view.list.querySelector('[data-id="' + moving + '"] .gvkit-arrange-title');
		window.document.elementFromPoint = () => null;
		pointer(label, 'pointerdown', 100, 400); await waitHold();
		pointer(window.document, 'pointermove', 100, 60);
		assert.ok(view.list.querySelector('.is-drop-target')); assert.equal(view.list.querySelector('.is-drop-target').classList.contains('is-pinned'), false);
		pointer(window.document, 'pointermove', 100, -30);
		assert.ok(view.list.querySelector('.is-drop-target'));
		pointer(window.document, 'pointerup', 100, -30); await settle();
		assert.deepEqual(store.state.order.slice(0, 3), [pinnedIds[0], pinnedIds[1], moving]);
		for (const id of pinned) assert.equal(store.state.order.indexOf(id), original.indexOf(id));
		assert.deepEqual(store.state.order.filter((id: string) => id !== moving && !pinned.has(id)), original.filter(id => id !== moving && !pinned.has(id)));
		for (const id of pinnedIds) await store.togglePin(id);
		// Completed actions are disabled while preference toggles remain enabled.
		view.itemMenu(store.items.find((x: any) => x.id === children[2]), new window.MouseEvent('click'));
		const disabledTop = window.document.querySelector<HTMLElement>('[aria-label="详情显示置顶"]')!;
		assert.equal((disabledTop.parentElement!.querySelector('.gvkit-arrange-menu-action') as HTMLButtonElement).disabled, true);
		assert.equal((disabledTop as HTMLButtonElement).disabled, false);
		window.document.querySelector('.gvkit-arrange-item-menu')!.remove();
		view.setFilter('today');
		for (const id of [A, B, E]) await store.complete(id, true);
		view.paintLists(); assert.equal(view.headline.dataset.color, 'blue');
		await store.setAchieved(today, true); view.paintLists(); assert.equal(view.headline.dataset.color, 'gold');
		await store.setDate(C, today); view.paintLists(); assert.equal(view.headline.dataset.color, 'red'); assert.equal(rowIds()[0], C);
		await store.setDate(C, null); view.paintLists(); assert.equal(view.headline.dataset.color, 'gold'); assert.ok(!rowIds().includes(C));
		// Unified search keeps keyword, completion and date filters independent.
		view.toggleSearch(); search('');
		const searchOrder = [...store.state.order];
		view.completedButton.click(); assert.ok(rowIds().includes(D));
		view.dateButton.click();
		assert.ok(rowIds().includes(D), 'a completed item matches its completion day, not its far-future date');
		assert.ok(!rowIds().includes(C), 'undated pending items are excluded with a date filter');
		search('明天安排'); assert.deepEqual(rowIds(), [D]);
		view.completedButton.click(); assert.deepEqual(rowIds(), []);
		view.completedButton.click(); assert.deepEqual(rowIds(), [D]);
		assert.deepEqual(store.state.order, searchOrder, 'search alone never changes global order');
		view.list.querySelector('input').click(); await settle();
		assert.deepEqual(rowIds(), [], 'undo switches from completion timestamp to scheduled date');
		assert.equal(store.items.find((x: any) => x.id === D).completedAt, null);
		view.dateBar.querySelector('[aria-label="清除日期条件"]').click(); assert.deepEqual(rowIds(), [D]);
		assert.equal(view.searchInput.value, '明天安排');
		view.dateButton.click();
		await view.changeParent(first); view.toggleSearch(); search('明天安排');
		assert.deepEqual(rowIds(), [D], 'parent selection bypasses date/completion filters');
		assert.equal(view.dateBar.hidden, true); assert.equal(view.completedButton.hidden, true);
		view.finishParentChoice();
		assert.ok(view.searchDate); assert.equal(view.includeCompleted, true);
		view.dateBar.querySelector('[aria-label="下一期"]').click();
		assert.notEqual(view.searchDate.day, today);
		view.dateBar.querySelector('[aria-label="上一期"]').click(); assert.equal(view.searchDate.day, today);
		for (const [grain, name] of [['week', '周'], ['month', '月'], ['year', '年']]) {
			[...view.dateBar.querySelectorAll('button')].find((button: any) => button.textContent === name).click();
			assert.equal(view.searchDate.grain, grain); assert.ok(view.dateBar.textContent.includes('—'));
		}
		view.toggleSearch();
		// Pending descendants block both checkbox surfaces, even when hidden as a project.
		view.setFilter('all');
		const guardedOrder = [...store.state.order], guardedFacts = store.facts();
		await store.toggleDevelopmentProject(family); await view.reload();
		assert.equal(view.list.querySelector(`[data-id="${children[0]}"]`), null);
		view.list.querySelector(`[data-id="${family}"] input`).click(); await settle();
		assert.equal(window.notices.at(-1), '需先完成所有下级事项');
		assert.equal(store.items.find((x: any) => x.id === family).completedAt, null);
		assert.deepEqual(store.state.order, guardedOrder); assert.deepEqual(store.facts(), guardedFacts);
		await store.toggleDevelopmentProject(family); await view.reload();
		// Complete in detail flushes both fields, keeps the panel and children, and can undo.
		await view.select(family);
		view.editing.title.value = '详情勾选前的标题'; view.editing.body.value = '保存中的正文\n下一行';
		view.detail.querySelector('.gvkit-arrange-detail-title-row input').click(); await settle();
		assert.equal(window.notices.at(-1), '需先完成所有下级事项');
		assert.equal(view.detail.querySelector('.gvkit-arrange-detail-title-row input').checked, false);
		assert.equal(store.items.find((x: any) => x.id === family).completedAt, null);
		await store.complete(descendant, true);
		await store.complete(children[0], true); await store.complete(children[1], true); await store.complete(children[3], true);
		// Undoing a grandchild beneath a completed child must still prevent parent completion.
		await store.complete(descendant, false);
		await view.toggleComplete(family);
		assert.equal(window.notices.at(-1), '需先完成所有下级事项');
		assert.equal(store.items.find((x: any) => x.id === family).completedAt, null);
		await store.complete(descendant, true);
		await view.toggleComplete(family);
		assert.equal(view.selected, family); assert.equal(view.detail.hidden, false);
		assert.ok(view.detail.querySelector('.gvkit-arrange-detail-title-row.is-completed'));
		await fresh.load();
		assert.equal(fresh.items.find((x: any) => x.id === family).body, '保存中的正文\n下一行');
		assert.ok(fresh.items.find((x: any) => x.id === children[0]).completedAt);
		view.detail.querySelector('.gvkit-arrange-detail-title-row input').click(); await settle();
		assert.equal(store.items.find((x: any) => x.id === family).completedAt, null);
		assert.equal(view.editing.title.value, '详情勾选前的标题');
		view.editing.body.value = '不能丢失的正文'; fail = true;
		await view.toggleComplete(family);
		assert.equal(store.items.find((x: any) => x.id === family).completedAt, null);
		assert.equal(view.editing.body.value, '不能丢失的正文'); assert.equal(view.editing.error.hidden, false);
		fail = false; await view.saveEdit();
		// First body click maps a rendered text node to its Markdown source offset.
		await store.edit(family, '光标标题', '## 标题\n\n第一段 **加粗文字** 尾部\n\n第二行文字', null);
		await view.select(family);
		const preview = view.editing.preview;
		preview.innerHTML = '<h2>标题</h2><p>第一段 <strong>加粗文字</strong> 尾部</p><p>第二行文字</p>';
		const textNode = preview.querySelectorAll('p')[1].firstChild;
		(window.document as any).caretRangeFromPoint = () => ({ startContainer: textNode, startOffset: 2 });
		textNode.parentElement.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 80 }));
		assert.equal(view.editing.body.editor.state.selection.main.head, view.editing.body.value.indexOf('第二行文字') + 2);
		assert.equal(view.editing.body.value, '## 标题\n\n第一段 **加粗文字** 尾部\n\n第二行文字');
		delete (window.document as any).caretRangeFromPoint;
		view.renderBody(); const link = preview.createEl('a', { text: '链接', attr: { href: '#target' } }); link.click();
		assert.equal(view.editing.body.hidden, true, 'links do not enter the editor');
		// Batch four: the date region reuses the date operation; copying never edits the item.
		const originalCopyDate = store.items.find((x: any) => x.id === family).date;
		await store.setDate(family, '2026-10-28'); await view.reload();
		const beforeCopy = await vault.read(files.get(store.items.find((x: any) => x.id === family).path));
		const dateRegion = root.querySelector<HTMLButtonElement>('.gvkit-arrange-detail-date')!;
		assert.equal(dateRegion.tagName, 'BUTTON'); assert.equal(dateRegion.hidden, false);
		dateRegion.click();
		assert.ok((window as any).menus.at(-1).entries.some((entry: any) => entry.title === '选择日期…'));
		view.itemMenu(store.items.find((x: any) => x.id === family), new window.MouseEvent('click'));
		const batch4Menu = window.document.querySelector('.gvkit-arrange-item-menu')!;
		assert.equal(batch4Menu.textContent!.includes('Markdown'), false);
		const copyTitle = [...batch4Menu.querySelectorAll<HTMLButtonElement>('.gvkit-arrange-menu-action')].find(button => button.textContent === '复制标题')!;
		copyTitle.click(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(copied.at(-1), '光标标题');
		let copyBody = root.querySelector<HTMLButtonElement>('.gvkit-arrange-body-copy')!;
		assert.ok(copyBody); copyBody.click(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(copied.at(-1), '光标标题\n\n## 标题\n\n第一段 **加粗文字** 尾部\n\n第二行文字');
		assert.equal(view.editing.body.hidden, true, 'copy does not enter the body editor');
		view.renderBody(); view.renderBody();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(root.querySelectorAll('.gvkit-arrange-body-copy').length, 1, 'overlapping renders append only one copy icon');
		assert.equal(await vault.read(files.get(store.items.find((x: any) => x.id === family).path)), beforeCopy);
		// Rendered block/inline markup keeps the icon at the final word, outside links.
		for (const html of ['<p>段落<strong>最后字</strong></p>', '<ul><li>列表最后字</li></ul>', '<p>末尾<a href="#x">链接</a></p>']) {
			view.renderBody(); view.editing.preview.innerHTML = html;
			await new Promise(resolve => setTimeout(resolve, 0));
			copyBody = root.querySelector<HTMLButtonElement>('.gvkit-arrange-body-copy')!;
			assert.ok(copyBody); assert.equal(copyBody.closest('a'), null);
			assert.equal(copyBody.parentElement!.lastChild, copyBody);
		}
		copyFails = true; copyBody.click(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal((window as any).notices.at(-1), '复制失败，请重试'); copyFails = false;
		view.editing.title.value = '正在编辑的标题';
		view.action('copy', store.items.find((x: any) => x.id === family), new window.MouseEvent('click'));
		await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(copied.at(-1), '正在编辑的标题');
		view.editing.title.value = '光标标题';
		view.editing.body.value = ''; view.renderBody(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(root.querySelector('.gvkit-arrange-body-copy'), null, 'empty notes have no copy icon');
		view.editing.body.value = '## 标题\n\n第一段 **加粗文字** 尾部\n\n第二行文字'; view.renderBody();
		await store.setDate(family, originalCopyDate);
		// Settings update the existing editor, and new Store reads all preferences from Markdown.
		const preferences = { listFontSize: 14, rowHeight: 40, rowDividers: false, gripHeight: 56, gripWidth: 96,
			toolbarHeight: 56, parentFontSize: 18, closeThreshold: 10, selectionColor: 'purple' };
		await store.configure(preferences); view.applyComposerSettings(); view.paintLists(); await fresh.load();
		for (const [key, value] of Object.entries(preferences)) assert.equal(fresh.state[key], value);
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-row-slot'), '20px');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-grip-height'), '56px');
		assert.equal(root.dataset.rowDividers, 'false');
		assert.equal(view.headline.dataset.selectionColor, 'purple');
		assert.equal(view.headline.dataset.color, 'gold');
		view.toggleSearch(); assert.equal(view.headline.getAttribute('aria-pressed'), 'false'); view.toggleSearch();
		// The date label refreshes even while the title stays focused and un-replaced.
		view.editing.title.focus(); const stableTitle = view.editing.title;
		await view.run(() => store.setDate(family, today));
		assert.equal(view.editing.title, stableTitle);
		assert.match(view.detail.querySelector('.gvkit-arrange-detail-date').textContent, /^今天，/);
		await view.run(() => store.setDate(family, null));
		assert.equal(view.detail.querySelector('.gvkit-arrange-detail-date').hidden, true);
		// A keyboard-sized area can reach even the lowest threshold; cancel restores height.
		view.area.getBoundingClientRect = () => ({ height: 200 } as any);
		view.detail.getBoundingClientRect = () => ({ height: 96 } as any);
		const grip = view.detail.querySelector('.gvkit-arrange-panel-grip'); grip.setPointerCapture = () => {};
		pointer(grip, 'pointerdown', 30, 10); pointer(grip, 'pointermove', 30, 100);
		assert.equal(view.detail.style.height, '6px');
		pointer(grip, 'pointercancel', 30, 100); assert.equal(view.detail.hidden, false); assert.equal(view.detail.style.height, '');
		pointer(grip, 'pointerdown', 30, 100); pointer(grip, 'pointermove', 30, 20); pointer(grip, 'pointerup', 30, 20);
		assert.equal(view.full, true); assert.equal(view.detail.style.height, '100%');
		pointer(grip, 'pointerdown', 30, 10); pointer(grip, 'pointermove', 30, 20); pointer(grip, 'pointerup', 30, 20);
		assert.equal(view.full, false); assert.equal(view.detail.style.height, '86px');
		view.editing.body.value = '拖动关闭前编辑';
		view.list.scrollTop = 123; input.value = '拖动仍保留新增草稿';
		pointer(grip, 'pointerdown', 30, 10); pointer(grip, 'pointermove', 30, 100); pointer(grip, 'pointerup', 30, 100);
		await settle();
		assert.equal(view.selected, null); assert.equal(view.detail.hidden, true);
		assert.equal(view.list.scrollTop, 123); assert.equal(input.value, '拖动仍保留新增草稿');
		await fresh.load(); assert.equal(fresh.items.find((x: any) => x.id === family).body, '拖动关闭前编辑');
		// A horizontal swipe must never override the configured list shortcut set.
		view.setFilter('all'); await store.configure({ rowActions: ['top'] }); view.applyComposerSettings(); view.paintLists();
		const icons = () => [...view.list.querySelectorAll('.gvkit-arrange-row')].map((row: any) => [...row.querySelectorAll('.gvkit-arrange-icon')].map((button: any) => button.getAttribute('aria-label')));
		const configuredIcons = icons();
		label = view.list.querySelector('.gvkit-arrange-title');
		pointer(label, 'pointerdown', 150, 30); pointer(window.document, 'pointermove', 70, 30); pointer(window.document, 'pointerup', 70, 30);
		assert.deepEqual(icons(), configuredIcons);
		await view.reload(); assert.deepEqual(icons(), configuredIcons);
		assert.ok(icons().every((row: string[]) => row.length <= 1 && row.every(name => name === '置顶')));
		// New density/detail settings persist in the same state and retain editing nodes.
		await view.select(family);
		const editor = view.editing.title; editor.value = '字体改变也保留此标题'; editor.focus();
		const compact = { rowHeight: 24, listFontSize: 14, detailFontSize: 16, bodyFontSize: 20, dateFontSize: 15, rowIconGap: 0, detailIconGap: 2 };
		await store.configure(compact); view.applyComposerSettings(); view.paintLists(); await fresh.load();
		for (const [key, value] of Object.entries(compact)) assert.equal(fresh.state[key], value);
		assert.equal(view.editing.title, editor); assert.equal(editor.value, '字体改变也保留此标题');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-row-height'), '24px');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-detail-checkbox'), '15.2px');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-detail-icon'), '17px');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-detail-slot'), '19px');
		await store.setDate(family, today); view.paintLists();
		let hint = view.list.querySelector('[data-id="' + family + '"] .gvkit-arrange-row-date');
		assert.equal(hint.textContent, '今天'); assert.equal(hint.classList.contains('is-overdue'), false);
		await store.setDate(family, '2020-01-01'); view.paintLists();
		hint = view.list.querySelector('[data-id="' + family + '"] .gvkit-arrange-row-date');
		assert.equal(hint.classList.contains('is-overdue'), true);
		await view.toggleComplete(family);
		assert.equal(view.detail.querySelector('.gvkit-arrange-detail-date').textContent.includes('逾期'), false);
		// One left swipe invokes only the selected action on release, with mouse-compatible coordinates.
		await view.select(null); await store.configure({ swipeAction: 'date', pullDownClose: true }); view.paintLists();
		const touch = (el: any, type: string, x: number, y: number, count = 1) => {
			const points = Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y }));
			return el.dispatchEvent(new window.TouchEvent(type, { bubbles: true, cancelable: true,
				touches: type === 'touchend' || type === 'touchcancel' ? [] : points, changedTouches: points } as any));
		};
		const gesture = (el: any, dx: number, dy = 0, cancel = false) => {
			touch(el, 'touchstart', 180, 60); touch(el, 'touchmove', 180 + dx, 60 + dy);
			touch(el, cancel ? 'touchcancel' : 'touchend', 180 + dx, 60 + dy);
		};
		label = view.list.querySelector(`[data-id="${second}"] .gvkit-arrange-title`);
		const dateBefore = store.items.find((x: any) => x.id === second).date;
		let menuCount = (window as any).menus.length;
		touch(label, 'touchstart', 180, 60); touch(label, 'touchmove', 100, 62);
		assert.equal((window as any).menus.length, menuCount);
		touch(label, 'touchend', 100, 62); label.click();
		assert.equal((window as any).menus.length, ++menuCount); assert.equal(view.selected, null);
		assert.equal(store.items.find((x: any) => x.id === second).date, dateBefore);
		assert.deepEqual({ x: (window as any).menus.at(-1).x, y: (window as any).menus.at(-1).y, type: (window as any).menus.at(-1).type }, { x: 100, y: 62, type: 'MouseEvent' });
		for (const [dx, dy, cancel] of [[-80, 0, true], [-10, 80, false], [80, 0, false], [-30, 0, false]] as const) gesture(label, dx, dy, cancel);
		assert.equal((window as any).menus.length, menuCount);
		await store.configure({ swipeAction: 'none' }); gesture(label, -80);
		assert.equal((window as any).menus.length, menuCount);
		await store.configure({ swipeAction: 'date' });
		await store.setParent(first, parent);
		await view.select(parent);
		const childLabel = view.children.querySelector('.gvkit-arrange-title');
		gesture(childLabel, -80); assert.equal((window as any).menus.length, ++menuCount);
		// A scroll that merely reaches the top cannot close; only a fresh pull can.
		(window.document.activeElement as any)?.blur();
		let scroller = view.detailScroll;
		scroller.scrollTop = 90; touch(scroller, 'touchstart', 100, 50); scroller.scrollTop = 0;
		touch(scroller, 'touchmove', 100, 160); touch(scroller, 'touchend', 100, 160); await settle();
		assert.equal(view.selected, parent);
		for (const target of [view.editing.title, view.children.querySelector('.gvkit-arrange-title')]) {
			gesture(target, 0, 100); await settle(); assert.equal(view.selected, parent);
		}
		gesture(scroller, 0, 100, true); await settle(); assert.equal(view.selected, parent);
		gesture(scroller, 90, 0); await settle(); assert.equal(view.selected, parent);
		gesture(scroller, 0, 30); await settle(); assert.equal(view.selected, parent);
		view.editing.title.focus(); gesture(scroller, 0, 100); await settle(); assert.equal(view.selected, parent);
		view.editing.title.blur(); view.editing.composing = true;
		gesture(scroller, 0, 100); await settle(); assert.equal(view.selected, parent); view.editing.composing = false;
		await store.configure({ pullDownClose: false }); gesture(scroller, 0, 100); await settle(); assert.equal(view.selected, parent);
		await store.configure({ pullDownClose: true });
		view.editing.body.value = '下拉关闭保存正文'; view.list.scrollTop = 77; input.value = '新增草稿不丢';
		gesture(scroller, 0, 100); await settle();
		assert.equal(view.selected, null); assert.equal(view.list.scrollTop, 77); assert.equal(input.value, '新增草稿不丢');
		await fresh.load(); assert.equal(fresh.items.find((x: any) => x.id === parent).body, '下拉关闭保存正文');
		await view.select(parent); view.editing.title.value = ''; gesture(view.detailScroll, 0, 100); await settle();
		assert.equal(view.selected, parent, 'invalid draft prevents pull-close'); view.editing.title.value = '父归档前标题';
		// Dual quick toggles remain independent; archive defaults stay hidden.
		await store.configure({ rowActions: ['date'], detailActions: ['date'] }); view.paintLists();
		view.itemMenu(store.items.find((x: any) => x.id === parent), new window.MouseEvent('click'));
		const archiveMenu = window.document.querySelector('.gvkit-arrange-item-menu:last-child')!;
		const rowArchive = archiveMenu.querySelector<HTMLElement>('[aria-label="列表显示归档"]')!;
		const detailArchive = archiveMenu.querySelector<HTMLElement>('[aria-label="详情显示归档"]')!;
		assert.equal(rowArchive.getAttribute('aria-checked'), 'false'); assert.equal(detailArchive.getAttribute('aria-checked'), 'false');
		rowArchive.click(); await settle(); assert.ok(store.state.rowActions.includes('archive')); assert.ok(!store.state.detailActions.includes('archive'));
		detailArchive.click(); await settle(); assert.ok(store.state.detailActions.includes('archive'));
		archiveMenu.remove();
		fail = true; view.action('archive', store.items.find((x: any) => x.id === parent), new window.MouseEvent('click')); await settle();
		assert.equal(view.selected, parent); assert.equal(view.editing.title.value, '父归档前标题'); assert.ok(store.items.some((x: any) => x.id === parent));
		fail = false; view.action('archive', store.items.find((x: any) => x.id === parent), new window.MouseEvent('click')); await settle();
		assert.equal(view.selected, null); assert.ok(!store.items.some((x: any) => x.id === parent)); assert.equal(input.value, '新增草稿不丢');
		await view.select(first); assert.equal(view.detail.querySelector('.gvkit-arrange-parent-name'), null);
		view.editing.title.value = '父项归档后仍能保存'; assert.equal(await view.saveEdit(), true);
		await view.select(null); await store.configure({ swipeAction: 'archive' }); view.paintLists();
		label = view.list.querySelector(`[data-id="${second}"] .gvkit-arrange-title`); gesture(label, -80); await settle();
		assert.ok(!store.items.some((x: any) => x.id === second));
		const navParent = await store.create('正在编辑的子项之父', null);
		const navChild = await store.create('保留编辑节点的子项', navParent);
		await view.select(navChild); const navEditor = view.editing.title; navEditor.focus();
		view.action('archive', store.items.find((x: any) => x.id === navParent), new window.MouseEvent('click')); await settle();
		assert.equal(view.selected, navChild); assert.equal(view.editing.title, navEditor);
		assert.equal(view.detail.querySelector('.gvkit-arrange-parent-name'), null, 'archiving from the main list removes stale parent navigation without replacing the child editor');
		navEditor.value = '编辑不中断'; assert.equal(await view.saveEdit(), true);
		// Pending acceptance uses the existing menu and the same empty blue box in both views.
		await view.select(null); view.searchOpen = false; view.filter = 'all'; view.searchInput.value = '';
		const reviewId = await store.create('等待制作人验收', null);
		await store.setDate(reviewId, '2026-10-26');
		await store.configure({ rowActions: ['developmentCompleted'], detailActions: ['developmentCompleted'] });
		await view.select(reviewId);
		const reviewBefore = { ...store.items.find((x: any) => x.id === reviewId) };
		const reviewFacts = store.facts(), reviewOrder = [...store.state.order];
		const style = window.document.createElement('style'); style.textContent = await readFile('styles.css', 'utf8'); window.document.head.append(style);
		for (const expected of [true, false, true, false]) {
			view.itemMenu(store.items.find((x: any) => x.id === reviewId), new window.MouseEvent('click'));
			const reviewMenu = window.document.querySelector('.gvkit-arrange-item-menu:last-child')!;
			const action = [...reviewMenu.querySelectorAll<HTMLButtonElement>('.gvkit-arrange-menu-action')].find(el => el.textContent === (expected ? '已完成开发' : '取消已完成开发'))!;
			assert.equal(action.getAttribute('aria-pressed'), String(!expected)); action.click(); await settle();
			const current = { ...store.items.find((x: any) => x.id === reviewId) };
			assert.equal(current.developmentCompleted, expected);
			assert.deepEqual({ ...current, developmentCompleted: false }, reviewBefore);
			assert.deepEqual(store.facts(), reviewFacts); assert.deepEqual(store.state.order, reviewOrder);
			const boxes = [view.list.querySelector(`[data-id="${reviewId}"] input`), view.detail.querySelector('.gvkit-arrange-detail-title-row input')];
			for (const box of boxes) {
				assert.equal(box.checked, false);
				assert.equal(box.classList.contains('is-development-completed'), expected);
				if (expected) assert.equal(window.getComputedStyle(box).borderTopColor, '#2563eb');
			}
			for (const button of [view.list.querySelector(`[data-id="${reviewId}"] [aria-label="已完成开发"]`), view.detail.querySelector('[aria-label="已完成开发"]')])
				assert.equal(button.classList.contains('is-active'), expected);
		}
		// External edits refresh the existing detail editor, and manual acceptance remains normal.
		await store.toggleDevelopmentCompleted(reviewId); await view.reload();
		assert.equal(view.detail.querySelector('.is-development-completed').checked, false);
		view.detail.querySelector('.gvkit-arrange-detail-title-row input').click(); await settle();
		assert.ok(store.items.find((x: any) => x.id === reviewId).completedAt);
		assert.equal(view.detail.querySelector('.is-development-completed'), null);
		assert.equal(view.detail.querySelector('.gvkit-arrange-detail-title-row input').checked, true);
		await view.toggleComplete(reviewId);
		assert.equal(store.items.find((x: any) => x.id === reviewId).date, reviewBefore.date);
		assert.equal(view.detail.querySelector('.is-development-completed').checked, false);
		// Dispatch DOM key events: same button path, no duplicate while a disk write is pending.
		await view.select(null);
		const platform = (await import(pathToFileURL(join(dir, 'view.mjs')).href)).Platform;
		platform.isMobileApp = false;
		// Desktop presses need no stationary long hold before entering the existing drop path.
		view.paintLists();
		const free = store.state.order.filter((id: string) => !store.items.find((i: any) => i.id === id).pinned);
		const mouseId = free[0], dropId = free.at(-1);
		const mouseLabel = view.list.querySelector(`[data-id="${mouseId}"] .gvkit-arrange-title`);
		const mouseDrop = view.list.querySelector(`[data-id="${dropId}"]`);
		mouseDrop.getBoundingClientRect = () => ({ top: 100, height: 48 });
		window.document.elementFromPoint = () => mouseDrop;
		pointer(mouseLabel, 'pointerdown', 100, 20);
		pointer(window.document, 'pointermove', 100, 140);
		assert.equal(mouseLabel.parentElement.classList.contains('is-dragging'), true);
		assert.equal(mouseDrop.classList.contains('is-drop-target'), true);
		pointer(window.document, 'pointerup', 100, 140); await settle();
		assert.equal(store.state.order.at(-1), mouseId);
		assert.equal(view.selected, null, 'drop does not open a detail');
		const key = (options: any = {}) => {
			const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
			input.dispatchEvent(event); return event;
		};
		input.value = 'CtrlEnter仅一次'; input.dispatchEvent(new window.Event('input'));
		assert.equal(key().defaultPrevented, false);
		assert.equal(key({ ctrlKey: true, isComposing: true }).defaultPrevented, false);
		let releaseCreate!: () => void;
		const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
		const originalCreate = store.create.bind(store); let createCalls = 0;
		store.create = async (...args: any[]) => { createCalls++; await createGate; return originalCreate(...args); };
		let bubbled = 0; const bubble = () => { bubbled++; }; root.addEventListener('keydown', bubble);
		assert.equal(key({ ctrlKey: true }).defaultPrevented, true);
		key({ ctrlKey: true }); key({ ctrlKey: true, repeat: true }); view.createButton.click();
		assert.equal(createCalls, 1); assert.equal(bubbled, 0);
		releaseCreate(); await settle(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(store.items.filter((x: any) => x.title === 'CtrlEnter仅一次').length, 1);
		assert.equal(input.value, '');
		input.value = '按住键期间的新草稿'; input.dispatchEvent(new window.Event('input'));
		key({ ctrlKey: true, repeat: true }); assert.equal(createCalls, 1);
		key({ metaKey: true }); await settle(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(createCalls, 2, 'Cmd+Enter remains supported');
		platform.isMobileApp = true; input.value = '手机点击'; input.dispatchEvent(new window.Event('input')); view.createButton.click();
		await settle(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(createCalls, 3); assert.equal(store.items.filter((x: any) => x.title === '手机点击').length, 1);
		root.removeEventListener('keydown', bubble); store.create = originalCreate;
		// Feedback is tied to saved completion, from both checkbox surfaces.
		let prepared = 0, played = 0;
		view.feedback = { prepare: () => { prepared++; }, play: () => {
			assert.ok(store.items.find((x: any) => x.id === reviewId).completedAt);
			played++;
		}, close: () => {} };
		await view.select(reviewId);
		view.detail.querySelector('.gvkit-arrange-detail-title-row input').click(); await settle();
		assert.equal(played, 1); assert.equal(prepared, 1);
		assert.equal(await store.complete(reviewId, true), false, 'already completed by another device is not a new completion');
		await view.toggleComplete(reviewId); assert.equal(played, 1, 'undo is silent');
		fail = true; await view.toggleComplete(reviewId); fail = false;
		assert.equal(played, 1, 'failed save is silent');
		assert.equal(store.items.find((x: any) => x.id === reviewId).completedAt, null);
		view.list.querySelector(`[data-id="${reviewId}"] input`).click(); await settle();
		assert.equal(played, 2);
		await view.toggleComplete(reviewId);
		await store.toggleDevelopmentCompleted(reviewId); await view.reload();
		assert.equal(played, 2, 'development and reload are silent');
		// A second device reads/writes its own configuration bytes, then the
		// existing Vault transport delivers those bytes to this open view.
		const statePath = 'settings/gvkit/arrange.md', stateFile = files.get(statePath);
		let otherDeviceBytes = await vault.read(stateFile);
		const otherVault = { ...vault,
			read: (file: any) => file.path === statePath ? Promise.resolve(otherDeviceBytes) : vault.read(file),
			process: async (file: any, change: (s: string) => string) => {
				assert.equal(file.path, statePath); otherDeviceBytes = change(otherDeviceBytes);
			} };
		const otherDevice = new ArrangeStore({ ...app, vault: otherVault }); await otherDevice.load();
		assert.deepEqual(otherDevice.state, store.state, 'all settings travel in the single Markdown file');
		await otherDevice.configure({ listFontSize: 21, pinColor: 'purple', composerMaxRows: 4,
			bodyPlaceholder: '另一设备同步提示', bodyMinRows: 5, timezone: 'Asia/Shanghai', rowActions: ['copy', 'top'] });
		await view.select(reviewId); view.editing.title.focus();
		view.editing.title.value = '同步时保留未保存标题';
		const draftNode = view.editing.title;
		view.busy = true;
		await writeFile(disk(statePath), otherDeviceBytes);
		for (const listener of vaultEvents.get('modify') ?? []) listener(stateFile);
		await new Promise(resolve => setTimeout(resolve, 220));
		assert.notEqual(store.state.listFontSize, 21, 'incoming refresh waits for the current operation');
		view.busy = false;
		// Debounce is followed by asynchronous disk reads; wait for their actual result.
		const syncDeadline = Date.now() + 5000;
		while (!isDeepStrictEqual(store.state, otherDevice.state) && Date.now() < syncDeadline)
			await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepEqual(store.state, otherDevice.state);
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-list-font'), '21px');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-body-rows'), '5');
		assert.equal(view.editing.body.placeholder, '另一设备同步提示');
		assert.equal(view.editing.title, draftNode); assert.equal(draftNode.value, '同步时保留未保存标题');
		assert.equal(played, 2, 'incoming settings never produce completion feedback');
		await view.saveEdit();
		await store.configure({ keyboardGap: 12 });
		otherDeviceBytes = await vault.read(stateFile); await otherDevice.load();
		assert.deepEqual(otherDevice.state, store.state, 'the existing file works in the return direction too');
		await view.onClose();
		assert.equal(slot.classList.contains('gvkit-arrange-host-title'), false);
		assert.equal(slot.querySelector('.gvkit-arrange-header'), null);
	} finally {
		view?.disposers.forEach((fn: () => void) => fn());
		await window.happyDOM.close();
		for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
		await rm(dir, { recursive: true, force: true });
	}
});
