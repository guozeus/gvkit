import assert from 'node:assert/strict';
import test from 'node:test';

import {
	applyGvkitStyleMarkup,
	applyStyleToSourceSelection,
	removeGvkitStyleMarkup,
	toggleBoldInSourceSelection,
} from '../src/formatting.ts';

test('applies blue text with non-HTML gvkit syntax', () => {
	assert.equal(applyGvkitStyleMarkup('重要结论', 'text-blue'), '~={gv-blue}重要结论=~');
});

test('applies purple background with independent gvkit syntax', () => {
	assert.equal(applyGvkitStyleMarkup('需要关注', 'bg-purple'), '~={gv-bg-purple}需要关注=bg~');
});

test('preserves bold inside text color as an independent formatting layer', () => {
	assert.equal(applyGvkitStyleMarkup('**重要结论**', 'text-blue'), '~={gv-blue}**重要结论**=~');
});

test('preserves bold inside background color as an independent formatting layer', () => {
	assert.equal(applyGvkitStyleMarkup('**重要结论**', 'bg-blue'), '~={gv-bg-blue}**重要结论**=bg~');
});

test('text color and background color compose without replacing each other', () => {
	const blueText = applyGvkitStyleMarkup('**结论**', 'text-blue');
	assert.equal(applyGvkitStyleMarkup(blueText, 'bg-purple'), '~={gv-bg-purple}~={gv-blue}**结论**=~=bg~');
});

test('styles multi-line selections line-by-line', () => {
	assert.equal(
		applyGvkitStyleMarkup('第一行\n第二行', 'bg-blue'),
		'~={gv-bg-blue}第一行=bg~\n~={gv-bg-blue}第二行=bg~',
	);
});

test('same text color toggles off when the full wrapper is selected', () => {
	assert.equal(applyGvkitStyleMarkup('~={gv-blue}结论=~', 'text-blue'), '结论');
});

test('same background color toggles off when the full wrapper is selected', () => {
	assert.equal(applyGvkitStyleMarkup('~={gv-bg-blue}结论=bg~', 'bg-blue'), '结论');
});

test('same style kind switches colors without nesting', () => {
	assert.equal(applyGvkitStyleMarkup('==🔵结论==', 'bg-purple'), '~={gv-bg-purple}结论=bg~');
});

test('converts a normal Obsidian highlight to a colored highlight without nesting', () => {
	assert.equal(applyGvkitStyleMarkup('==结论==', 'bg-blue'), '~={gv-bg-blue}结论=bg~');
});

test('clear removes gvkit color layers but preserves Markdown bold', () => {
	const source = '~={gv-bg-purple}~={gv-blue}**结论**=~=bg~';
	assert.equal(removeGvkitStyleMarkup(source), '**结论**');
});

test('clear remains backward compatible with 0.1.0 HTML markup', () => {
	const source = '<em><span class="gvkit-text-blue"><mark class="gvkit-bg-purple">结论</mark></span></em>';
	assert.equal(removeGvkitStyleMarkup(source), '<em>结论</em>');
});


test('second tap toggles text color off while only visible text is selected', () => {
	const source = '~={gv-blue}重要结论=~';
	const result = applyStyleToSourceSelection(source, '~={gv-blue}'.length, '~={gv-blue}'.length + '重要结论'.length, 'text-blue');
	assert.equal(result.source, '重要结论');
	assert.equal(result.selectionFrom, 0);
	assert.equal(result.selectionTo, '重要结论'.length);
});

test('second tap toggles background off while only visible text is selected', () => {
	const open = '~={gv-bg-purple}';
	const source = `${open}重要结论=bg~`;
	const result = applyStyleToSourceSelection(source, open.length, open.length + '重要结论'.length, 'bg-purple');
	assert.equal(result.source, '重要结论');
	assert.equal(result.selectionFrom, 0);
	assert.equal(result.selectionTo, '重要结论'.length);
});

test('toggling text color off preserves nested background and bold', () => {
	const prefix = '**~={gv-blue}~={gv-bg-purple}';
	const source = `${prefix}结论=bg~=~**`;
	const from = prefix.length;
	const result = applyStyleToSourceSelection(source, from, from + '结论'.length, 'text-blue');
	assert.equal(result.source, '**~={gv-bg-purple}结论=bg~**');
});

test('toggling background off preserves text color and bold', () => {
	const prefix = '**~={gv-blue}~={gv-bg-purple}';
	const source = `${prefix}结论=bg~=~**`;
	const from = prefix.length;
	const result = applyStyleToSourceSelection(source, from, from + '结论'.length, 'bg-purple');
	assert.equal(result.source, '**~={gv-blue}结论=~**');
});

test('switching text color keeps the visible selection selected', () => {
	const open = '~={gv-blue}';
	const source = `${open}结论=~`;
	const result = applyStyleToSourceSelection(source, open.length, open.length + 2, 'text-purple');
	assert.equal(result.source, '~={gv-purple}结论=~');
	assert.equal(result.source.slice(result.selectionFrom, result.selectionTo), '结论');
});

test('applying style keeps the visible text selected for immediate second tap', () => {
	const result = applyStyleToSourceSelection('结论', 0, 2, 'text-blue');
	assert.equal(result.source, '~={gv-blue}结论=~');
	assert.equal(result.source.slice(result.selectionFrom, result.selectionTo), '结论');
});

test('source-aware application still keeps multi-line inline markup line-scoped', () => {
	const result = applyStyleToSourceSelection('第一行\n第二行', 0, '第一行\n第二行'.length, 'bg-blue');
	assert.equal(result.source, '~={gv-bg-blue}第一行=bg~\n~={gv-bg-blue}第二行=bg~');
});

test('clear from visible selection removes both color layers and keeps bold', () => {
	const prefix = '**~={gv-blue}~={gv-bg-purple}';
	const source = `${prefix}结论=bg~=~**`;
	const from = prefix.length;
	const result = applyStyleToSourceSelection(source, from, from + '结论'.length, 'clear');
	assert.equal(result.source, '**结论**');
	assert.equal(result.source.slice(result.selectionFrom, result.selectionTo), '结论');
});

test('immediate second tap after applying color toggles it back off', () => {
	const first = applyStyleToSourceSelection('结论', 0, 2, 'text-blue');
	const second = applyStyleToSourceSelection(first.source, first.selectionFrom, first.selectionTo, 'text-blue');
	assert.equal(second.source, '结论');
	assert.equal(second.source.slice(second.selectionFrom, second.selectionTo), '结论');
});


test('legacy 0.1.1 background syntax is still removable', () => {
	assert.equal(removeGvkitStyleMarkup('==🔵旧内容=='), '旧内容');
});

test('switching a legacy colored highlight converts it to the independent background layer', () => {
	const open = '==🔵';
	const source = `${open}旧内容==`;
	const result = applyStyleToSourceSelection(source, open.length, open.length + '旧内容'.length, 'bg-purple');
	assert.equal(result.source, '~={gv-bg-purple}旧内容=bg~');
	assert.equal(result.source.slice(result.selectionFrom, result.selectionTo), '旧内容');
});

test('converts a normal yellow highlight selected by visible content into gvkit background', () => {
	const source = '==结论==';
	const result = applyStyleToSourceSelection(source, 2, 4, 'bg-blue');
	assert.equal(result.source, '~={gv-bg-blue}结论=bg~');
	assert.equal(result.source.slice(result.selectionFrom, result.selectionTo), '结论');
});


test('desktop bold adds standard Markdown bold and keeps visible selection', () => {
	const result = toggleBoldInSourceSelection('重要结论', 0, '重要结论'.length);
	assert.equal(result.source, '**重要结论**');
	assert.equal(result.source.slice(result.selectionFrom, result.selectionTo), '重要结论');
});

test('desktop bold toggles off on immediate second click', () => {
	const first = toggleBoldInSourceSelection('重要结论', 0, '重要结论'.length);
	const second = toggleBoldInSourceSelection(first.source, first.selectionFrom, first.selectionTo);
	assert.equal(second.source, '重要结论');
	assert.equal(second.source.slice(second.selectionFrom, second.selectionTo), '重要结论');
});

test('desktop bold toggles independently inside text color', () => {
	const open = '~={gv-blue}';
	const source = `${open}重要结论=~`;
	const result = toggleBoldInSourceSelection(source, open.length, open.length + '重要结论'.length);
	assert.equal(result.source, '~={gv-blue}**重要结论**=~');
});

test('desktop bold toggles independently inside background color', () => {
	const open = '~={gv-bg-purple}';
	const source = `${open}重要结论=bg~`;
	const result = toggleBoldInSourceSelection(source, open.length, open.length + '重要结论'.length);
	assert.equal(result.source, '~={gv-bg-purple}**重要结论**=bg~');
});

test('desktop bold removal preserves enclosing text and background color layers', () => {
	const prefix = '~={gv-blue}~={gv-bg-purple}**';
	const source = `${prefix}结论**=bg~=~`;
	const from = prefix.length;
	const result = toggleBoldInSourceSelection(source, from, from + '结论'.length);
	assert.equal(result.source, '~={gv-blue}~={gv-bg-purple}结论=bg~=~');
});

test('desktop bold recognizes underscore strong syntax and toggles it off', () => {
	const source = '__结论__';
	const result = toggleBoldInSourceSelection(source, 2, 4);
	assert.equal(result.source, '结论');
});
