import assert from 'node:assert/strict';
import test from 'node:test';

import {
	applyGvkitStyleMarkup,
	applyStyleToSourceSelection,
	removeGvkitStyleMarkup,
} from '../src/formatting.ts';

test('applies blue text with non-HTML gvkit syntax', () => {
	assert.equal(applyGvkitStyleMarkup('重要结论', 'text-blue'), '~={gv-blue}重要结论=~');
});

test('applies purple background with Obsidian colored-highlight syntax', () => {
	assert.equal(applyGvkitStyleMarkup('需要关注', 'bg-purple'), '==🟣需要关注==');
});

test('preserves bold inside text color as an independent formatting layer', () => {
	assert.equal(applyGvkitStyleMarkup('**重要结论**', 'text-blue'), '~={gv-blue}**重要结论**=~');
});

test('preserves bold inside background color as an independent formatting layer', () => {
	assert.equal(applyGvkitStyleMarkup('**重要结论**', 'bg-blue'), '==🔵**重要结论**==');
});

test('text color and background color compose without replacing each other', () => {
	const blueText = applyGvkitStyleMarkup('**结论**', 'text-blue');
	assert.equal(applyGvkitStyleMarkup(blueText, 'bg-purple'), '==🟣~={gv-blue}**结论**=~==');
});

test('styles multi-line selections line-by-line', () => {
	assert.equal(
		applyGvkitStyleMarkup('第一行\n第二行', 'bg-blue'),
		'==🔵第一行==\n==🔵第二行==',
	);
});

test('same text color toggles off when the full wrapper is selected', () => {
	assert.equal(applyGvkitStyleMarkup('~={gv-blue}结论=~', 'text-blue'), '结论');
});

test('same background color toggles off when the full wrapper is selected', () => {
	assert.equal(applyGvkitStyleMarkup('==🔵结论==', 'bg-blue'), '结论');
});

test('same style kind switches colors without nesting', () => {
	assert.equal(applyGvkitStyleMarkup('==🔵结论==', 'bg-purple'), '==🟣结论==');
});

test('converts a normal Obsidian highlight to a colored highlight without nesting', () => {
	assert.equal(applyGvkitStyleMarkup('==结论==', 'bg-blue'), '==🔵结论==');
});

test('clear removes gvkit color layers but preserves Markdown bold', () => {
	const source = '==🟣~={gv-blue}**结论**=~==';
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
	const open = '==🟣';
	const source = `${open}重要结论==`;
	const result = applyStyleToSourceSelection(source, open.length, open.length + '重要结论'.length, 'bg-purple');
	assert.equal(result.source, '重要结论');
	assert.equal(result.selectionFrom, 0);
	assert.equal(result.selectionTo, '重要结论'.length);
});

test('toggling text color off preserves nested background and bold', () => {
	const prefix = '**~={gv-blue}==🟣';
	const source = `${prefix}结论===~**`;
	const from = prefix.length;
	const result = applyStyleToSourceSelection(source, from, from + '结论'.length, 'text-blue');
	assert.equal(result.source, '**==🟣结论==**');
});

test('toggling background off preserves text color and bold', () => {
	const prefix = '**~={gv-blue}==🟣';
	const source = `${prefix}结论===~**`;
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
	assert.equal(result.source, '==🔵第一行==\n==🔵第二行==');
});

test('clear from visible selection removes both color layers and keeps bold', () => {
	const prefix = '**~={gv-blue}==🟣';
	const source = `${prefix}结论===~**`;
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
