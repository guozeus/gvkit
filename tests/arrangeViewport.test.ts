import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

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
	root.getBoundingClientRect = () => ({ bottom: hostBottom } as any);
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
	try {
		const store = { load: async () => {}, items: [], state: { timezone: 'Asia/Shanghai', order: [], achievedDays: [] } };
		view = new module.exports.ArrangeView({ contentEl: root, app: { vault: { on: () => ({}) } } }, store);
		await view.onOpen();
		assert.equal(root.style.paddingBottom, '344px', 'opening with an already visible keyboard fits immediately');
		assert.equal(observedTarget, root);
		assert.equal(observedBox, 'border-box');
		const input = root.querySelector('textarea')!;
		input.value = '尚未提交的中文草稿'; input.focus();
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
		view.keyboardDiagnostics.select('off');
		assert.equal(root.style.paddingBottom, '', 'A/B off removes existing padding immediately');
		viewport.height = 460; viewport.dispatchEvent(new window.Event('resize')); notifyResize();
		assert.equal(root.style.paddingBottom, '', 'viewport and observer cannot reapply compensation while off');
		assert.equal(root.querySelector('textarea'), input);
		assert.equal(input.value, '尚未提交的中文草稿');
		assert.equal(window.document.activeElement, input);
		view.keyboardDiagnostics.select('current');
		assert.equal(root.style.paddingBottom, '384px', 'the original calculation is reversible');
		view.keyboardDiagnostics.select('off');
		view.keyboardDiagnostics.stop();
		assert.equal(root.style.paddingBottom, '384px', 'ending diagnosis restores default behavior');
		assert.equal(view.keyboardDiagnostics.active, false);
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
		hostBottom = 578; notifyResize();
		assert.equal(root.style.paddingBottom, '0px', 'explicit zero prevents the host CSS inset returning');
		assert.equal(window.getComputedStyle(root).paddingBottom, '0px');
		assert.equal(root.style.getPropertyPriority('padding-bottom'), 'important');
		view.keyboardDiagnostics.select('off');
		assert.equal(window.getComputedStyle(root).paddingBottom, '378px', 'raw host CSS reproduces the diagnosed double reservation');
		view.keyboardDiagnostics.stop();
		assert.equal(window.getComputedStyle(root).paddingBottom, '0px');
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
		assert.equal(input.value, '尚未提交的中文草稿');
		assert.equal(root.querySelector('textarea'), input);
		root.style.setProperty('--keyboard-height', '378px'); notifyResize();
		assert.equal(root.classList.contains('gvkit-arrange-keyboard-open'), true);
		await view.onClose(); view.disposers.forEach((fn: () => void) => fn());
		assert.equal(disconnected, true);
		assert.equal(root.classList.contains('gvkit-arrange-keyboard-open'), false);
		assert.equal(root.style.paddingBottom, '');
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
