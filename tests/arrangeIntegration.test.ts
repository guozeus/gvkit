import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Production Store bundled against a small disk-backed Vault adapter. Every
// assertion below reads real temporary Markdown bytes; no production Vault is used.
const shim = `
export class TFile { constructor(path) { this.path=path; this.name=path.split('/').pop(); this.basename=this.name.slice(0,-3); this.extension='md'; } }
export class TFolder {}
export function getFrontMatterInfo(s) { const end=s.indexOf('\\n---',4); return s.startsWith('---\\n') && end>=0 ? {exists:true,frontmatter:s.slice(4,end),contentStart:end+5} : {exists:false,frontmatter:'',contentStart:0}; }
export const parseYaml = JSON.parse;
export const stringifyYaml = value => JSON.stringify(value, null, 2)+'\\n';
`;

test('disk Markdown create, sibling context, edit, reload, pin, complete/undo preserve children and other notes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'gvkit-arrange-test-'));
	try {
		// Export the same shim class identities as used by the bundled module.
		await build({ stdin: { contents: `export {ArrangeStore} from './src/arrangeStore'; export {TFile,TFolder} from 'obsidian';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: join(root, 'store.mjs'), plugins: [{ name: 'obsidian-test', setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
			b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: shim, loader: 'js' }));
		} }] });
		const { ArrangeStore, TFile, TFolder } = await import(pathToFileURL(join(root, 'store.mjs')).href);
		const entries = new Map<string, any>();
		for (const path of ['安排/待执行', '安排/已完成', 'settings/gvkit']) { entries.set(path, new TFolder()); await mkdir(join(root, path), { recursive: true }); }
		const vault = {
			getMarkdownFiles: () => [...entries.values()].filter(value => value instanceof TFile),
			getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
			read: (file: any) => readFile(join(root, file.path), 'utf8'),
			create: async (path: string, text: string) => { await writeFile(join(root, path), text, { flag: 'wx' }); const file = new TFile(path); entries.set(path, file); return file; },
			process: async (file: any, change: (source: string) => string) => { const text = change(await vault.read(file)); await writeFile(join(root, file.path), text); return text; },
		};
		const app = { vault, fileManager: { renameFile: async (file: any, path: string) => {
			await rename(join(root, file.path), join(root, path)); entries.delete(file.path); file.path = path; entries.set(path, file);
		} } };
		const untouched = '# 既有安排\n\n正文与链接 [[保留]]\n';
		await vault.create('安排/待执行/旧事项.md', untouched);
		await vault.create('安排/待执行/无关旧属性.md', '---\nlegacy: [\n---\n不由本功能接管');
		const store = new ArrangeStore(app);
		await store.load(); assert.equal(store.state.keyboardGap, 7, 'new installs use the accepted 7px gap');
		assert.equal(store.state.submitArrowSize, 24);
		assert.equal(store.state.submitColor, 'classic');
		assert.equal(store.state.detailShadow, 24);
		assert.equal(store.state.bodyPlaceholder, '记录正文、链接、思路…');
		const parent = await store.create('父事项', null);
		const child1 = await store.create('第一项', parent);
		const child2 = await store.create('第二项', parent);
		assert.equal(store.items.find((x: any) => x.id === child1).parent, parent);
		assert.equal(store.items.find((x: any) => x.id === child2).parent, parent);
		await store.edit(child1, '完整长标题'.repeat(50), '## 正文\n[[保留链接]]\n', parent);
		await store.togglePin(parent);
		const added = await store.create('独立', null);
		assert.equal(store.state.order[2], parent, 'only third pinned remains third');
		assert.equal(store.state.order[0], added);
		await store.setDate(parent, '2026-10-24');
		assert.equal(store.items.find((x: any) => x.id === child1).date, null);
		await store.complete(parent, true);
		assert.ok(store.items.find((x: any) => x.id === parent).path.startsWith('安排/已完成/'));
		assert.equal(store.items.find((x: any) => x.id === child1).completedAt, null);
		assert.ok(store.state.order.includes(child1));
		await store.complete(parent, false);
		const fresh = new ArrangeStore(app); await fresh.load();
		assert.deepEqual(fresh.state.order, store.state.order);
		assert.equal(fresh.items.find((x: any) => x.id === child1).body, '## 正文\n[[保留链接]]\n');
		assert.equal(await readFile(join(root, '安排/待执行/旧事项.md'), 'utf8'), untouched);
		await assert.rejects(store.edit(parent, '父', '', child1), /下级/);
		await store.configure({ fullscreenThreshold: 70, rowActions: ['pin'] });
		// An existing configuration without the new field remains compatible.
		const stateFile = entries.get('settings/gvkit/arrange.md');
		await vault.process(stateFile, source => source.replace('  "keyboardGap": 7,\n', '').replace('  "submitArrowSize": 24,\n', '').replace('  "submitColor": "classic",\n', ''));
		await fresh.load(); assert.equal(fresh.state.fullscreenThreshold, 70);
		assert.deepEqual(fresh.state.rowActions, ['pin']);
		assert.equal(fresh.state.keyboardGap, 7);
		assert.equal(fresh.state.submitArrowSize, 24, 'existing settings retain the accepted arrow size');
		assert.equal(fresh.state.submitColor, 'classic', 'existing settings retain the accepted blue');
		await vault.process(stateFile, source => source.replace('  "detailShadow": 24,\n', '').replace('  "bodyPlaceholder": "记录正文、链接、思路…",\n', ''));
		await fresh.load(); assert.equal(fresh.state.detailShadow, 24); assert.equal(fresh.state.bodyPlaceholder, '记录正文、链接、思路…');
		const itemBytes = await vault.read(entries.get(fresh.items.find((x: any) => x.id === child1).path));
		for (const radius of [0, 12, 16, 24, 40]) {
			await store.configure({ detailShadow: radius }); await fresh.load(); assert.equal(fresh.state.detailShadow, radius);
		}
		for (const hint of ['下一步与链接…', '']) {
			await Promise.all([store.configure({ bodyPlaceholder: hint }), store.configure({ detailShadow: 16 })]);
			await fresh.load(); assert.equal(fresh.state.bodyPlaceholder, hint); assert.equal(fresh.state.detailShadow, 16);
			assert.equal(await vault.read(entries.get(fresh.items.find((x: any) => x.id === child1).path)), itemBytes);
		}
		for (const gap of [0, 24, 40]) {
			await store.configure({ keyboardGap: gap });
			await fresh.load(); assert.equal(fresh.state.keyboardGap, gap, 'gap persists across Store reloads');
			assert.ok((await vault.read(stateFile)).includes(`"keyboardGap": ${gap}`));
			assert.equal(fresh.state.fullscreenThreshold, 70);
			assert.deepEqual(fresh.state.rowActions, ['pin']);
		}
		for (const size of [16, 17, 24, 32]) {
			await store.configure({ submitArrowSize: size });
			await fresh.load(); assert.equal(fresh.state.submitArrowSize, size);
			assert.ok((await vault.read(stateFile)).includes(`"submitArrowSize": ${size}`));
		}
		for (const color of ['classic', 'console', 'navy']) {
			await store.configure({ submitColor: color });
			await fresh.load(); assert.equal(fresh.state.submitColor, color);
			assert.equal(fresh.state.submitArrowSize, 32);
			assert.equal(fresh.state.keyboardGap, 40);
			assert.equal(fresh.state.fullscreenThreshold, 70);
			assert.deepEqual(fresh.state.rowActions, ['pin']);
		}
		await Promise.all([store.configure({ submitArrowSize: 20 }), store.configure({ submitColor: 'console' })]);
		await fresh.load(); assert.equal(fresh.state.submitArrowSize, 20); assert.equal(fresh.state.submitColor, 'console');
		await vault.process(stateFile, source => source.replace('"submitArrowSize": 20', '"submitArrowSize": 100').replace('"submitColor": "console"', '"submitColor": "unknown"'));
		await fresh.load(); assert.equal(fresh.state.submitArrowSize, 32); assert.equal(fresh.state.submitColor, 'classic');
		const first = store.state.order[0];
		const protectedId = store.state.order[2];
		await store.togglePin(protectedId);
		await store.complete(first, true);
		const protectedPosition = store.state.order.indexOf(protectedId);
		await store.complete(first, false);
		assert.equal(store.state.order.indexOf(protectedId), protectedPosition, 'immediate undo preserves the new protected slot');
		await fresh.load();
		assert.deepEqual(fresh.state.order, store.state.order, 'completion and undo order survive reopening');
	} finally { await rm(root, { recursive: true, force: true }); }
});
