import assert from 'node:assert/strict';
import test from 'node:test';

import {
	applyGuozhousiStyleMarkup,
	removeGuozhousiStyleMarkup,
} from '../src/formatting.ts';

test('applies blue text markup', () => {
	assert.equal(
		applyGuozhousiStyleMarkup('重要结论', 'text-blue'),
		'<span class="gzt-text-blue">重要结论</span>',
	);
});

test('applies purple background markup', () => {
	assert.equal(
		applyGuozhousiStyleMarkup('需要关注', 'bg-purple'),
		'<mark class="gzt-bg-purple">需要关注</mark>',
	);
});

test('styles multi-line selections line-by-line', () => {
	assert.equal(
		applyGuozhousiStyleMarkup('第一行\n第二行', 'bg-blue'),
		'<mark class="gzt-bg-blue">第一行</mark>\n<mark class="gzt-bg-blue">第二行</mark>',
	);
});

test('same style toggles off when the full wrapper is selected', () => {
	assert.equal(
		applyGuozhousiStyleMarkup('<span class="gzt-text-blue">结论</span>', 'text-blue'),
		'结论',
	);
});

test('same style kind switches colors without nesting', () => {
	assert.equal(
		applyGuozhousiStyleMarkup('<mark class="gzt-bg-blue">结论</mark>', 'bg-purple'),
		'<mark class="gzt-bg-purple">结论</mark>',
	);
});

test('clear removes nested Guozhousi wrappers but preserves unrelated HTML', () => {
	const source = '<em><span class="gzt-text-blue"><mark class="gzt-bg-purple">结论</mark></span></em>';
	assert.equal(removeGuozhousiStyleMarkup(source), '<em>结论</em>');
});
