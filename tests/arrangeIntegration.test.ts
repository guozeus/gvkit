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
export class TFile { constructor(path) { this.path=path; this.name=path.split('/').pop(); this.basename=this.name.slice(0,-3); this.extension='md'; this.stat={mtime:Date.now()}; } }
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
		for (const path of ['安排/待执行', '安排/已完成', '安排/历史', 'settings/gvkit']) { entries.set(path, new TFolder()); await mkdir(join(root, path), { recursive: true }); }
		const vault = {
			getMarkdownFiles: () => [...entries.values()].filter(value => value instanceof TFile),
			getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
			createFolder: async (path: string) => { await mkdir(join(root, path)); entries.set(path, new TFolder()); },
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
		assert.equal(store.state.dateHintColor, 'vivid', 'existing settings without a color use the new vivid default');
		const parent = await store.create('父事项', null);
		const child1 = await store.create('第一项', parent);
		const child2 = await store.create('第二项', parent);
		assert.equal(store.items.find((x: any) => x.id === child1).parent, parent);
		assert.equal(store.items.find((x: any) => x.id === child2).parent, parent);
		// Development acceptance is an independent Markdown boolean, never completion.
		const developmentFile = entries.get(`安排/待执行/${child1}.md`);
		const originalFields = JSON.parse((await vault.read(developmentFile)).split('---\n')[1]);
		const originalFacts = store.facts(), originalOrder = [...store.state.order];
		const originalState = await vault.read(entries.get('settings/gvkit/arrange.md'));
		// Project classification is independent of acceptance and changes no relations/order.
		for (const expected of [true, false, true, false]) {
			await store.toggleDevelopmentProject(child1);
			const reloaded = new ArrangeStore(app); await reloaded.load();
			assert.equal(reloaded.items.find((x: any) => x.id === child1).developmentProject, expected);
			const fields = JSON.parse((await vault.read(developmentFile)).split('---\n')[1]);
			assert.equal(fields.development_project, expected);
			delete fields.development_project;
			assert.deepEqual(fields, originalFields);
			assert.deepEqual(store.facts(), originalFacts);
			assert.deepEqual(store.state.order, originalOrder);
			assert.equal(await vault.read(entries.get('settings/gvkit/arrange.md')), originalState);
		}
		originalFields.development_project = false;
		assert.equal(store.items.find((x: any) => x.id === child1).developmentCompleted, false);
		for (const expected of [true, false, true, false]) {
			await store.toggleDevelopmentCompleted(child1);
			const fields = JSON.parse((await vault.read(developmentFile)).split('---\n')[1]);
			assert.equal(fields.development_completed, expected);
			delete fields.development_completed;
			assert.deepEqual(fields, originalFields, 'completion/date/parent/pin/title remain unchanged');
			assert.equal(developmentFile.path, `安排/待执行/${child1}.md`);
			assert.deepEqual(store.facts(), originalFacts);
			assert.deepEqual(store.state.order, originalOrder);
			assert.equal(await vault.read(entries.get('settings/gvkit/arrange.md')), originalState);
		}
		// External Vault writers use the very same field; reload must reflect it.
		await vault.process(developmentFile, source => source.replace('"development_completed": false', '"development_completed": true'));
		const external = new ArrangeStore(app); await external.load();
		assert.equal(external.items.find((x: any) => x.id === child1).developmentCompleted, true);
		await store.toggleDevelopmentCompleted(child1);
		assert.equal(store.items.find((x: any) => x.id === child1).developmentCompleted, false);
		await store.edit(child1, '完整长标题'.repeat(50), '## 正文\n[[保留链接]]\n', parent);
		await assert.rejects(store.setParent(parent, child1), /自己或自己的下级/);
		await assert.rejects(store.setParent(child1, child1), /自己或自己的下级/);
		await assert.rejects(store.setParent(child1, 'missing'), /自己或自己的下级/);
		await store.setParent(child1, child2);
		assert.equal(store.items.find((x: any) => x.id === child1).parent, child2);
		assert.equal(store.items.find((x: any) => x.id === child1).body, '## 正文\n[[保留链接]]\n');
		await store.setParent(child1, parent);
		const beforePin = [...store.state.order];
		await store.togglePin(parent);
		assert.deepEqual(store.state.order, beforePin, 'pin protects its current position');
		const parentSlot = beforePin.indexOf(parent);
		const added = await store.create('独立', null);
		assert.equal(store.state.order[parentSlot], parent, 'new item skips the protected slot');
		assert.equal(store.state.order[0], added);
		const beforeMorePins = [...store.state.order];
		await store.togglePin(child1); await store.togglePin(child2);
		assert.deepEqual(store.state.order, beforeMorePins, 'additional pins do not gather rows');
		const pinSlots = beforeMorePins.map((id: string, index: number) => [parent, child1, child2].includes(id) ? index : -1).filter((index: number) => index >= 0);
		await store.move(child2); await store.move(child1);
		assert.deepEqual(pinSlots.map((index: number) => store.state.order[index]), [child1, child2, parent]);
		assert.equal(store.state.order[0], added, 'explicit pinned top leaves ordinary slots alone');
		const pinReload = new ArrangeStore(app); await pinReload.load();
		assert.deepEqual(pinReload.state.order, store.state.order);
		const beforeUnpin = [...store.state.order];
		await store.togglePin(child1);
		assert.deepEqual(store.state.order, beforeUnpin);
		await store.togglePin(child2);
		assert.deepEqual(store.state.order, beforeUnpin);
		assert.equal(store.state.checkboxScale, 80); assert.equal(store.state.rowRightGap, 2);
		assert.equal(store.state.pinColor, 'gold');
		await store.configure({ checkboxScale: 65.5, rowRightGap: 3.5, pinColor: 'purple' });
		await pinReload.load();
		assert.equal(pinReload.state.checkboxScale, 65.5); assert.equal(pinReload.state.rowRightGap, 3.5);
		assert.equal(pinReload.state.pinColor, 'purple');
		await store.configure({ checkboxScale: 80, rowRightGap: 2, pinColor: 'gold' });
		await store.setDate(parent, '2026-10-24');
		assert.equal(store.items.find((x: any) => x.id === child1).date, null);
		const beforeBlocked = new Map(await Promise.all(vault.getMarkdownFiles().map(async (file: any) => [file.path, await vault.read(file)])));
		const blockedFacts = store.facts();
		await assert.rejects(store.complete(parent, true), /^Error: 需先完成所有下级事项$/);
		assert.deepEqual(new Map(await Promise.all(vault.getMarkdownFiles().map(async (file: any) => [file.path, await vault.read(file)]))), beforeBlocked, 'blocked completion writes no Markdown, moves no file, and preserves order/settings');
		assert.deepEqual(store.facts(), blockedFacts, 'blocked completion changes no statistics');
		await store.complete(child1, true); await store.complete(child2, true);
		await store.complete(parent, true);
		assert.ok(store.items.find((x: any) => x.id === parent).path.startsWith('安排/已完成/'));
		assert.ok(store.items.find((x: any) => x.id === child1).completedAt);
		await store.complete(parent, false);
		await store.complete(child1, false); await store.complete(child2, false);
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
		await vault.process(stateFile, source => {
			const fields = JSON.parse(source.slice(4, source.indexOf('\n---', 4)));
			delete fields.detailActions; delete fields.showCompletedChildren;
			return '---\n' + JSON.stringify(fields, null, 2) + source.slice(source.indexOf('\n---', 4));
		});
		await fresh.load();
		assert.deepEqual(fresh.state.rowActions, ['pin'], 'legacy list preferences are preserved');
		assert.deepEqual(fresh.state.detailActions, ['parent', 'date', 'top', 'pin', 'changeParent']);
		assert.equal(fresh.state.showCompletedChildren, true);
		await store.configure({ detailActions: [], showCompletedChildren: false });
		await fresh.load(); assert.deepEqual(fresh.state.detailActions, []); assert.equal(fresh.state.showCompletedChildren, false);
		assert.deepEqual(fresh.state.rowActions, ['pin']);
		assert.equal(fresh.state.keyboardGap, 7);
		assert.equal(fresh.state.submitArrowSize, 24, 'existing settings retain the accepted arrow size');
		assert.equal(fresh.state.submitColor, 'classic', 'existing settings retain the accepted blue');
		await vault.process(stateFile, source => source.replace('  "detailShadow": 24,\n', '').replace('  "bodyPlaceholder": "记录正文、链接、思路…",\n', ''));
		await fresh.load(); assert.equal(fresh.state.detailShadow, 24); assert.equal(fresh.state.bodyPlaceholder, '记录正文、链接、思路…');
		const itemBytes = await vault.read(entries.get(fresh.items.find((x: any) => x.id === child1).path));
		const freeSizes = { listFontSize: 17, rowHeight: 44, detailFontSize: 18, bodyFontSize: 16, parentFontSize: 13, dateFontSize: 12 };
		for (const value of [0, 0.5, 8, 72, 512]) {
			await store.configure(Object.fromEntries(Object.keys(freeSizes).map(key => [key, value])));
			await fresh.load();
			for (const key of Object.keys(freeSizes)) assert.equal(fresh.state[key], value, key + ' must not clamp or round');
			assert.equal(await vault.read(entries.get(fresh.items.find((x: any) => x.id === child1).path)), itemBytes);
			assert.deepEqual(fresh.state.rowActions, ['pin']);
		}
		await store.configure(Object.fromEntries(Object.keys(freeSizes).map(key => [key, -1])));
		await fresh.load();
		for (const [key, initial] of Object.entries(freeSizes)) assert.equal(fresh.state[key], initial, 'invalid negative size falls back to default');
		await store.configure(freeSizes);
		for (const color of ['vivid', 'electric', 'cyan']) {
			await store.configure({ dateHintColor: color }); await fresh.load();
			assert.equal(fresh.state.dateHintColor, color);
			assert.equal(fresh.state.submitColor, store.state.submitColor);
			assert.equal(fresh.state.selectionColor, store.state.selectionColor);
			assert.equal(await vault.read(entries.get(fresh.items.find((x: any) => x.id === child1).path)), itemBytes);
		}
		await vault.process(stateFile, source => source.replace('"dateHintColor": "cyan"', '"dateHintColor": "unknown"'));
		await fresh.load(); assert.equal(fresh.state.dateHintColor, 'vivid');
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
		// New settings retain existing independently configured quick actions across reopening.
		for (const swipeAction of ['archive', 'none', 'date']) {
			await store.configure({ swipeAction, pullDownClose: false, rowActions: ['pin', 'archive'], detailActions: ['date'] });
			await fresh.load(); assert.equal(fresh.state.swipeAction, swipeAction); assert.equal(fresh.state.pullDownClose, false);
			assert.deepEqual(fresh.state.rowActions, ['pin', 'archive']); assert.deepEqual(fresh.state.detailActions, ['date']);
		}
		await store.configure({ timezone: 'Pacific/Kiritimati' });
		const day = store.facts().day, month = `安排/历史/${day.slice(0, 4)}/${day.slice(5, 7)}`;
		const archivedParent = await store.create('待归档父事项', null);
		const activeChild = await store.create('保留子事项', archivedParent);
		await store.edit(archivedParent, '父原标题', '## 原正文\n[[原链接]]\n', null);
		await store.setDate(archivedParent, day);
		const before = store.facts();
		const parentFile = entries.get(store.items.find((x: any) => x.id === archivedParent).path);
		const original = await vault.read(parentFile);
		await store.archive(archivedParent);
		assert.equal(parentFile.path, `${month}/${parentFile.name}`);
		assert.equal(await vault.read(parentFile), original, 'archive moves the original bytes without new completion facts');
		assert.ok(!store.items.some((x: any) => x.id === archivedParent)); assert.ok(!store.state.order.includes(archivedParent));
		assert.equal(store.facts().x, before.x); assert.equal(store.facts().y, before.y - 1); assert.equal(store.facts().remaining, before.remaining - 1);
		await store.edit(activeChild, '归档父项后仍可编辑', '子正文', archivedParent);
		await store.setParent(activeChild, archivedParent); // unchanged original reference
		await store.move(activeChild); await store.togglePin(activeChild); await store.togglePin(activeChild);
		const grandchild = await store.create('新增下级', activeChild);
		await assert.rejects(store.complete(activeChild, true), /需先完成所有下级事项/);
		await store.complete(grandchild, true);
		await store.complete(activeChild, true); await store.complete(activeChild, false);
		await store.complete(grandchild, false);
		assert.equal(store.items.find((x: any) => x.id === grandchild).parent, activeChild);
		await store.setParent(activeChild, null); await store.setParent(activeChild, child1);
		const completed = await store.create('今天完成后归档', null);
		await store.setDate(completed, day); await store.complete(completed, true);
		const completedFile = entries.get(store.items.find((x: any) => x.id === completed).path);
		const completedBytes = await vault.read(completedFile), count = store.facts().x;
		// Real metadata indexing is asynchronous; an existing but stale cache is not completion truth.
		(app as any).metadataCache = { getFileCache: (file: any) => file === completedFile ? { frontmatter: { gvkit_arrange: true, completed_at: null } } : undefined };
		await store.archive(completed); await fresh.load();
		assert.equal(await vault.read(completedFile), completedBytes);
		assert.equal(fresh.facts().x, count, 'today completion survives archive and new Store');
		assert.ok(!fresh.items.some((x: any) => x.id === completed));
		const collision = await store.create('同名冲突', null);
		const collisionFile = entries.get(store.items.find((x: any) => x.id === collision).path);
		const conflictPath = `${month}/${collisionFile.name}`;
		await vault.create(conflictPath, '# 已有同名文件，不覆盖');
		await assert.rejects(store.archive(collision), /同名文件/);
		assert.ok(collisionFile.path.startsWith('安排/待执行/'));
		assert.equal(await vault.read(entries.get(conflictPath)), '# 已有同名文件，不覆盖');
		// Undo then archive must not let an old completed cache invent a completion either.
		const undone = await store.create('撤销后归档', null);
		await store.complete(undone, true);
		const undoneAt = store.items.find((x: any) => x.id === undone).completedAt;
		await store.complete(undone, false);
		const undoneFile = entries.get(store.items.find((x: any) => x.id === undone).path);
		(app as any).metadataCache = { getFileCache: (file: any) => file === undoneFile ? { frontmatter: { gvkit_arrange: true, completed_at: undoneAt } } : undefined };
		await store.archive(undone); await fresh.load(); assert.equal(fresh.facts().x, count);
		// Old history has no cache: not a single body read, including old files in this month.
		await mkdir(join(root, '安排/历史/1999/01'), { recursive: true });
		for (let i = 0; i < 80; i++) {
			const old = await vault.create(`安排/历史/1999/01/old-${i}.md`, 'not parsed'); old.stat.mtime = 915148800000;
		}
		const cache = new Map();
		for (const file of vault.getMarkdownFiles().filter((f: any) => f.path.startsWith(month))) {
			const source = await vault.read(file);
			cache.set(file.path, { frontmatter: source.startsWith('---') ? JSON.parse(source.slice(4, source.indexOf('\n---', 4))) : {} });
		}
		(app as any).metadataCache = { getFileCache: (file: any) => cache.get(file.path) };
		const stable = await vault.create(`${month}/stable.md`, '# old cached note');
		stable.stat.mtime = Date.now() - 86400000; cache.set(stable.path, { frontmatter: {} });
		const read = vault.read, reads: string[] = [];
		vault.read = file => { reads.push(file.path); return read(file); };
		await fresh.load();
		assert.equal(fresh.facts().x, count);
		assert.ok(reads.every(path => !path.startsWith('安排/历史/1999/') && path !== stable.path), 'old history bodies are not part of daily active load');
		assert.ok(reads.includes(completedFile.path), 'today-modified history reads real completion facts while its metadata can lag');
		assert.ok(fresh.items.every((x: any) => !x.path.startsWith('安排/历史/')));
	} finally { await rm(root, { recursive: true, force: true }); }
});
