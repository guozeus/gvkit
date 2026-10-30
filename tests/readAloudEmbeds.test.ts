import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/readAloudEmbeds.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
	plugins: [{ name: 'native-block-api', setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
		b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export function resolveSubpath(cache, subpath) {
			const id = subpath.slice(2).toLowerCase(), block = cache.blocks?.[id];
			return block ? {type: 'block', block, start: block.position.start, end: block.position.end,
				list: cache.listItems?.find(item => item.id?.toLowerCase() === id) ?? null} : null;
		}` }));
	} }],
});
const { ReadAloudEmbeds, blockEmbeds } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles![0]!.contents).toString('base64'));
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
	const files = new Map<string, any>(), reads: string[] = [];
	const add = (path: string, body: string, id = 'abc123') => {
		const data = '# 日志\n\n' + body + ' ^' + id + '\n\n不要读的后文';
		const start = data.indexOf(body), end = data.indexOf('\n\n不要');
		const cache = { blocks: { [id.toLowerCase()]: { id, position: { start: { offset: start, line: 2, col: 0 }, end: { offset: end, line: 2, col: end - start } } } } };
		let file = files.get(path);
		if (file) { file.stat.mtime++; file.stat.size = data.length; file.data = data; file.cache = cache; }
		else { file = { path, extension: 'md', stat: { mtime: 1, size: data.length }, data, cache }; files.set(path, file); }
		file.info = { ...file.stat };
		return file;
	};
	const app = { metadataCache: {
		getFirstLinkpathDest: (path: string) => files.get(path) ?? files.get(path + '.md') ?? null,
		getFileCache: (file: any) => file.cache,
		getFileInfo: (path: string) => files.get(path)?.info,
	}, vault: { cachedRead: async (file: any) => { reads.push(file.path); return file.data; } } };
	return { add, reads, app, resolver: new ReadAloudEmbeds(app) };
}

test('24 mixed embeds preserve exact order and repetitions; only referenced files are read', async () => {
	const h = harness();
	for (let i = 0; i < 4; i++) h.add('day-' + i + '.md', '合成段落' + i + '。');
	h.add('unrelated.md', '无关内容');
	const source = Array.from({ length: 24 }, (_, i) => `手写${i}。\n![[day-${i % 4}#^abc123]]\n`).join('');
	h.resolver.prepare(source, 'current.md'); await settle();
	const result = h.resolver.resolve(source, 'current.md');
	assert.equal(result.text, Array.from({ length: 24 }, (_, i) => `手写${i}。\n\n合成段落${i % 4}。\n\n`).join(''));
	assert.equal(result.missing, 0); assert.equal(result.preparing, false);
	assert.equal(h.reads.length, 4); assert.ok(!h.reads.includes('unrelated.md'));
	assert.match(source, /!\[\[/, 'original source unchanged'); h.resolver.destroy();
});

test('new source text and matching native positions replace old snapshot; no stale result while indexing', async () => {
	const h = harness(), file = h.add('daily.md', '旧文。');
	const source = '前文\n![[daily#^abc123]]\n后文';
	h.resolver.prepare(source, 'current.md'); await settle();
	assert.match(h.resolver.resolve(source, 'current.md').text, /旧文/);
	h.resolver.invalidate(file); h.add('daily.md', '修改后更长的新正文。');
	assert.equal(h.resolver.resolve(source, 'current.md').preparing, true);
	h.resolver.changed(file, file.data, file.cache);
	const result = h.resolver.resolve(source, 'current.md');
	assert.equal(result.preparing, false); assert.match(result.text, /修改后更长的新正文/); assert.doesNotMatch(result.text, /旧文|abc123/);
	h.resolver.destroy();
});

test('cold load never substitutes a reference; missing file/block produce in-order spoken placeholders', async () => {
	const h = harness(); h.add('daily.md', '合成正文');
	const source = '甲![[daily#^abc123]]乙![[daily#^missing]]丙![[absent#^abc123]]丁';
	assert.equal(h.resolver.resolve(source, 'current.md').preparing, true); await settle();
	const result = h.resolver.resolve(source, 'current.md');
	assert.equal(result.preparing, false); assert.equal(result.missing, 2);
	assert.doesNotMatch(result.text, /daily|missing|absent|abc123/); assert.ok(result.text.indexOf('合成正文') < result.text.indexOf('乙'));
	h.resolver.destroy();
});

test('code examples are not transclusions and aliases/case are supported', async () => {
	assert.equal(blockEmbeds('`![[daily#^id]]`\n\n```md\n![[daily#^id]]\n```\n<!-- ![[daily#^id]] -->').length, 0);
	const h = harness(); h.add('daily.md', '只有正文。');
	const source = '![[daily#^ABC123|显示名]]'; h.resolver.prepare(source, 'current.md'); await settle();
	assert.equal(h.resolver.resolve(source, 'current.md').text.trim(), '只有正文。'); h.resolver.destroy();
});

test('native list block reads only the selected item and its descendants', () => {
	const h = harness(), file = h.add('daily.md', 'unused');
	const data = '- 前项\n- 目标 ^id\n  - 子项\n- 后项';
	const pos = (start: number, end: number, line: number, col = 0) => ({ start: { offset: start, line, col }, end: { offset: end, line, col: 0 } });
	const selected = { id: 'id', parent: -1, position: pos(5, 13, 1) };
	file.data = data; file.cache = { blocks: { id: { id: 'id', position: pos(0, data.length, 0) } }, listItems: [
		{ parent: -1, position: pos(0, 4, 0) }, selected,
		{ parent: 1, position: pos(16, 20, 2, 2) }, { parent: -1, position: pos(21, data.length, 3) },
	] };
	h.resolver.prepare('![[daily#^id]]', 'current.md'); h.resolver.changed(file, data, file.cache);
	const result = h.resolver.resolve('![[daily#^id]]', 'current.md');
	assert.match(result.text, /目标/); assert.match(result.text, /子项/); assert.doesNotMatch(result.text, /前项|后项|\^id/); h.resolver.destroy();
});

test('read failure gives missing-content feedback; unloading ignores late async reads', async () => {
	const h = harness(); h.add('daily.md', '正文');
	h.app.vault.cachedRead = async () => { throw Error('read failure'); };
	h.resolver.prepare('![[daily#^abc123]]', 'current.md'); await settle();
	const result = h.resolver.resolve('![[daily#^abc123]]', 'current.md');
	assert.equal(result.preparing, false); assert.equal(result.missing, 1); h.resolver.destroy();
});

test('first watch during reindex never pairs new data with old metadata positions', async () => {
	const h = harness(), file = h.add('daily.md', '旧目标');
	file.data = '前插新段落使偏移变化。\n\n' + file.data.replace('旧目标', '新目标');
	file.stat = { mtime: 2, size: file.data.length };
	h.resolver.prepare('![[daily#^abc123]]', 'current.md'); await settle();
	assert.equal(h.reads.length, 0, 'wait for actual native index version');
	assert.equal(h.resolver.resolve('![[daily#^abc123]]', 'current.md').preparing, true);
	const start = file.data.indexOf('新目标'), end = file.data.indexOf('\n\n不要');
	file.cache = { blocks: { abc123: { id: 'abc123', position: { start: { offset: start }, end: { offset: end } } } } };
	file.info = { ...file.stat }; h.resolver.changed(file, file.data, file.cache);
	assert.equal(h.resolver.resolve('![[daily#^abc123]]', 'current.md').text.trim(), '新目标');
	h.resolver.destroy();
});

test('late changed from an older index cannot label old text as the current source version', async () => {
	const h = harness(), file = h.add('daily.md', '旧正文');
	const oldData = file.data, oldCache = file.cache, oldInfo = file.info;
	h.resolver.prepare('![[daily#^abc123]]', 'current.md'); await settle(); h.resolver.invalidate(file);
	h.add('daily.md', '最新正文。'); const newCache = file.cache, newInfo = file.info;
	file.cache = oldCache; file.info = oldInfo;
	h.resolver.changed(file, oldData, oldCache);
	assert.equal(h.resolver.resolve('![[daily#^abc123]]', 'current.md').preparing, true);
	file.cache = newCache; file.info = newInfo; h.resolver.changed(file, file.data, newCache);
	assert.equal(h.resolver.resolve('![[daily#^abc123]]', 'current.md').text.trim(), '最新正文。'); h.resolver.destroy();
});
