import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const shim = [
  'export class TFolder {',
  ' constructor(path="",parent=null){ this.path=path; this.parent=parent; this.name=path.split("/").pop()||"/"; this.children=[]; }',
  '}',
  'export class TFile {',
  ' constructor(path,parent){this.path=path;this.parent=parent;this.name=path.split("/").pop();this.basename=this.name.slice(0,-3);this.extension="md";}',
  '}',
].join('\n');

test('real temporary Vault: missing / blank / human-written Index, lazy child, GVID, incremental & no repeat writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gvkit-index-vault-'));
  try {
    await build({
      stdin: {
        contents: "export {IndexNavigationStore} from './src/indexNavigationStore'; export * from './src/indexNavigationCore'; export {TFile,TFolder} from 'obsidian';",
        resolveDir: process.cwd(),
      },
      bundle: true, platform: 'node', format: 'esm', outfile: join(root, 'index.mjs'),
      plugins: [{ name: 'obsidian-test', setup(b) {
        b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
        b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: shim, loader: 'js' }));
      } }],
    });
    const { IndexNavigationStore, TFile, TFolder, splitIndexSource, stripFrontmatter } =
      await import(pathToFileURL(join(root, 'index.mjs')).href);
    const rootFolder = new TFolder();
    const entries = new Map<string, any>([['', rootFolder]]);
    let created = 0, processed = 0;
    const makeFolder = async (path: string) => {
      const parent = entries.get(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
      assert.ok(parent instanceof TFolder);
      const folder = new TFolder(path, parent);
      await mkdir(join(root, path), { recursive: true });
      entries.set(path, folder);
      parent.children.push(folder);
      return folder;
    };
    const vault = {
      getRoot: () => rootFolder,
      getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
      read: async (file: any) => readFile(join(root, file.path), 'utf8'),
      create: async (path: string, content: string) => {
        const parent = entries.get(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
        assert.ok(parent instanceof TFolder, path);
        await writeFile(join(root, path), content, { flag: 'wx' });
        const file = new TFile(path, parent);
        entries.set(path, file);
        parent.children.push(file);
        created++;
        return file;
      },
      process: async (file: any, transform: (text: string) => string) => {
        processed++;
        const old = await vault.read(file);
        const updated = transform(old);
        if (old !== updated) await writeFile(join(root, file.path), updated);
      },
    };
    const store = new IndexNavigationStore({ vault } as any);
    await makeFolder('目录A');
    await makeFolder('目录A/子目录B');
    await makeFolder('目录A/子目录B/深层未访问');
    await makeFolder('空白');
    await makeFolder('旧人工');
    await vault.create('index.md', '---\ngvid: root-fixed\n---\n');
    const oldBody = '---\ngvid: 01234567-89ab-7def-8abc-fedcba987654\ntag: [个人, 收藏]\n---\n# 我的人工简介\n\n重要入口：[[其他文档]]\n';
    await vault.create('旧人工/index.md', oldBody);
    await vault.create('旧人工/普通笔记.md', '# 原始文档\n不要改变');
    await vault.create('空白/index.md', '');
    await vault.create('目录A/测试文档.md', '# 测试文件');

    const beforeOther = await vault.read(entries.get('旧人工/普通笔记.md'));
    const home = await store.open('');
    assert.match(home.source, /gvid: root-fixed/);
    assert.match(home.source, /\[\[目录A\/index.md\|目录A\]\]/);
    assert.match(home.source, /\[\[目录A\/子目录B\/index.md\|子目录B\]\]/);
    assert.equal(entries.has('目录A/index.md'), false, 'home does not recursively create child Index');
    assert.equal(entries.has('目录A/子目录B/index.md'), false);

    const folderPage = await store.open('目录A');
    assert.match(folderPage.source, /\[\[目录A\/测试文档.md\|测试文档\]\]/);
    assert.match(folderPage.source, /\[\[目录A\/子目录B\/index.md\|子目录B\]\]/);
    assert.equal(entries.has('目录A/子目录B/index.md'), false, 'unvisited child remains absent');
    await store.open('目录A/子目录B');
    assert.equal(entries.has('目录A/子目录B/index.md'), true);
    assert.equal(entries.has('目录A/子目录B/深层未访问/index.md'), false);

    const blank = await store.open('空白');
    assert.match(blank.source, /gvid: [0-9a-f-]{36}/);
    assert.match(blank.source, /## 目录导航/);
    const human = await store.open('旧人工');
    assert.ok(human.source.startsWith(oldBody), 'original frontmatter / human content is exact prefix');
    const parts = splitIndexSource(human.source);
    assert.match(stripFrontmatter(parts.before), /我的人工简介/);
    assert.match(parts.auto, /普通笔记/);
    assert.equal(await vault.read(entries.get('旧人工/普通笔记.md')), beforeOther);

    const oldCreated = created, oldProcessed = processed;
    for (const folder of ['', '空白', '旧人工', '目录A', '目录A/子目录B']) await store.open(folder);
    assert.equal(created, oldCreated, 'repeat visits do not create files');
    assert.equal(processed, oldProcessed, 'repeat visits do not call Vault.process');

    // Native edit of the manual Index must survive a navigation refresh.
    await writeFile(join(root, '旧人工/index.md'), human.source.replace('# 我的人工简介', '# 更新后的人工介绍'));
    const updated = await store.open('旧人工');
    assert.match(updated.source, /# 更新后的人工介绍/);
    assert.match(updated.source, /gvid: 01234567-89ab-7def-8abc-fedcba987654/);
    await vault.create('旧人工/新增文档.md', '# 新内容');
    const sync = await store.open('旧人工');
    assert.match(sync.source, /新增文档/);
    assert.match(sync.source, /# 更新后的人工介绍/);
    assert.equal(await vault.read(entries.get('旧人工/普通笔记.md')), beforeOther);

    // A damaged marker must stop the write rather than overwriting manual content.
    const corrupt = sync.source.replace('<!-- GVKit:INDEX-NAV:END -->', '');
    await writeFile(join(root, '旧人工/index.md'), corrupt);
    const processedBeforeError = processed;
    await assert.rejects(store.open('旧人工'), /标记不完整/);
    assert.equal(processed, processedBeforeError);
    assert.equal(await vault.read(entries.get('旧人工/index.md')), corrupt);
  } finally { await rm(root, { recursive: true, force: true }); }
});
