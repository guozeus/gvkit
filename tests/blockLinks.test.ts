import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlockSearchInsertion } from '../src/blockLinks.ts';

test('block link insertion opens native global block-search syntax', () => {
	assert.deepEqual(createBlockSearchInsertion('link'), {
		text: '[[^^]]',
		cursorOffset: 4,
	});
});

test('block embed insertion opens native global block-search syntax', () => {
	assert.deepEqual(createBlockSearchInsertion('embed'), {
		text: '![[^^]]',
		cursorOffset: 5,
	});
});
