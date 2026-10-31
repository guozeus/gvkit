import {
  ItemView, MarkdownRenderChild, MarkdownRenderer, MarkdownView, Notice, Plugin, TFile,
  type ViewStateResult, type WorkspaceLeaf,
} from 'obsidian';
import { IndexNavigationStore } from './indexNavigationStore';
import { indexPathForFolder, splitIndexSource, stripFrontmatter } from './indexNavigationCore';

export const INDEX_NAV_VIEW = 'gvkit-index-navigation';

export class IndexNavigationView extends ItemView {
  navigation = true;
  private folderPath = '';
  private currentIndexPath = '';
  private history: string[] = [];
  private renderedChild: MarkdownRenderChild | null = null;
  private requestNumber = 0;
  private body!: HTMLDivElement;
  private back!: HTMLButtonElement;
  private heading!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private store: IndexNavigationStore, private visited: (path: string) => void) {
    super(leaf);
  }
  getViewType(): string { return INDEX_NAV_VIEW; }
  getDisplayText(): string { return this.folderPath ? this.folderPath.split('/').pop() || '首页' : '信息库首页'; }
  getIcon(): string { return 'folder-tree'; }
  getState(): Record<string, unknown> { return { folderPath: this.folderPath }; }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const path = typeof state === 'object' && state !== null && 'folderPath' in state
      && typeof state.folderPath === 'string' ? state.folderPath : '';
    await this.navigate(path, false);
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('gvkit-index-view');
    const toolbar = this.contentEl.createDiv({ cls: 'gvkit-index-toolbar' });
    this.back = toolbar.createEl('button', { text: '← 返回', attr: { type: 'button' } });
    this.back.addEventListener('click', () => { void this.goBack(); });
    const home = toolbar.createEl('button', { text: '全库首页', attr: { type: 'button' } });
    home.addEventListener('click', () => { void this.navigate(''); });
    const edit = toolbar.createEl('button', { text: '编辑本页 Index', attr: { type: 'button' } });
    edit.addEventListener('click', () => { void this.openNativeIndex(); });
    this.heading = this.contentEl.createEl('h2', { cls: 'gvkit-index-heading' });
    this.body = this.contentEl.createDiv({ cls: 'gvkit-index-scroll' });
    this.body.addEventListener('click', event => { void this.handleLinkClick(event); });

    this.registerEvent(this.app.vault.on('modify', file => {
      if (file instanceof TFile && file.path === this.currentIndexPath) void this.refresh();
    }));
  }

  async onClose(): Promise<void> {
    this.requestNumber++;
    if (this.renderedChild) this.removeChild(this.renderedChild);
    this.renderedChild = null;
    this.currentIndexPath = '';
  }

  async navigate(folderPath: string, remember = true): Promise<void> {
    if (!this.store.getFolder(folderPath)) { new Notice('目录不存在：' + folderPath); return; }
    if (remember && this.folderPath !== folderPath) this.history.push(this.folderPath);
    this.folderPath = folderPath;
    await this.refresh();
  }

  private async goBack(): Promise<void> {
    const previous = this.history.pop();
    if (previous !== undefined) await this.navigate(previous, false);
  }

  private async refresh(): Promise<void> {
    if (!this.body) return;
    const request = ++this.requestNumber;
    this.heading.setText(this.folderPath ? this.folderPath.split('/').pop() || '首页' : '全库首页');
    this.back.disabled = this.history.length === 0;
    try {
      const { file, source } = await this.store.open(this.folderPath);
      if (this.requestNumber !== request) return;
      this.currentIndexPath = file.path;
      this.visited(this.folderPath);
      if (this.renderedChild) this.removeChild(this.renderedChild);
      this.body.empty();
      const child = new MarkdownRenderChild(this.body);
      this.addChild(child);
      this.renderedChild = child;
      const { before, auto, after } = splitIndexSource(source);
      if (stripFrontmatter(before).trim()) {
        await MarkdownRenderer.render(this.app, stripFrontmatter(before), this.body.createDiv({ cls: 'gvkit-index-manual' }), file.path, child);
      }
      if (auto) {
        await MarkdownRenderer.render(this.app, auto, this.body.createDiv({ cls: 'gvkit-index-auto' }), file.path, child);
      }
      if (after.trim()) {
        await MarkdownRenderer.render(this.app, after, this.body.createDiv({ cls: 'gvkit-index-manual' }), file.path, child);
      }
    } catch (error) {
      if (this.requestNumber !== request) return;
      this.body.empty();
      this.body.createEl('p', { text: error instanceof Error ? error.message : '目录页面打开失败，请重试' });
      new Notice('GVKit Index 导航未能打开；原文件未被清除');
    }
  }

  private async openNativeIndex(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(indexPathForFolder(this.folderPath));
    if (file instanceof TFile) await this.openNativeFile(file);
  }

  private async openNativeFile(file: TFile): Promise<void> {
    // Keep the website view in its own leaf; native Markdown opens in a new tab.
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file);
    await this.app.workspace.revealLeaf(leaf);
  }

  private async handleLinkClick(event: MouseEvent): Promise<void> {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('a.internal-link');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const raw = anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '';
    const linkPath = raw.split('#')[0];
    if (!linkPath) return;
    // Full Index paths name real folders even when the Index is absent.
    // Resolve folders before Obsidian's basename fallback to other index files.
    const folderPath = /(?:^|\/)index(?:\.md)?$/i.test(linkPath)
      ? linkPath.replace(/(?:^|\/)index(?:\.md)?$/i, '') : null;
    if (folderPath !== null && this.store.getFolder(folderPath)) {
      event.preventDefault();
      event.stopPropagation();
      await this.navigate(folderPath);
      return;
    }
    const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, this.currentIndexPath);
    if (file instanceof TFile) {
      event.preventDefault();
      event.stopPropagation();
      if (file.basename.toLowerCase() === 'index' && file.parent) {
        await this.navigate(file.parent.path);
      } else await this.openNativeFile(file);
    }
  }
}

export function registerIndexNavigation(plugin: Plugin): void {
  const store = new IndexNavigationStore(plugin.app);
  let lastFolder = '';
  plugin.registerView(INDEX_NAV_VIEW, leaf =>
    new IndexNavigationView(leaf, store, path => { lastFolder = path; }));
  const open = async (path: string) => {
    const leaf = plugin.app.workspace.getLeavesOfType(INDEX_NAV_VIEW)[0] ?? plugin.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: INDEX_NAV_VIEW, active: true, state: { folderPath: path } });
    await plugin.app.workspace.revealLeaf(leaf);
  };
  plugin.addRibbonIcon('folder-tree', 'GVKit：返回网站目录', () => { void open(lastFolder); });
  plugin.addCommand({ id: 'open-index-navigation', name: '打开全库网站式首页',
    callback: () => { void open(''); } });
  plugin.addCommand({ id: 'index-navigation-current-folder', name: '网站式浏览当前文档目录',
    callback: () => {
      const file = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      void open(file?.parent?.path ?? '');
    } });
  plugin.addCommand({ id: 'return-index-navigation', name: '返回最近网站目录',
    callback: () => { void open(lastFolder); } });
}
