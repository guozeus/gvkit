import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const shim = [
  'export class TFolder { constructor(path="", parent=null) {this.path=path;this.parent=parent;this.name=path.split("/").pop()||"/";this.children=[];} }',
  'export class TFile { constructor(path,parent){this.path=path;this.parent=parent;this.name=path.split("/").pop();this.basename=this.name.slice(0,-3);this.extension="md";} }',
  'export class ItemView { constructor(leaf){ this.leaf=leaf;this.app=leaf.app;this.contentEl=document.createElement("div");this.children=[];} async setState(){} addChild(x){this.children.push(x);} removeChild(x){this.children=this.children.filter(y=>y!==x);} registerEvent(){} }',
  'export class MarkdownRenderChild {constructor(el){this.containerEl=el;}}',
  'export class MarkdownView {}',
  'export class Plugin {}',
  'export class Notice {constructor(message){this.message=message;}}',
  'export class MarkdownRenderer {static async render(app,src,el){el.innerHTML=src.replace(/\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]/g, (_m,p,label)=>"<a class=\\"internal-link\\" data-href=\\""+p+"\\" href=\\"#\\">"+(label||p)+"</a>").replace(/\\n/g,"<br>");}}',
].join('\n');

test('isolated disk Vault + simulated ItemView: folder click -> lazy Index -> native note -> return, then native edit refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gvkit-index-ui-'));
  const window = new Window({ url: 'http://localhost/' });
  const prior = { document: globalThis.document, HTMLAnchorElement: globalThis.HTMLAnchorElement };
  (globalThis as any).document = window.document;
  (globalThis as any).HTMLAnchorElement = window.HTMLAnchorElement;
  const proto = window.HTMLElement.prototype as any;
  proto.empty = function () { this.replaceChildren(); };
  proto.addClass = function (name: string) { this.classList.add(name); };
  proto.setText = function (text: string) { this.textContent = text; };
  proto.createEl = function (tag: string, options: any = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text) element.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value as string);
    this.appendChild(element);
    return element;
  };
  proto.createDiv = function (options: any = {}) { return this.createEl('div', options); };
  try {
    await build({
      stdin: { contents: "export {registerIndexNavigation, INDEX_NAV_VIEW} from './src/indexNavigationView'; export {TFolder, TFile} from 'obsidian';", resolveDir: process.cwd() },
      platform: 'node', format: 'esm', bundle: true, outfile: join(root, 'ui.mjs'),
      plugins: [{ name: 'obsidian-test', setup(b) {
        b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: shim, loader: 'js' }));
      } }],
    });
    const { registerIndexNavigation, INDEX_NAV_VIEW, TFolder, TFile } =
      await import(pathToFileURL(join(root, 'ui.mjs')).href);
    const entries = new Map<string, any>();
    const rootFolder = new TFolder();
    entries.set('', rootFolder);
    const folder = async (path: string) => {
      const parent = entries.get(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
      const next = new TFolder(path, parent);
      entries.set(path, next);
      parent.children.push(next);
      await mkdir(join(root, path), { recursive: true });
      return next;
    };
    const vaultCallbacks: Record<string, Array<(file: any) => void>> = {};
    const vault = {
      getRoot: () => rootFolder,
      getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
      on: (event: string, callback: (file: any) => void) => {
        (vaultCallbacks[event] ??= []).push(callback);
        return { off: () => {} };
      },
      read: (file: any) => readFile(join(root, file.path), 'utf8'),
      create: async (path: string, contents: string) => {
        const parent = entries.get(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
        await writeFile(join(root, path), contents, { flag: 'wx' });
        const file = new TFile(path, parent);
        entries.set(path, file);
        parent.children.push(file);
        return file;
      },
      process: async (file: any, fn: (src: string) => string) => {
        const current = await vault.read(file);
        const updated = fn(current);
        if (updated !== current) await writeFile(join(root, file.path), updated);
      },
    };
    await folder('栏目');
    await folder('栏目/项目');
    await vault.create('栏目/项目/说明.md', '# 原生文档');
    const commands = new Map<string, () => void>();
    const ribbons: Array<() => void> = [];
    const openedFiles: string[] = [];
    let creator: ((leaf: any) => any) | null = null;
    let view: any;
    const workspace = {
      getLeavesOfType: (kind: string) => kind === INDEX_NAV_VIEW && view ? [navLeaf] : [],
      getLeaf: () => view ? ({ openFile: async (f: any) => { openedFiles.push(f.path); } }) : navLeaf,
      revealLeaf: async () => {},
      getActiveViewOfType: () => null,
    };
    const app = {
      vault, workspace,
      metadataCache: { getFirstLinkpathDest: (path: string) => entries.get(path) instanceof TFile ? entries.get(path) : null },
    };
    const navLeaf: any = {
      app, setViewState: async (state: any) => {
        if (!view) {
          assert.equal(state.type, INDEX_NAV_VIEW);
          view = (creator as any)(navLeaf);
          await view.onOpen();
        }
        await view.setState(state.state, { history: true });
      },
    };
    const plugin = {
      app,
      registerView: (_type: string, make: (leaf: any) => any) => { creator = make; },
      addCommand: (command: any) => { commands.set(command.id, command.callback); },
      addRibbonIcon: (_icon: string, _name: string, callback: () => void) => { ribbons.push(callback); },
    };
    registerIndexNavigation(plugin as any);
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 80; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(check(), 'async interaction must complete');
    };
    commands.get('open-index-navigation')!();
    await until(() => Boolean(view?.contentEl.querySelector('[data-href="栏目/index.md"]')));
    assert.equal(entries.has('栏目/index.md'), false);
    view.contentEl.querySelector('[data-href="栏目/index.md"]')!.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => entries.has('栏目/index.md') && Boolean(view.contentEl.querySelector('[data-href="栏目/项目/index.md"]')));
    assert.ok(entries.has('栏目/index.md'));
    assert.equal(entries.has('栏目/项目/index.md'), false);
    view.contentEl.querySelector('[data-href="栏目/项目/index.md"]')!.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => entries.has('栏目/项目/index.md') && Boolean(view.contentEl.querySelector('[data-href="栏目/项目/说明.md"]')));
    assert.ok(entries.has('栏目/项目/index.md'));
    view.contentEl.querySelector('[data-href="栏目/项目/说明.md"]')!.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => openedFiles.length === 1);
    assert.deepEqual(openedFiles, ['栏目/项目/说明.md']);
    ribbons[0]!();
    await until(() => Boolean(view.contentEl.querySelector('[data-href="栏目/项目/说明.md"]')));
    assert.equal(view.getState().folderPath, '栏目/项目');
    assert.ok(view.contentEl.querySelector('.gvkit-index-auto'));

    const index = entries.get('栏目/项目/index.md');
    await writeFile(join(root, index.path), (await vault.read(index)) + '\n# 人工追加的说明\n');
    for (const callback of vaultCallbacks.modify ?? []) callback(index);
    await until(() => view.contentEl.textContent.includes('人工追加的说明'));
    assert.equal(await vault.read(entries.get('栏目/项目/说明.md')), '# 原生文档');
  } finally {
    (globalThis as any).document = prior.document;
    (globalThis as any).HTMLAnchorElement = prior.HTMLAnchorElement;
    await rm(root, { recursive: true, force: true });
    await window.happyDOM.abort();
  }
});
