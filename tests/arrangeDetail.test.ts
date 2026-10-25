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
 register(fn) { this.disposers.push(fn); } registerEvent() {}
 registerInterval(id) { this.register(()=>window.clearInterval(id)); }
 registerDomEvent(el,type,fn) { el.addEventListener(type,fn); this.register(()=>el.removeEventListener(type,fn)); }
}
export const Platform={isMobileApp:true,isIosApp:false};
export class Modal {
 constructor() { this.contentEl=document.createElement('div'); }
 setTitle() {} open() { document.body.append(this.contentEl); } close() { this.contentEl.remove(); }
}
export class Menu {} export class Setting {}
export class Notice { constructor(message) { (window.notices ??= []).push(message); } }
export class TFile { constructor(path) { this.path=path;this.name=path.split('/').pop();this.basename=this.name.slice(0,-3); } }
export class TFolder {} export class Plugin {} export class WorkspaceLeaf {}
export const setIcon=(el,icon)=>{el.dataset.icon=icon};
export const MarkdownRenderer={render:async(app,text,el)=>{el.textContent=text}};
export function getFrontMatterInfo(s) { const end=s.indexOf('\\n---',4);return s.startsWith('---\\n')&&end>=0?{exists:true,frontmatter:s.slice(4,end),contentStart:end+5}:{exists:false,frontmatter:'',contentStart:0}; }
export const parseYaml=JSON.parse;
export const stringifyYaml=value=>JSON.stringify(value,null,2)+'\\n';
`;

test('inline edits persist to Markdown, switch safely, and retain drafts on invalid or failed saves', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'gvkit-detail-test-'));
	const window = new Window();
	const globals = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	let view: any;
	try {
		Object.assign(globalThis, { window, document: window.document });
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
		await build({ stdin: { contents: `export {ArrangeView} from './src/arrangeView';export {ArrangeStore} from './src/arrangeStore';export {TFile,TFolder} from 'obsidian';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'view.mjs'), plugins: [{ name: 'test-vault', setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
			b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: shim, loader: 'js' }));
		} }] });
		const { ArrangeView, ArrangeStore, TFile, TFolder } = await import(pathToFileURL(join(dir, 'view.mjs')).href);
		const files = new Map<string, any>();
		for (const path of ['安排/待执行', '安排/已完成', 'settings/gvkit']) files.set(path, new TFolder());
		const disk = (path: string) => join(dir, encodeURIComponent(path));
		let fail = false;
		let pause: (() => Promise<void>) | null = null;
		const vault = {
			on: () => ({}), getMarkdownFiles: () => [...files.values()].filter(f => f instanceof TFile),
			getAbstractFileByPath: (path: string) => files.get(path), read: (file: any) => readFile(disk(file.path), 'utf8'),
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
		const parent = await store.create('父事项', null);
		const first = await store.create('第一项完整标题', parent);
		const second = await store.create('第二项', null);
		const host = window.document.createElement('div'); window.document.body.append(host);
		host.innerHTML = '<div class="view-header"><button id="nav">导航</button><div class="view-header-title-container"><div class="view-header-title">自御安排</div></div><button id="native-more">宿主更多</button></div>';
		const hostHeader = host.querySelector<HTMLElement>('.view-header')!;
		hostHeader.getBoundingClientRect = () => ({ height: 44 } as any);
		const root = window.document.createElement('main'); host.append(root);
		view = new ArrangeView({ app, contentEl: root, containerEl: host }, store); await view.onOpen();
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
		let body = root.querySelector<HTMLTextAreaElement>('.gvkit-arrange-inline-body')!;
		assert.equal(body.hidden, false);
		assert.equal(body.placeholder, '记录正文、链接、思路…');
		for (const hint of ['写下下一步', '']) {
			await store.configure({ detailShadow: 0, bodyPlaceholder: hint }); view.applyComposerSettings();
			assert.equal(body.placeholder, hint);
			assert.equal(root.querySelector('.gvkit-arrange-body-placeholder')?.textContent, hint);
			assert.equal(body.hidden, false); assert.equal(body.value, '');
			assert.equal(root.style.getPropertyValue('--gvkit-arrange-detail-shadow'), 'none');
		}
		body.value = '## 附注\n[[原链接]]\n'; body.dispatchEvent(new window.Event('input'));
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
		for (const id of pinnedIds) await store.togglePin(id);
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
		// Complete in detail flushes both fields, keeps the panel and children, and can undo.
		await view.select(family);
		view.editing.title.value = '详情勾选前的标题'; view.editing.body.value = '保存中的正文\n下一行';
		view.detail.querySelector('.gvkit-arrange-detail-title-row input').click(); await settle();
		assert.equal(view.selected, family); assert.equal(view.detail.hidden, false);
		assert.ok(view.detail.querySelector('.gvkit-arrange-detail-title-row.is-completed'));
		await fresh.load();
		assert.equal(fresh.items.find((x: any) => x.id === family).body, '保存中的正文\n下一行');
		assert.equal(fresh.items.find((x: any) => x.id === children[0]).completedAt, null);
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
		assert.equal(view.editing.body.selectionStart, view.editing.body.value.indexOf('第二行文字') + 2);
		assert.equal(view.editing.body.value, '## 标题\n\n第一段 **加粗文字** 尾部\n\n第二行文字');
		delete (window.document as any).caretRangeFromPoint;
		view.renderBody(); const link = preview.createEl('a', { text: '链接', attr: { href: '#target' } }); link.click();
		assert.equal(view.editing.body.hidden, true, 'links do not enter the editor');
		// Settings update the existing editor, and new Store reads all preferences from Markdown.
		const preferences = { listFontSize: 14, rowHeight: 40, rowDividers: false, gripHeight: 56, gripWidth: 96,
			toolbarHeight: 56, parentFontSize: 18, closeThreshold: 10, selectionColor: 'purple' };
		await store.configure(preferences); view.applyComposerSettings(); view.paintLists(); await fresh.load();
		for (const [key, value] of Object.entries(preferences)) assert.equal(fresh.state[key], value);
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-row-slot'), '27px');
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
