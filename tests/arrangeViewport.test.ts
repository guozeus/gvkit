import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { defaultArrangeState } from '../src/arrangeCore.ts';

// Tests the production view's event ordering, not physical iOS keyboard layout.
const shim = `
export class ItemView {
 constructor(leaf) { Object.assign(this, leaf); this.disposers = []; }
 register(fn) { this.disposers.push(fn); }
 registerEvent() {}
 registerInterval(id) { this.register(() => window.clearInterval(id)); }
 registerDomEvent(el, type, fn) { el.addEventListener(type, fn); this.register(() => el.removeEventListener(type, fn)); }
}
export const Platform = { isMobileApp: true, isIosApp: true };
export class Modal {}
export class Menu {}
export class Notice { constructor(message) { throw Error(message); } }
export class Setting {}
export class TFile {}
export class TFolder {}
export class Plugin {}
export class WorkspaceLeaf {}
export const MarkdownRenderer = { render: async () => {} };
export const setIcon = () => {};
export const getFrontMatterInfo = () => ({});
export const parseYaml = JSON.parse;
export const stringifyYaml = JSON.stringify;
`;

test('keyboard compensation follows delayed host resize, preserves draft, and cleans up', async () => {
	const bundle = await build({ entryPoints: ['src/arrangeView.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
		plugins: [{ name: 'obsidian-shim', setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
			b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: shim, loader: 'js' }));
		} }] });
	const module: any = { exports: {} };
	new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
	const window = new Window();
	const meta = window.document.createElement('meta');
	meta.name = 'viewport'; meta.content = 'width=device-width, initial-scale=1, maximum-scale=5';
	window.document.head.append(meta);
	const originalViewport = meta.content;
	const saved = new Map(['window', 'document', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	let notifyResize = () => {};
	let disconnected = false;
	let observedBox = '';
	let observedTarget: unknown;
	const viewport = Object.assign(new window.EventTarget(), { height: 500, offsetTop: 0 });
	Object.defineProperty(window, 'visualViewport', { value: viewport });
	const root = window.document.createElement('div');
	window.document.body.append(root);
	let hostBottom = 844;
	root.getBoundingClientRect = () => ({ bottom: hostBottom, left: 0, width: 440 } as any);
	const proto: any = window.HTMLElement.prototype;
	proto.empty = function () { this.replaceChildren(); };
	proto.addClass = function (...names: string[]) { this.classList.add(...names); };
	proto.toggleClass = function (name: string, on: boolean) { this.classList.toggle(name, on); };
	proto.createEl = function (tag: string, options: any = {}) {
		if (typeof options === 'string') options = { cls: options };
		const el = window.document.createElement(tag);
		if (options.cls) el.className = options.cls;
		if (options.text) el.textContent = options.text;
		for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
		this.append(el); return el;
	};
	proto.createDiv = function (options: unknown) { return this.createEl('div', options); };
	proto.createSpan = function (options: unknown) { return this.createEl('span', options); };
	Object.assign(globalThis, { window, document: window.document, ResizeObserver: class {
		constructor(callback: () => void) { notifyResize = callback; }
		observe(target: unknown, options: { box: string }) { observedTarget = target; observedBox = options.box; }
		disconnect() { disconnected = true; }
	} });
	let view: any;
	let active = true;
	const leafCallbacks: (() => void)[] = [];
	const changeLeaf = () => leafCallbacks.forEach(fn => fn());
	try {
		const store = { load: async () => {}, facts: () => ({ day: '2026-10-26', x: 0, y: 0, remaining: 0, achieved: false, color: 'blue' }), items: [] as any[], state: defaultArrangeState() };
		view = new module.exports.ArrangeView({ contentEl: root, app: {
			vault: { on: () => ({}) },
			workspace: { getActiveViewOfType: () => active ? view : null, on: (_name: string, fn: () => void) => { leafCallbacks.push(fn); return {}; } },
		} }, store);
		await view.onOpen();
		assert.equal(root.dataset.ignoreSwipe, 'true');
		assert.equal(window.document.body.dataset.ignoreSwipe, undefined, 'normal notes must retain host swipes');
		assert.equal(root.style.paddingBottom, '344px', 'opening with an already visible keyboard fits immediately');
		assert.equal(observedTarget, root);
		assert.equal(observedBox, 'border-box');
		const input = root.querySelector('textarea')!;
		input.style.fontSize = '8px';
		input.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
		assert.match(meta.content, /maximum-scale=1/);
		assert.ok(!meta.content.includes('maximum-scale=5'));
		input.dispatchEvent(new window.Event('pointercancel', { bubbles: true }));
		await new Promise(resolve => window.setTimeout(resolve, 5));
		assert.equal(meta.content, originalViewport, 'scroll gesture without focus cannot leave a viewport lock');
		input.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
		input.focus();
		const second = root.createEl('textarea');
		second.style.fontSize = '9px'; second.focus();
		await new Promise(resolve => window.setTimeout(resolve, 5));
		assert.match(meta.content, /maximum-scale=1/, 'moving between small editors retains protection');
		second.blur();
		await new Promise(resolve => window.setTimeout(resolve, 5));
		assert.equal(meta.content, originalViewport, 'blur restores exact host viewport');
		input.focus(); active = false; changeLeaf();
		assert.equal(meta.content, originalViewport, 'leaving the view restores viewport');
		active = true; input.blur(); second.remove(); input.style.fontSize = '16px'; input.focus();
		assert.equal(meta.content, originalViewport, 'normal-size editors do not change host viewport');
		const submit = root.querySelector<HTMLButtonElement>('.gvkit-arrange-submit')!;
		assert.equal(submit.hidden, true, 'empty input does not show a submit button');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-keyboard-gap'), '7px');
		input.value = '尚未提交的中文草稿'; input.focus();
		input.dispatchEvent(new window.Event('input'));
		assert.equal(submit.hidden, false);
		input.value = ' \n '; input.dispatchEvent(new window.Event('input'));
		assert.equal(submit.hidden, true, 'whitespace cannot be submitted');
		input.value = '尚未提交的中文草稿'; input.dispatchEvent(new window.Event('input'));
		store.state.keyboardGap = 0; await view.reload();
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-keyboard-gap'), '0px');
		// Native host catches up after the last visualViewport event.
		hostBottom = 500; notifyResize();
		assert.equal(root.style.paddingBottom, '', 'host-reserved space must not be subtracted twice');
		// Host can also resize first; only the remaining obscured region is padded.
		hostBottom = 844; notifyResize();
		assert.equal(root.style.paddingBottom, '344px');
		viewport.offsetTop = 30; viewport.dispatchEvent(new window.Event('scroll'));
		assert.equal(root.style.paddingBottom, '314px');
		viewport.height = 460; viewport.dispatchEvent(new window.Event('resize'));
		assert.equal(root.style.paddingBottom, '354px');
		hostBottom = 490; notifyResize();
		assert.equal(root.style.paddingBottom, '');
		viewport.height = 844; viewport.offsetTop = 0; viewport.dispatchEvent(new window.Event('resize'));
		hostBottom = 844; notifyResize();
		assert.equal(root.style.paddingBottom, '');
		assert.equal(root.querySelectorAll('.gvkit-arrange-composer textarea').length, 1);
		assert.equal(root.querySelector('textarea'), input);
		assert.equal(input.value, '尚未提交的中文草稿');
		assert.equal(window.document.activeElement, input);
		viewport.height = 500; viewport.dispatchEvent(new window.Event('resize'));
		assert.equal(root.style.paddingBottom, '344px');
		// iPhone trace: viewport stays 956; CSS inset arrives before the host shrinks.
		Object.defineProperty(window, 'innerHeight', { value: 956 });
		const hostStyle = window.document.createElement('style');
		hostStyle.textContent = '.gvkit-arrange { padding-bottom: var(--safe-area-inset-bottom) !important; }';
		window.document.head.append(hostStyle);
		viewport.height = 956; hostBottom = 956;
		root.style.setProperty('--safe-area-inset-bottom', '378px');
		root.style.setProperty('--keyboard-height', '378px');
		viewport.dispatchEvent(new window.Event('scroll'));
		assert.equal(root.style.paddingBottom, '378px', 'before host shrink the keyboard still needs avoidance');
		assert.equal(root.classList.contains('gvkit-arrange-keyboard-open'), true);
		const backdrop = window.document.querySelector<HTMLElement>('.gvkit-arrange-keyboard-backdrop')!;
		assert.equal(backdrop.hidden, false);
		assert.equal(backdrop.style.top, '577px');
		assert.equal(backdrop.style.width, '440px');
		active = false; changeLeaf(); assert.equal(backdrop.hidden, true, 'switching leaves hides decoration immediately');
		active = true; changeLeaf(); assert.equal(backdrop.hidden, false);
		hostBottom = 578; notifyResize();
		assert.equal(root.style.paddingBottom, '0px', 'explicit zero prevents the host CSS inset returning');
		assert.equal(window.getComputedStyle(root).paddingBottom, '0px');
		assert.equal(root.style.getPropertyPriority('padding-bottom'), 'important');
		// A keyboard height change is also phased: only its uncovered difference is reserved.
		root.style.setProperty('--keyboard-height', '400px');
		root.style.setProperty('--safe-area-inset-bottom', '400px');
		viewport.dispatchEvent(new window.Event('scroll'));
		assert.equal(root.style.paddingBottom, '22px');
		hostBottom = 556; notifyResize();
		assert.equal(root.style.paddingBottom, '0px');
		root.style.setProperty('--keyboard-height', '0px');
		root.style.setProperty('--safe-area-inset-bottom', '34px');
		hostBottom = 956; notifyResize();
		assert.equal(root.style.paddingBottom, '');
		assert.equal(root.style.getPropertyPriority('padding-bottom'), '');
		assert.equal(window.getComputedStyle(root).paddingBottom, '34px', 'keyboard close restores the original idle CSS');
		assert.equal(root.classList.contains('gvkit-arrange-keyboard-open'), false);
		assert.equal(backdrop.hidden, true, 'keyboard close hides the background');
		assert.equal(input.value, '尚未提交的中文草稿');
		assert.equal(root.querySelector('textarea'), input);
		root.style.setProperty('--keyboard-height', '378px'); notifyResize();
		assert.equal(root.classList.contains('gvkit-arrange-keyboard-open'), true);
		input.style.fontSize = '8px'; input.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
		assert.match(meta.content, /maximum-scale=1/);
		// Model the native focus scroll racing the first keyboard/host reflow.
		store.items.push({ id: 'focus-item', title: '首次标题', body: '正文', parent: null, date: null, completedAt: null, pinned: false });
		await view.select('focus-item');
		const title = root.querySelector<HTMLTextAreaElement>('.gvkit-arrange-detail-title')!;
		const scroller = root.querySelector<HTMLElement>('.gvkit-arrange-detail-scroll')!;
		scroller.scrollTop = 0;
		title.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
		scroller.scrollTop = 120; // Native first-focus scroll used the pre-keyboard panel.
		title.focus(); title.setSelectionRange(2, 2);
		notifyResize();
		assert.equal(scroller.scrollTop, 0, 'first fit restores the position captured before focus');
		assert.equal(title.selectionStart, 2, 'native caret placement survives');
		title.dispatchEvent(new window.Event('touchmove', { bubbles: true })); scroller.scrollTop = 60;
		notifyResize();
		assert.equal(scroller.scrollTop, 60, 'user selection/scroll owns position after first focus');
		title.blur(); input.focus();
		await view.onClose(); view.disposers.forEach((fn: () => void) => fn());
		assert.equal(root.dataset.ignoreSwipe, undefined, 'closing restores host behavior');
		assert.equal(meta.content, originalViewport, 'unloading restores the original viewport');
		assert.equal(window.document.querySelector('.gvkit-arrange-keyboard-backdrop'), null);
		assert.equal(disconnected, true);
		assert.equal(root.classList.contains('gvkit-arrange-keyboard-open'), false);
		assert.equal(root.style.paddingBottom, '');
		assert.equal(root.style.getPropertyValue('--gvkit-arrange-keyboard-gap'), '');
		viewport.height = 400; viewport.dispatchEvent(new window.Event('resize'));
		assert.equal(root.style.paddingBottom, '', 'closed view has no viewport listeners');
	} finally {
		view?.disposers.forEach((fn: () => void) => fn());
		await window.happyDOM.close();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
