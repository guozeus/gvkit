import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createGvid,
	hasOwnGvid,
	insertGvidPreservingSource,
	isTargetMarkdownPath,
	isUuidV7,
	requiresLargeBackfillConfirmation,
} from '../src/fileIdCore.ts';

const FIXED_ID = '01900000-0000-7000-8000-000000000000';

test('generates valid unique UUID v7 gvid values', () => {
	const ids = Array.from({ length: 100 }, () => createGvid());
	assert.equal(new Set(ids).size, ids.length);
	for (const id of ids) assert.equal(isUuidV7(id), true);
});

test('detects gvid by top-level field presence without treating malformed values as missing', () => {
	for (const existing of [FIXED_ID, null, '']) {
		assert.equal(hasOwnGvid({ gvid: existing, title: 'keep' }), true);
	}
	assert.equal(hasOwnGvid({ id: 'legacy' }), false);
	assert.equal(hasOwnGvid(null), false);
});

test('adds minimal frontmatter to a Markdown file that has none', () => {
	const source = '# 标题\n\n正文\n';
	assert.equal(
		insertGvidPreservingSource(source, FIXED_ID, false),
		`---\ngvid: ${FIXED_ID}\n---\n${source}`,
	);
});

test('inserts only one gvid line into existing frontmatter and preserves every existing byte', () => {
	const source = [
		'---',
		'# 这个注释必须保留',
		'title: "保留双引号"',
		'tags: [a, b]',
		'nested:',
		'    child: value',
		'---',
		'# 正文',
		'',
	].join('\n');
	const expected = source.replace('\n---\n# 正文', `\ngvid: ${FIXED_ID}\n---\n# 正文`);
	assert.equal(insertGvidPreservingSource(source, FIXED_ID, true), expected);
});

test('preserves CRLF line endings and UTF-8 BOM while inserting gvid', () => {
	const source = '\uFEFF---\r\ntitle: keep\r\n---\r\n正文\r\n';
	const expected = `\uFEFF---\r\ntitle: keep\r\ngvid: ${FIXED_ID}\r\n---\r\n正文\r\n`;
	assert.equal(insertGvidPreservingSource(source, FIXED_ID, true), expected);
});

test('does not mistake an indented YAML literal separator for the frontmatter closing line', () => {
	const source = '---\nnote: |\n  ---\n  keep\n---\nbody\n';
	const expected = `---\nnote: |\n  ---\n  keep\ngvid: ${FIXED_ID}\n---\nbody\n`;
	assert.equal(insertGvidPreservingSource(source, FIXED_ID, true), expected);
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
