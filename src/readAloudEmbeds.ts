import { resolveSubpath, type App, type CachedMetadata, type TFile } from 'obsidian';
import { parser } from '@lezer/markdown';

/** Only native block embeds; code examples and comments are not transclusions. */
export function blockEmbeds(source: string): Array<{ from: number; to: number; path: string; id: string }> {
	const excluded: Array<{ from: number; to: number }> = [];
	parser.parse(source).iterate({ enter(node) {
		if (['FencedCode', 'CodeBlock', 'InlineCode', 'Comment', 'CommentBlock'].includes(node.name)) {
			excluded.push({ from: node.from, to: node.to }); return false;
		}
		return undefined;
	} });
	const result = [];
	for (const match of source.matchAll(/!\[\[([^\]\n]*?)#\^([A-Za-z0-9-]+)(?:\|[^\]\n]*)?\]\]/g)) {
		const from = match.index!;
		if (!excluded.some(range => from >= range.from && from < range.to)) {
			result.push({ from, to: from + match[0].length, path: match[1]!, id: match[2]! });
		}
	}
	return result;
}

interface Snapshot { data: string; cache: CachedMetadata; mtime: number }

/** Preload just the referenced files, so the eventual iOS tap stays synchronous. */
export class ReadAloudEmbeds {
	private snapshots = new Map<TFile, Snapshot>();
	private loading = new Map<TFile, object>();
	private watched = new Set<TFile>();
	private dirty = new Set<TFile>();
	private failed = new Set<TFile>();
	private disposed = false;
	constructor(private app: Pick<App, 'metadataCache' | 'vault'>) {}

	prepare(source: string, sourcePath: string): void {
		for (const embed of blockEmbeds(source)) {
			const file = this.destination(embed.path, sourcePath);
			if (file) { this.watched.add(file); this.load(file); }
		}
	}

	/** Metadata changed supplies matching new text AND block positions. */
	changed(file: TFile, data: string, cache: CachedMetadata): void {
		if (!this.watched.has(file) || this.disposed) return;
		const metadata = this.metadata();
		if (metadata.getFileCache(file) !== cache || (metadata.getFileInfo && !this.indexed(file))) return;
		this.dirty.delete(file); this.failed.delete(file);
		this.loading.delete(file);
		this.snapshots.set(file, { data, cache, mtime: file.stat.mtime });
	}

	invalidate(file: TFile): void {
		if (!this.watched.has(file)) return;
		this.dirty.add(file); this.failed.delete(file);
		this.snapshots.delete(file); this.loading.delete(file);
	}

	resolve(source: string, sourcePath: string): { text: string; missing: number; preparing: boolean } {
		let text = '', cursor = 0, missing = 0, preparing = false;
		for (const embed of blockEmbeds(source)) {
			text += source.slice(cursor, embed.from);
			const file = this.destination(embed.path, sourcePath);
			const snapshot = file && this.snapshots.get(file);
			let body: string | null = null;
			if (file && (!snapshot || snapshot.mtime !== file.stat.mtime)) {
				this.watched.add(file); this.load(file); preparing ||= !this.failed.has(file);
			} else if (snapshot) {
				const resolved = resolveSubpath(snapshot.cache, '#^' + embed.id);
				if (resolved?.type === 'block') {
					let start = resolved.start.offset, end = resolved.end?.offset;
					// Native block embeds of list items include that item's descendants,
					// not the whole surrounding list (Obsidian's own extraction semantics).
					if (resolved.list) {
						const items = snapshot.cache.listItems ?? [];
						const parents = new Set([resolved.list.position.start.line]);
						start = resolved.list.position.start.offset - resolved.list.position.start.col;
						end = resolved.list.position.end.offset;
						for (let i = items.indexOf(resolved.list) + 1; i < items.length; i++) {
							const item = items[i]!;
							if (!parents.has(item.parent)) break;
							parents.add(item.position.start.line); end = item.position.end.offset;
						}
					}
					body = snapshot.data.slice(start, end).replace(/[ \t]*\^[A-Za-z0-9-]+[ \t]*(?=\r?$)/gm, '');
				}
			}
			if (body === null) { missing++; text += '\n（嵌入内容暂不可用。）\n'; }
			else text += '\n' + body + '\n';
			cursor = embed.to;
		}
		return { text: text + source.slice(cursor), missing, preparing };
	}

	destroy(): void {
		this.disposed = true; this.snapshots.clear(); this.loading.clear(); this.watched.clear(); this.dirty.clear(); this.failed.clear();
	}

	private destination(path: string, sourcePath: string): TFile | null {
		return this.app.metadataCache.getFirstLinkpathDest(path || sourcePath, sourcePath);
	}

	private metadata() {
		return this.app.metadataCache as App['metadataCache'] & {
			getFileInfo?(path: string): { mtime: number; size: number } | undefined;
		};
	}

	private indexed(file: TFile): boolean {
		const info = this.metadata().getFileInfo?.(file.path);
		return info?.mtime === file.stat.mtime && info?.size === file.stat.size;
	}

	private load(file: TFile): void {
		const saved = this.snapshots.get(file);
		if (this.disposed || this.dirty.has(file) || this.failed.has(file) || this.loading.has(file) || saved?.mtime === file.stat.mtime) return;
		const cache = this.app.metadataCache.getFileCache(file), mtime = file.stat.mtime;
		// Obsidian's getFileCache may still refer to a previous file version just
		// before indexing starts. Its native file-info mtime/size identify the
		// version that cache belongs to; otherwise wait for the paired changed event.
		if (!cache || !this.indexed(file)) return;
		const request = {}; this.loading.set(file, request);
		void this.app.vault.cachedRead(file).then(data => {
			if (this.disposed || this.loading.get(file) !== request) return;
			if (file.stat.mtime === mtime && this.indexed(file) && this.app.metadataCache.getFileCache(file) === cache) {
				this.snapshots.set(file, { data, cache, mtime });
			}
		}).catch(() => {
			if (this.loading.get(file) === request) this.failed.add(file);
		}).finally(() => {
			if (this.loading.get(file) === request) this.loading.delete(file);
		});
	}
}
