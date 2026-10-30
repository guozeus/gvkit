import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import type { MarkdownView, WorkspaceLeaf } from 'obsidian';

// Bundle the production module and its existing formatting dependency, as in the plugin build.
const bundled = await build({ entryPoints: ['src/readAloud.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { DocumentReadAloud, spokenMarkdown, speechChunks } = await import(
	'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles![0]!.contents).toString('base64'));

class Utterance {
	text: string;
	lang = '';
	rate = 1;
	voice: unknown = null;
	onstart: (() => void) | null = null;
	onend: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(text: string) { this.text = text; }
}

function harness(source = '# 你好\n这是当前文档。', path = '日志/当前.md') {
	const win = new Window();
	const spoken: Utterance[] = [], notices: string[] = [];
	let cancels = 0, duringClick = false, startedDuringClick = false;
	let preferences = { voiceURI: '', rate: 1 };
	let voices: Array<{voiceURI: string; lang: string}> = [];
	const synth = { getVoices: () => voices, cancel() { cancels++; }, speak(value: Utterance) {
		startedDuringClick = duringClick;
		spoken.push(value);
	} };
	Object.defineProperty(win, 'speechSynthesis', { value: synth, configurable: true });
	Object.defineProperty(win, 'SpeechSynthesisUtterance', { value: Utterance });
	const containerEl = win.document.createElement('div');
	win.document.body.append(containerEl);
	const view = {
		file: { path, extension: 'md' },
		getViewType: () => 'markdown',
		getViewData: () => source,
		containerEl,
		addAction: (_icon: string, title: string, callback: () => void) => {
			const button = win.document.createElement('button');
			button.setAttribute('aria-label', title);
			button.addEventListener('click', callback);
			containerEl.append(button);
			return button;
		},
	} as unknown as MarkdownView;
	const leaf = { view } as WorkspaceLeaf;
	let leaves = [leaf], active: MarkdownView | null = view;
	const reader = new DocumentReadAloud({
		getPreferences: () => ({ ...preferences }),
		getLeaves: () => leaves,
		getActiveView: () => active,
		setIcon: (button, icon) => button.setAttribute('data-icon', icon),
		notify: message => notices.push(message),
	});
	reader.refresh();
	const button = containerEl.querySelector('button')!;
	return { reader, view, leaf, win, button, spoken, notices,
		click() { duringClick = true; button.click(); duringClick = false; },
		setSource(value: string) { source = value; },
		setPreferences(value: typeof preferences) { preferences = value; },
		setVoices(value: typeof voices) { voices = value; },
		setActive(value: MarkdownView | null) { active = value; reader.refresh(); },
		removeLeaf() { leaves = []; reader.refresh(); },
		get cancels() { return cancels; }, get startedDuringClick() { return startedDuringClick; },
		cleanup() { reader.destroy(); win.happyDOM.abort(); },
	};
}

test('spoken copy keeps readable text and removes frontmatter and common markup', () => {
	const source = '---\r\ngvid: private-id\r\n---\r\n# 标题\r\n\r\n**粗体**、[链接](https://example.com)与[[目录/文档|别名]]。\n- [ ] 任务\n> 引用\n%%隐藏内容%%\n';
	const text = spokenMarkdown(source);
	assert.equal(text, '标题\n\n粗体、链接与别名。\n任务\n引用');
	assert.ok(source.includes('private-id'), 'original bytes remain untouched');
	assert.equal(spokenMarkdown('---\n属性: 值\n...\n正文'), '正文');
	assert.equal(spokenMarkdown('```js\nconst value = 1;\n```'), 'const value = 1;');
});

test('selected real voice and rate apply to every chunk, changes begin on the next tap', () => {
	const h = harness('朗读长文。'.repeat(160));
	try {
		const first = { voiceURI: 'device-zh', lang: 'zh-TW' }, second = { voiceURI: 'device-en', lang: 'en-GB' };
		h.setVoices([first, second]); h.setPreferences({ voiceURI: first.voiceURI, rate: 1.4 }); h.click();
		assert.equal(h.startedDuringClick, true);
		h.setPreferences({ voiceURI: second.voiceURI, rate: 0.7 });
		h.spoken[0]!.onstart!(); h.spoken[0]!.onend!();
		for (const value of h.spoken) {
			assert.equal(value.voice, first); assert.equal(value.lang, 'zh-TW'); assert.equal(value.rate, 1.4);
		}
		h.click(); h.click();
		assert.equal(h.spoken.at(-1)!.voice, second); assert.equal(h.spoken.at(-1)!.rate, 0.7);
	} finally { h.cleanup(); }
});

test('missing saved voice does not block default one-tap speech, and late voices work next time', () => {
	const h = harness();
	try {
		h.setPreferences({ voiceURI: 'late-voice', rate: 1.2 }); h.click();
		assert.equal(h.spoken[0]!.voice, null); assert.equal(h.spoken[0]!.lang, 'zh-CN');
		assert.equal(h.spoken[0]!.rate, 1.2); assert.equal(h.notices.length, 0);
		h.click(); const voice = { voiceURI: 'late-voice', lang: 'zh-CN' }; h.setVoices([voice]); h.click();
		assert.equal(h.spoken[1]!.voice, voice);
	} finally { h.cleanup(); }
});

test('chunks retain the entire long document, including surrogate pairs', () => {
	const text = ('这是长文。\n' + 'a'.repeat(231) + '😀').repeat(20);
	const chunks = speechChunks(text);
	assert.equal(chunks.join(''), text);
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every(chunk => chunk.length <= 240 && !/[\uD800-\uDBFF]$/.test(chunk)));
});

test('HTML blocks and existing GVKit colors retain their visible body for speech', () => {
	assert.equal(spokenMarkdown('<div>今天应提醒自己的重要内容。</div>\n\n普通正文。'), '今天应提醒自己的重要内容。\n\n普通正文。');
	assert.equal(spokenMarkdown('<!-- 注释不读 -->\n\n~={gv-blue}重要提醒=~，~={gv-bg-purple}正文=bg~。'), '重要提醒，正文。');
});

test('first tap starts synchronously with current editor data, second tap stops', () => {
	const h = harness();
	try {
		h.setSource('# 尚未保存\n当前编辑内容。');
		h.click();
		assert.equal(h.startedDuringClick, true, 'no asynchronous gap before iOS speak');
		assert.equal(h.spoken[0]?.text, '尚未保存\n当前编辑内容。');
		assert.equal(h.spoken[0]?.lang, 'zh-CN');
		assert.equal(h.button.getAttribute('aria-label'), '正在启动朗读，点击停止');
		h.spoken[0]!.onstart!();
		assert.equal(h.button.getAttribute('aria-label'), '正在朗读，点击停止');
		h.click();
		assert.equal(h.cancels, 2);
		assert.equal(h.button.getAttribute('aria-pressed'), 'false');
		assert.equal(h.notices.length, 0);
	} finally { h.cleanup(); }
});

test('long document advances only on speech completion and finishes with restored button', () => {
	const h = harness('第一段内容。'.repeat(120));
	try {
		h.click();
		let count = 0, text = '';
		while (h.spoken[count]) {
			const utterance = h.spoken[count++]!;
			text += utterance.text;
			utterance.onstart!(); utterance.onend!();
		}
		assert.ok(count > 1);
		assert.equal(text, '第一段内容。'.repeat(120));
		assert.equal(h.button.getAttribute('aria-pressed'), 'false');
	} finally { h.cleanup(); }
});

test('file switch cancels old note; next tap reads new note; late old callback cannot continue', () => {
	const h = harness('旧文档。'.repeat(120));
	try {
		h.click();
		const oldEnd = h.spoken[0]!.onend!;
		h.view.file = { path: '新文档.md', extension: 'md' } as any;
		h.setSource('New current note.'); h.reader.refresh();
		assert.equal(h.button.getAttribute('aria-pressed'), 'false');
		h.click();
		oldEnd();
		assert.equal(h.spoken.length, 2);
		assert.equal(h.spoken[1]?.text, 'New current note.');
		assert.equal(h.spoken[1]?.lang, 'en-US');
	} finally { h.cleanup(); }
});

test('changing active leaf, closing a leaf and unloading each cancel speech', () => {
	for (const action of ['switch', 'close', 'unload']) {
		const h = harness();
		try {
			h.click();
			if (action === 'switch') h.setActive(null);
			if (action === 'close') h.removeLeaf();
			if (action === 'unload') h.reader.destroy();
			assert.equal(h.cancels, 2, action);
			if (action !== 'switch') assert.equal(h.button.isConnected, false);
		} finally { h.cleanup(); }
	}
});

test('error clears playback and permits a fresh user retry', () => {
	const h = harness();
	try {
		h.click(); h.spoken[0]!.onerror!();
		assert.equal(h.notices.length, 1);
		assert.equal(h.button.getAttribute('aria-pressed'), 'false');
		h.click();
		assert.equal(h.spoken.length, 2);
	} finally { h.cleanup(); }
});

test('silent speech start times out honestly and user can retry', context => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	const h = harness();
	try {
		h.click();
		context.mock.timers.tick(8000);
		assert.equal(h.button.getAttribute('aria-pressed'), 'false');
		assert.equal(h.notices.length, 1);
		h.click(); assert.equal(h.spoken.length, 2);
	} finally { h.cleanup(); context.mock.timers.reset(); }
});

test('unsupported device and empty note show notices without claiming playback', () => {
	const empty = harness('---\ngvid: x\n---\n');
	const unsupported = harness();
	try {
		empty.click();
		assert.equal(empty.spoken.length, 0); assert.equal(empty.notices.length, 1);
		Object.defineProperty(unsupported.win, 'speechSynthesis', { value: undefined });
		unsupported.click();
		assert.equal(unsupported.spoken.length, 0); assert.equal(unsupported.notices.length, 1);
	} finally { empty.cleanup(); unsupported.cleanup(); }
});

test('refresh creates a single action even in log notes excluded from publishing', () => {
	const h = harness();
	try {
		h.reader.refresh(); h.reader.refresh();
		assert.equal(h.view.containerEl.querySelectorAll('button').length, 1);
		h.click(); assert.equal(h.spoken.length, 1);
		h.reader.destroy(); h.reader.refresh();
		assert.equal(h.view.containerEl.querySelectorAll('button').length, 0);
	} finally { h.cleanup(); }
});
