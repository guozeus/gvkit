import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
export class Modal {} export class Menu {} export class Setting {}
export class Notice { constructor(message) { throw Error(message); } }
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
		const app = { vault, workspace: { getActiveViewOfType: () => active ? view : null,
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
		const pointer = (el: any, type: string, x: number, y: number) => el.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', clientX: x, clientY: y }));
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
		title.click(); assert.equal(title.selectionStart, title.value.length);
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
		assert.ok(root.querySelector('.gvkit-arrange-edit-error')!.textContent!.includes('模拟写入失败'));
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
