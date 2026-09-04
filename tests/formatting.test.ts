import assert from 'node:assert/strict';
import test from 'node:test';

import {
	applyGvkitStyleMarkup,
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
