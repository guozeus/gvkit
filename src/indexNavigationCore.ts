import { createGvid, insertGvidPreservingSource } from './fileIdCore';

export const INDEX_NAV_START = '<!-- GVKit:INDEX-NAV:START -->';
export const INDEX_NAV_END = '<!-- GVKit:INDEX-NAV:END -->';

export interface NavItem {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  children?: NavItem[];
}
export interface NavFolder {
  path: string;
  name: string;
  children: NavItem[];
}

export function indexPathForFolder(folderPath: string): string {
  return !folderPath || folderPath === '/' ? 'index.md' : folderPath.replace(/\/$/, '') + '/index.md';
}

export function displayFolderName(name: string): string {
  return ({ storage: '归档', knowledge: '知识', inbox: '收件箱', settings: '设置' } as Record<string, string>)[name] ?? name;
}

function labelFor(entry: NavItem): string {
  return entry.kind === 'folder' ? displayFolderName(entry.name) : entry.name.replace(/\.md$/i, '');
}

function wikiLink(item: NavItem): string {
  const link = item.kind === 'folder' ? indexPathForFolder(item.path) : item.path;
  // In Obsidian wikilinks, a pipe separates the display alias.
  return '[[' + link.replace(/\|/g, '\\|') + '|' + labelFor(item).replace(/\|/g, '\\|').replace(/\]/g, '\\]') + ']]';
}

function sortItems(items: NavItem[]): NavItem[] {
  return [...items].sort((a, b) => a.kind === b.kind
    ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    : a.kind === 'folder' ? -1 : 1);
}

export function navigationMarkdown(folder: NavFolder): string {
  const children = sortItems(folder.children);
  const directories = children.filter(child => child.kind === 'folder');
  const files = children.filter(child => child.kind === 'file');
  const depth = folder.path && folder.path !== '/' ? folder.path.split('/').length : 0;
  const lines = [INDEX_NAV_START, '## 目录导航'];
  if (!children.length) lines.push('', '此目录暂无子目录或 Markdown 文件。');
  if (directories.length) {
    lines.push('', '### 子目录');
    for (const dir of directories) {
      lines.push('- ' + wikiLink(dir));
      // Root shows second-level section links; first-level pages also show
      // their second-level sections' immediate projects / files.
      if (depth <= 1 && dir.children?.length) {
        const listed = sortItems(dir.children);
        const preview = depth === 0 ? listed.filter(x => x.kind === 'folder') : listed;
        for (const child of preview.slice(0, 40)) lines.push('  - ' + wikiLink(child));
        if (preview.length > 40) lines.push('  - 更多内容：' + wikiLink(dir));
      }
    }
  }
  if (files.length) lines.push('', '### 文档', ...files.map(file => '- ' + wikiLink(file)));
  return lines.concat(INDEX_NAV_END).join('\n');
}

function markersValid(source: string): { begin: number; finish: number } | null {
  const starts = source.split(INDEX_NAV_START).length - 1;
  const ends = source.split(INDEX_NAV_END).length - 1;
  if (starts === 0 && ends === 0) return null;
  if (starts !== 1 || ends !== 1) throw new Error('Index 自动导航标记不完整或重复：未修改原文');
  const begin = source.indexOf(INDEX_NAV_START), finish = source.indexOf(INDEX_NAV_END);
  if (finish < begin + INDEX_NAV_START.length) throw new Error('Index 自动导航标记顺序错误：未修改原文');
  return { begin, finish: finish + INDEX_NAV_END.length };
}

function withGvid(source: string, gvid: string): string {
  // Existing GVID and the whole existing YAML block are preserved byte-for-byte.
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (frontmatter && /(?:^|\r?\n)gvid[ \t]*:/m.test(frontmatter[1] ?? '')) return source;
  return insertGvidPreservingSource(source, gvid, Boolean(frontmatter));
}

export function mergeIndexNavigation(source: string, markdown: string, gvid: string): string {
  const marks = markersValid(source);
  if (marks) {
    const updated = source.slice(0, marks.begin) + markdown + source.slice(marks.finish);
    // Only a missing identity is added; existing frontmatter / manual body is untouched.
    return withGvid(updated, gvid);
  }
  const identified = withGvid(source, gvid);
  const separator = !identified ? '' : identified.endsWith('\n\n') ? '' : identified.endsWith('\n') ? '\n' : '\n\n';
  return identified + separator + markdown + '\n';
}

export function freshGvid(): string { return createGvid(); }

export function splitIndexSource(source: string): { before: string; auto: string; after: string } {
  const marks = markersValid(source);
  if (!marks) return { before: source, auto: '', after: '' };
  return {
    before: source.slice(0, marks.begin),
    auto: source.slice(marks.begin + INDEX_NAV_START.length, marks.finish - INDEX_NAV_END.length).trim(),
    after: source.slice(marks.finish),
  };
}

export function stripFrontmatter(source: string): string {
  return source.replace(/^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}
