import assert from 'node:assert/strict';
import test from 'node:test';

import {
	applyGvkitStyleMarkup,
	removeGvkitStyleMarkup,
} from '../src/formatting.ts';

test('applies blue text markup', () => {
	assert.equal(
		applyGvkitStyleMarkup('重要结论', 'text-blue'),
		'<span class="gvkit-text-blue">重要结论</span>',
	);
});

test('applies purple background markup', () => {
	assert.equal(
		applyGvkitStyleMarkup('需要关注', 'bg-purple'),
		'<mark class="gvkit-bg-purple">需要关注</mark>',
	);
});

test('styles multi-line selections line-by-line', () => {
	assert.equal(
		applyGvkitStyleMarkup('第一行\n第二行', 'bg-blue'),
		'<mark class="gvkit-bg-blue">第一行</mark>\n<mark class="gvkit-bg-blue">第二行</mark>',
	);
});

test('same style toggles off when the full wrapper is selected', () => {
	assert.equal(
		applyGvkitStyleMarkup('<span class="gvkit-text-blue">结论</span>', 'text-blue'),
		'结论',
	);
});

test('same style kind switches colors without nesting', () => {
	assert.equal(
		applyGvkitStyleMarkup('<mark class="gvkit-bg-blue">结论</mark>', 'bg-purple'),
		'<mark class="gvkit-bg-purple">结论</mark>',
	);
});

test('clear removes nested Gvkit wrappers but preserves unrelated HTML', () => {
	const source = '<em><span class="gvkit-text-blue"><mark class="gvkit-bg-purple">结论</mark></span></em>';
	assert.equal(removeGvkitStyleMarkup(source), '<em>结论</em>');
});
