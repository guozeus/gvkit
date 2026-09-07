import test from 'node:test';
import assert from 'node:assert/strict';
import {
	baselinePathForLog,
	currentPathForIdentity,
	parseSafeMovePlan,
	type SafeMovePlan,
} from '../src/safeMoveCore.ts';

const GVID_A = '01a070b1-2bf3-7277-8ff8-4474c260d344';
const GVID_B = '01a070b1-2c3b-730d-9830-ba01ae81fd8b';

function validPlan(): SafeMovePlan {
	return {
		version: 1,
		plan_id: 'notion-001',
		log_path: 'inbox/bak/导入信息已整理记录/Notion-20260828迁移/001.jsonl',
		moves: [
			{ gvid: GVID_A, from: 'inbox/A.md', to: 'knowledge/insights/A.md' },
			{ gvid: GVID_B, from: 'inbox/B.md', to: 'knowledge/toolkit/B.md' },
		],
	};
}

test('parses a minimal safe-move execution contract', () => {
	const plan = validPlan();
	assert.deepEqual(parseSafeMovePlan(JSON.stringify(plan)), plan);
});

test('rejects duplicate gvid, source path, and destination path before execution', () => {
	for (const mutate of [
		(plan: SafeMovePlan) => { plan.moves[1]!.gvid = plan.moves[0]!.gvid; },
		(plan: SafeMovePlan) => { plan.moves[1]!.from = plan.moves[0]!.from; },
		(plan: SafeMovePlan) => { plan.moves[1]!.to = plan.moves[0]!.to; },
	]) {
		const plan = validPlan();
		mutate(plan);
		assert.throws(() => parseSafeMovePlan(JSON.stringify(plan)));
	}
});

test('rejects unsafe paths and non-Markdown moves', () => {
	for (const [field, value] of [
		['from', '../A.md'],
		['to', '/knowledge/A.md'],
		['to', 'knowledge\\A.md'],
		['to', 'knowledge/A.txt'],
	] as const) {
		const plan = validPlan();
		(plan.moves[0] as unknown as Record<string, string>)[field] = value;
		assert.throws(() => parseSafeMovePlan(JSON.stringify(plan)));
	}
});

test('requires execution logs to stay in inbox/bak as JSONL', () => {
	for (const logPath of [
		'inbox/tmp/result.jsonl',
		'inbox/bak/result.json',
	]) {
		const plan = validPlan();
		plan.log_path = logPath;
		assert.throws(() => parseSafeMovePlan(JSON.stringify(plan)));
	}
});

test('derives the immutable link-baseline path beside the execution log', () => {
	assert.equal(
		baselinePathForLog('inbox/bak/records/batch.jsonl'),
		'inbox/bak/records/batch.links.json',
	);
});

test('maps moved GVID identities to their destination while leaving unrelated identities stable', () => {
	const plan = validPlan();
	assert.equal(
		currentPathForIdentity(
			{ kind: 'gvid', value: GVID_A, original_path: 'inbox/A.md' },
			plan,
		),
		'knowledge/insights/A.md',
	);
	assert.equal(
		currentPathForIdentity(
			{ kind: 'path', value: 'settings/模板/T.md', original_path: 'settings/模板/T.md' },
			plan,
		),
		'settings/模板/T.md',
	);
});
