import { App, TFile, TFolder } from 'obsidian';
import {
  freshGvid, indexPathForFolder, mergeIndexNavigation, navigationMarkdown,
  type NavFolder, type NavItem,
} from './indexNavigationCore';

function visible(entry: TFile | TFolder): boolean {
  if (entry.name.startsWith('.')) return false;
  if (entry.path === 'settings/gvkit' || entry.path.startsWith('settings/gvkit/')) return false;
  if (entry instanceof TFile) return entry.extension === 'md' && entry.name.toLowerCase() !== 'index.md';
  return true;
}

export function directorySnapshot(folder: TFolder): NavFolder {
  const depth = folder.path && folder.path !== '/' ? folder.path.split('/').length : 0;
  const items = (dir: TFolder, preview: boolean): NavItem[] =>
    dir.children.filter((entry): entry is TFile | TFolder => entry instanceof TFile || entry instanceof TFolder)
      .filter(visible).map(entry => entry instanceof TFolder ? {
        kind: 'folder' as const, name: entry.name, path: entry.path,
        ...(preview ? { children: items(entry, false) } : {}),
      } : { kind: 'file' as const, name: entry.name, path: entry.path });
  return { path: folder.path === '/' ? '' : folder.path, name: folder.name, children: items(folder, depth <= 1) };
}

export class IndexNavigationStore {
  private pending = new Map<string, Promise<{ file: TFile; source: string }>>();
  constructor(private app: App) {}

  getFolder(path: string): TFolder | null {
    if (!path || path === '/') return this.app.vault.getRoot();
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFolder ? file : null;
  }

  async open(path: string): Promise<{ file: TFile; source: string }> {
    const folder = this.getFolder(path);
    if (!folder) throw new Error('目录不存在：' + path);
    const key = folder.path;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.ensure(folder);
    this.pending.set(key, task);
    try { return await task; }
    finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }

  private async ensure(folder: TFolder): Promise<{ file: TFile; source: string }> {
    const indexPath = indexPathForFolder(folder.path);
    const markdown = navigationMarkdown(directorySnapshot(folder));
    const id = freshGvid();
    let abstract = this.app.vault.getAbstractFileByPath(indexPath);
    if (abstract === null) {
      try {
        const file = await this.app.vault.create(indexPath, mergeIndexNavigation('', markdown, id));
        return { file, source: await this.app.vault.read(file) };
      } catch (error) {
        // A simultaneous Obsidian Sync / other action may have just created it.
        abstract = this.app.vault.getAbstractFileByPath(indexPath);
        if (!(abstract instanceof TFile)) throw error;
      }
    }
    if (!(abstract instanceof TFile)) throw new Error('Index 路径不是 Markdown 文件：' + indexPath);
    const original = await this.app.vault.read(abstract);
    if (mergeIndexNavigation(original, markdown, id) !== original) {
      await this.app.vault.process(abstract, source => mergeIndexNavigation(source, markdown, id));
    }
    return { file: abstract, source: await this.app.vault.read(abstract) };
  }
}
