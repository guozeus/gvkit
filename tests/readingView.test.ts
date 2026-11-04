import assert from 'node:assert/strict';
import test from 'node:test';

import { Window } from 'happy-dom';

import { renderGvkitStyles } from '../src/readingView.ts';

function createRoot(html: string): { window: Window; root: HTMLElement } {
	const window = new Window();
	const root = window.document.createElement('div') as unknown as HTMLElement;
	root.innerHTML = html;
	window.document.body.appendChild(root as unknown as Node);

	Object.assign(globalThis, {
		document: window.document,
		Node: window.Node,
		NodeFilter: window.NodeFilter,
		Text: window.Text,
		HTMLElement: window.HTMLElement,
	});

	return { window, root };
}

test('reading view renders multiple text colors in one pass without leaving markers', () => {
	const { root } = createRoot('<p>~={gv-blue}甲=~ / ~={gv-purple}乙=~ / ~={gv-blue}丙=~</p>');

	renderGvkitStyles(root);

	assert.equal(root.querySelectorAll('.gvkit-text-blue').length, 2);
	assert.equal(root.querySelectorAll('.gvkit-text-purple').length, 1);
	assert.equal(root.textContent, '甲 / 乙 / 丙');
	assert.ok(!root.innerHTML.includes('~={gv-'));
});

test('reading view preserves Markdown-rendered strong and links inside a color layer', () => {
	const { root } = createRoot(
		'<p>~={gv-blue}<strong>重要</strong> <a href="/target">链接</a>=~</p>',
	);

	renderGvkitStyles(root);

	const span = root.querySelector('.gvkit-text-blue');
	assert.ok(span);
	assert.equal(span.querySelector('strong')?.textContent, '重要');
	assert.equal(span.querySelector('a')?.getAttribute('href'), '/target');
	assert.equal(span.textContent, '重要 链接');
});

test('reading view preserves independent nested text and background layers', () => {
	const { root } = createRoot(
		'<p>~={gv-bg-purple}~={gv-blue}<strong>结论</strong>=~=bg~</p>',
	);

	renderGvkitStyles(root);

	const background = root.querySelector('.gvkit-bg-purple');
	const text = background?.querySelector('.gvkit-text-blue');
	assert.ok(background);
	assert.ok(text);
	assert.equal(text.querySelector('strong')?.textContent, '结论');
	assert.equal(root.textContent, '结论');
});

test('reading view processing is idempotent after markers have been converted', () => {
	const { root } = createRoot(
		'<p>~={gv-blue}文字=~ + ~={gv-bg-purple}背景=bg~</p>',
	);

	renderGvkitStyles(root);
	const first = root.innerHTML;
	renderGvkitStyles(root);

	assert.equal(root.innerHTML, first);
});

test('popout text nodes keep both color layers without exposing markers from a different window', () => {
	const { root: mainRoot } = createRoot('<p>~={gv-blue}主窗口=~</p>');
	const popout = new Window();
	const root = popout.document.createElement('div');
	root.innerHTML = '<p>~={gv-blue}<strong>正文</strong> <a href="/target">链接</a>=~ / ~={gv-bg-purple}背景=bg~</p><p><code>~={gv-blue}代码=~</code></p>';
	popout.document.body.append(root);
	assert.equal(root.querySelector('p')!.firstChild instanceof Text, false, 'text belongs to the popout realm');
	renderGvkitStyles(root as unknown as HTMLElement);
	assert.equal(root.querySelector('p')!.textContent, '正文 链接 / 背景');
	assert.equal(root.querySelector('.gvkit-text-blue strong')?.textContent, '正文');
	assert.equal(root.querySelector('.gvkit-text-blue a')?.getAttribute('href'), '/target');
	assert.equal(root.querySelector('.gvkit-bg-purple')?.textContent, '背景');
	assert.equal(root.querySelector('code')?.textContent, '~={gv-blue}代码=~');
	const rendered = root.innerHTML;
	renderGvkitStyles(root as unknown as HTMLElement);
	assert.equal(root.innerHTML, rendered, 'lazy postprocessing remains idempotent');
	renderGvkitStyles(mainRoot);
	assert.equal(mainRoot.textContent, '主窗口', 'main-window behavior is unchanged');
});

test('reading view leaves gvkit-looking text inside code untouched', () => {
	const { root } = createRoot('<pre><code>~={gv-blue}code=~</code></pre>');

	renderGvkitStyles(root);

	assert.equal(root.querySelector('.gvkit-text-blue'), null);
	assert.equal(root.textContent, '~={gv-blue}code=~');
});

test('many markers do not cause repeated whole-root scans', () => {
	const source = Array.from({ length: 50 }, (_, index) => `~={gv-blue}${index}=~`).join(' ');
	const { root } = createRoot(`<p>${source}</p>`);
	const originalCreateTreeWalker = document.createTreeWalker.bind(document);
	let treeWalkerCount = 0;

	document.createTreeWalker = ((...args: Parameters<Document['createTreeWalker']>) => {
		treeWalkerCount += 1;
		return originalCreateTreeWalker(...args);
	}) as Document['createTreeWalker'];

	renderGvkitStyles(root);

	assert.equal(root.querySelectorAll('.gvkit-text-blue').length, 50);
	assert.equal(treeWalkerCount, 2, 'text and background each scan the root once');
});
