import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { PublishSettings } from '../src/publishSettings.ts';

const bundle = await build({ entryPoints: ['src/quickSettings.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
	plugins: [{ name: 'obsidian-adapter', setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
		b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class Modal {}' }));
	} }],
});
const { renderQuickSettings, DocumentQuickSettings } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles![0]!.contents).toString('base64'));
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('real voice list arrives late; choices persist through existing queue without altering other settings', async () => {
	const win = new Window(), root = win.document.createElement('div'); win.document.body.append(root);
	let saved: any = { publishShortcut: false, arrange: { keep: true }, zhouyouSyncUrl: 'https://example.com/api/producer-documents/obsidian-sync' };
	const store = new PublishSettings({ loadData: async () => saved, saveData: async d => { saved = structuredClone(d); } }); await store.load();
	const synth = new win.EventTarget() as any;
	let voices: any[] = []; synth.getVoices = () => voices;
	const cleanup = renderQuickSettings(root as any, synth, store);
	try {
		const voice = root.querySelector('select')!, rate = root.querySelector('input')!;
		assert.equal(voice.options.length, 1); assert.match(root.textContent, /尚未返回/);
		voices = [{ voiceURI: 'device-a', name: '设备声音甲', lang: 'zh-CN' }, { voiceURI: 'device-b', name: 'Device B', lang: 'en-US' }];
		synth.dispatchEvent(new win.Event('voiceschanged'));
		assert.equal(voice.options.length, 2); assert.equal(voice.options[1]!.text, '设备声音甲 · zh-CN');
		voice.value = 'device-a'; voice.dispatchEvent(new win.Event('change'));
		rate.value = '1.4'; rate.dispatchEvent(new win.Event('input')); rate.dispatchEvent(new win.Event('change'));
		await store.setPublishShortcut(true); await settle();
		assert.deepEqual(saved.readAloud, { voiceURI: 'device-a', rate: 1.4 });
		assert.equal(saved.publishShortcut, true); assert.deepEqual(saved.arrange, { keep: true });
		assert.equal(saved.zhouyouSyncUrl, 'https://example.com/api/producer-documents/obsidian-sync');
		assert.match(root.textContent, /已保存/);
		const reloaded = new PublishSettings({ loadData: async () => saved, saveData: async () => {} }); await reloaded.load();
		assert.deepEqual(reloaded.getReadAloudPreferences(), saved.readAloud);
		cleanup(); voices = []; synth.dispatchEvent(new win.Event('voiceschanged')); assert.equal(voice.options.length, 2);
	} finally { cleanup(); await win.happyDOM.abort(); }
});

test('missing saved voice remains saved when changing rate; failed save is shown honestly', async () => {
	const win = new Window(), root = win.document.createElement('div');
	let fail = false;
	const store = new PublishSettings({ loadData: async () => ({ readAloud: { voiceURI: 'other-device', rate: 1.2 } }), saveData: async () => { if (fail) throw Error('disk'); } }); await store.load();
	const cleanup = renderQuickSettings(root as any, undefined, store);
	try {
		const rate = root.querySelector('input')!; rate.value = '1.5'; rate.dispatchEvent(new win.Event('change')); await settle();
		assert.deepEqual(store.getReadAloudPreferences(), { voiceURI: 'other-device', rate: 1.5 });
		fail = true; rate.value = '1.8'; rate.dispatchEvent(new win.Event('change')); await settle();
		assert.match(root.textContent, /未能保存/); assert.equal(rate.value, '1.5');
		assert.deepEqual(store.getReadAloudPreferences(), { voiceURI: 'other-device', rate: 1.5 });
	} finally { cleanup(); await win.happyDOM.abort(); }
});

test('invalid persisted rate falls back to normal speed', async () => {
	for (const rate of [null, '2', 0, 4, NaN]) {
		const store = new PublishSettings({ loadData: async () => ({ readAloud: { rate } }), saveData: async () => {} }); await store.load();
		assert.equal(store.getReadAloudPreferences().rate, 1);
	}
});

test('only device zh-family choices are shown; a saved non-Chinese choice survives rate changes', async () => {
	const win = new Window(), root = win.document.createElement('div');
	const store = new PublishSettings({ loadData: async () => ({ readAloud: { voiceURI: 'en', rate: 1 } }), saveData: async () => {} }); await store.load();
	const synth = new win.EventTarget() as any;
	synth.getVoices = () => ['zh-CN', 'zh-TW', 'zh-HK', 'zh_HK', 'ZH', 'en-US', 'ja-JP'].map((lang, index) => ({ voiceURI: index === 5 ? 'en' : lang, name: lang, lang }));
	const cleanup = renderQuickSettings(root as any, synth, store);
	try {
		assert.deepEqual([...root.querySelector('select')!.options].map(option => option.value), ['', 'zh-CN', 'zh-TW', 'zh-HK', 'zh_HK', 'ZH']);
		assert.match(root.textContent, /其他语言音色继续保留/);
		const rate = root.querySelector('input')!; rate.value = '1.2'; rate.dispatchEvent(new win.Event('change')); await settle();
		assert.deepEqual(store.getReadAloudPreferences(), { voiceURI: 'en', rate: 1.2 });
		assert.equal(root.querySelector('.gvkit-quick-settings-controls')!.children.length, 2);
	} finally { cleanup(); await win.happyDOM.abort(); }
});

test('gear on all Markdown; only native mobile mode button hidden, restored on unload; desktop untouched', async () => {
	const css = await readFile('styles.css', 'utf8');
	for (const mobile of [true, false]) {
		const win = new Window(), doc = win.document; doc.body.classList.toggle('is-mobile', mobile);
		const style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
		const containerEl = doc.createElement('div'); containerEl.className = 'workspace-leaf-content'; containerEl.setAttribute('data-type', 'markdown'); doc.body.append(containerEl);
		const actions = doc.createElement('div'); actions.className = 'view-actions'; containerEl.append(actions);
		const native = doc.createElement('button'); actions.append(native); let mode = 'source'; native.onclick = () => { mode = mode === 'source' ? 'preview' : 'source'; };
		const other = ['更多', '发布', '朗读', '第三方插件'].map(title => { const b = doc.createElement('button'); b.textContent = title; actions.append(b); return b; });
		let opens = 0;
		const view = { containerEl, modeButtonEl: native, file: { extension: 'md', path: '日志/任意.md' }, getViewType: () => 'markdown',
			addAction: (_icon: string, title: string, callback: () => void) => { const b = doc.createElement('button'); b.textContent = title; b.onclick = callback; actions.prepend(b); return b; } };
		const leaf = { view }; let leaves = [leaf];
		const manager = new DocumentQuickSettings({ isMobile: mobile, getLeaves: () => leaves, openSettings: (v: unknown) => { assert.equal(v, view); opens++; } });
		try {
			manager.refresh(); manager.refresh();
			const gear = actions.querySelector('.gvkit-quick-settings-action')! as any; gear.click(); assert.equal(opens, 1);
			assert.equal(actions.lastElementChild, gear, 'gear follows every actual action including native more-options');
			const late = doc.createElement('button'); late.textContent = 'late plugin'; actions.prepend(late); manager.refresh();
			assert.equal(actions.lastElementChild, gear); late.remove();
			assert.equal(actions.children.length, 6);
			assert.equal(win.getComputedStyle(native).display === 'none', mobile);
			for (const b of other) assert.notEqual(win.getComputedStyle(b).display, 'none');
			native.click(); assert.equal(mode, 'preview', 'native switching is still enabled');
			leaves = []; manager.refresh(); assert.equal(gear.isConnected, false); assert.equal(native.classList.contains('gvkit-hide-mode-toggle'), false);
			leaves = [leaf]; manager.refresh(); manager.destroy();
			assert.equal(actions.children.length, 5); assert.equal(native.classList.contains('gvkit-hide-mode-toggle'), false);
		} finally { manager.destroy(); await win.happyDOM.abort(); }
	}
});
