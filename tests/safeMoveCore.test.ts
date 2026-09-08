import test from 'node:test';
import assert from 'node:assert/strict';
import {
	parseSafeMovePlan,
	validateSafeMovePreflight,
	type SafeMovePlan,
	type VaultPathKind,
} from '../src/safeMoveCore.ts';

function validPlan(): SafeMovePlan {
	return [
		{ from: 'inbox/A.md', to: 'Knowledge/insights/A.md' },
		{ from: 'inbox/B.md', to: 'Knowledge/toolkit/B.md' },
	];
}

function pathKinds(entries: Record<string, VaultPathKind>): (path: string) => VaultPathKind {
	return (path) => entries[path] ?? 'missing';
}

test('parses a minimal source-to-destination move list', () => {
	const plan = validPlan();
	assert.deepEqual(parseSafeMovePlan(JSON.stringify(plan)), plan);
});

test('rejects malformed, empty, duplicate, and same-path lists before execution', () => {
	assert.throws(() => parseSafeMovePlan('{}'));
	assert.throws(() => parseSafeMovePlan('[]'));

	for (const plan of [
		[
			{ from: 'inbox/A.md', to: 'Knowledge/A.md' },
			{ from: 'INBOX/a.md', to: 'Knowledge/B.md' },
		],
		[
			{ from: 'inbox/A.md', to: 'Knowledge/A.md' },
			{ from: 'inbox/B.md', to: 'knowledge/a.md' },
		],
		[{ from: 'inbox/A.md', to: 'INBOX/a.md' }],
	]) {
		assert.throws(() => parseSafeMovePlan(JSON.stringify(plan)));
	}
});

test('rejects unsafe vault paths and Obsidian control directories', () => {
	for (const [field, value] of [
		['from', '../A.md'],
		['to', '/Knowledge/A.md'],
		['to', 'Knowledge\\A.md'],
		['to', 'Knowledge//A.md'],
		['from', '.obsidian/plugins/a.md'],
		['to', '.trash/A.md'],
	] as const) {
		const plan = validPlan();
		(plan[0] as unknown as Record<string, string>)[field] = value;
		assert.throws(() => parseSafeMovePlan(JSON.stringify(plan)));
	}
});

test('preflight accepts existing source files with free targets and existing target folders', () => {
	const errors = validateSafeMovePreflight(
		validPlan(),
		pathKinds({
			'inbox/A.md': 'file',
			'inbox/B.md': 'file',
			'Knowledge/insights': 'folder',
			'Knowledge/toolkit': 'folder',
		}),
	);
	assert.deepEqual(errors, []);
});

test('preflight rejects missing sources, occupied targets, and missing target folders', () => {
	const plan: SafeMovePlan = [
		{ from: 'inbox/missing.md', to: 'Knowledge/insights/missing.md' },
		{ from: 'inbox/conflict.md', to: 'Knowledge/insights/conflict.md' },
		{ from: 'inbox/no-folder.md', to: 'Knowledge/unknown/no-folder.md' },
	];
	const errors = validateSafeMovePreflight(
		plan,
		pathKinds({
			'inbox/conflict.md': 'file',
			'inbox/no-folder.md': 'file',
			'Knowledge/insights/conflict.md': 'file',
		}),
	);
	assert.deepEqual(errors, [
		'源文件不存在：inbox/missing.md',
		'目标路径已存在：Knowledge/insights/conflict.md',
		'目标目录不存在：Knowledge/unknown',
	]);
});

test('preflight allows moves to the vault root without inventing a parent folder', () => {
	const errors = validateSafeMovePreflight(
		[{ from: 'inbox/A.md', to: 'A.md' }],
		pathKinds({ 'inbox/A.md': 'file' }),
	);
	assert.deepEqual(errors, []);
});
