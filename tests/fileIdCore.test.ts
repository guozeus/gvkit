import assert from 'node:assert/strict';
import test from 'node:test';
import {
	addMissingGvid,
	createGvid,
	hasOwnGvid,
	isTargetMarkdownPath,
	isUuidV7,
	requiresLargeBackfillConfirmation,
} from '../src/fileIdCore.ts';

test('generates valid unique UUID v7 gvid values', () => {
	const ids = Array.from({ length: 100 }, () => createGvid());
	assert.equal(new Set(ids).size, ids.length);
	for (const id of ids) assert.equal(isUuidV7(id), true);
});

test('adds only gvid and preserves existing frontmatter values', () => {
	const frontmatter: Record<string, unknown> = {
		title: '原有标题',
		tags: ['a', 'b'],
		nested: { keep: true },
	};
	const original = structuredClone(frontmatter);
	const fixedId = '01900000-0000-7000-8000-000000000000';

	assert.equal(addMissingGvid(frontmatter, () => fixedId), true);
	assert.deepEqual(frontmatter, { ...original, gvid: fixedId });
});

test('never overwrites an existing gvid, including malformed values reserved for later anomaly handling', () => {
	for (const existing of ['01900000-0000-7000-8000-000000000000', null, '']) {
		const frontmatter: Record<string, unknown> = { gvid: existing, title: 'keep' };
		assert.equal(addMissingGvid(frontmatter, () => 'replacement'), false);
		assert.deepEqual(frontmatter, { gvid: existing, title: 'keep' });
		assert.equal(hasOwnGvid(frontmatter), true);
	}
	assert.equal(hasOwnGvid({ id: 'legacy' }), false);
	assert.equal(hasOwnGvid(null), false);
});

test('targets ordinary Markdown files but excludes the real Obsidian template source directory', () => {
	assert.equal(isTargetMarkdownPath('日志/2026/09/2026-09-05.md'), true);
	assert.equal(isTargetMarkdownPath('项目/资料/角色卡模板.md'), true);
	assert.equal(isTargetMarkdownPath('settings/模板/基础日记模板.md'), false);
	assert.equal(isTargetMarkdownPath('settings/模板/子目录/其他模板.md'), false);
	assert.equal(isTargetMarkdownPath('assets/image.png'), false);
});

test('large backfill safety gate starts exactly at 10,000 missing files', () => {
	assert.equal(requiresLargeBackfillConfirmation(9_999), false);
	assert.equal(requiresLargeBackfillConfirmation(10_000), true);
	assert.equal(requiresLargeBackfillConfirmation(10_001), true);
});
