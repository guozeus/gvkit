import type { MarkdownView, Menu, TFile, WorkspaceLeaf } from 'obsidian';

export interface PublishDocumentContext {
	file: TFile;
	view: MarkdownView;
	leaf: WorkspaceLeaf;
	/** Check again after every asynchronous boundary before using this document. */
	isCurrent(): boolean;
}

export interface DocumentActionsHost {
	getMarkdownLeaves(): WorkspaceLeaf[];
	isMarkdownFile(file: unknown): file is TFile;
	createMenu(): Menu;
	notify(message: string): void;
	/** Supplied by the later workflow slice; never invoked for ineligible documents. */
	onZhouyouTarget?: (context: PublishDocumentContext) => void | Promise<void>;
	zhouyouStatusLabel?: (context: PublishDocumentContext) => string;
    onCollabTarget?: (context: PublishDocumentContext) => void | Promise<void>;
}

export interface ShortcutPreferences {
	getPublishShortcut(): boolean;
	setPublishShortcut(value: boolean): Promise<void>;
}

interface ViewEntry {
	leaf: WorkspaceLeaf;
	view: MarkdownView;
	file: TFile;
	button: HTMLElement | null;
	live: boolean;
}

const CURRENT_DOCUMENT_ACTIONS = [
	{ id: 'publish', title: '发布', icon: 'send' },
] as const;

/** Independent of the existing gvid assignment eligibility. Does not read content. */
export function isPublishableMarkdownPath(path: string): boolean {
	if (!path || path !== path.trim() || path.includes('\\') || path.startsWith('/')) return false;
	const parts = path.split('/');
	if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return false;
	if (!/\.md$/i.test(parts[parts.length - 1] ?? '')) return false;
	if (parts[0] === '日志' && parts.length > 1) return false;
	if (parts[0]?.toLowerCase() === 'settings' && parts.length > 2) {
		if (parts[1]?.toLowerCase() === 'gvkit' || parts[1] === '模板') return false;
	}
	return true;
}

function isMarkdownView(view: unknown): view is MarkdownView {
	if (!view || typeof view !== 'object') return false;
	const candidate = view as Partial<MarkdownView>;
	return typeof candidate.getViewType === 'function' &&
		candidate.getViewType() === 'markdown' && 'file' in candidate &&
		typeof candidate.addAction === 'function';
}

/** Only Obsidian document-view leaves are inspected; never enumerate Vault files. */
export class DocumentActions {
	private readonly entries = new Map<WorkspaceLeaf, ViewEntry>();
	private disposed = false;
	private readonly host: DocumentActionsHost;
	private readonly preferences: ShortcutPreferences;

	constructor(host: DocumentActionsHost, preferences: ShortcutPreferences) {
		this.host = host;
		this.preferences = preferences;
	}

	refresh(): void {
		if (this.disposed) return;
		const leaves = this.host.getMarkdownLeaves();
		const present = new Set(leaves);
		for (const [leaf, entry] of this.entries) {
			if (!present.has(leaf) || !isMarkdownView(leaf.view) ||
				leaf.view !== entry.view || leaf.view.file !== entry.file ||
				!this.host.isMarkdownFile(entry.file) || !isPublishableMarkdownPath(entry.file.path)) {
				this.discard(entry);
			}
		}

		for (const leaf of leaves) {
			const view = leaf.view;
			if (!isMarkdownView(view) || !this.host.isMarkdownFile(view.file) ||
				!isPublishableMarkdownPath(view.file.path)) continue;
			let entry = this.entries.get(leaf);
			if (!entry) {
				entry = { leaf, view, file: view.file, button: null, live: true };
				this.entries.set(leaf, entry);
			}
			if (this.preferences.getPublishShortcut() && !entry.button) {
				const bound = entry;
				entry.button = view.addAction(CURRENT_DOCUMENT_ACTIONS[0].icon, CURRENT_DOCUMENT_ACTIONS[0].title,
					(evt) => this.openTargetMenu(bound, evt));
			} else if (!this.preferences.getPublishShortcut() && entry.button) {
				entry.button.remove();
				entry.button = null;
			}
		}
	}

	onFileMenu(menu: Menu, file: unknown, source: string, leaf?: WorkspaceLeaf): void {
		if (this.disposed || source !== 'more-options' ||
			!this.host.isMarkdownFile(file) || !isPublishableMarkdownPath(file.path)) return;
		this.refresh();

		let entry: ViewEntry | undefined;
		if (leaf) {
			entry = this.entries.get(leaf);
			if (!entry || entry.file !== file) return;
		} else {
			// Official file-menu has optional leaf (including mobile). A unique live
			// view matching the supplied file is evidence; activeFile alone is not.
			const matches = Array.from(this.entries.values()).filter((candidate) =>
				candidate.file === file && this.isCurrent(candidate));
			if (matches.length !== 1) return;
			entry = matches[0];
		}
		if (!entry || !this.isCurrent(entry)) return;
		const bound = entry;
		menu.addItem((item) => item.setTitle('发布').setIcon('send')
			.onClick((evt) => this.openTargetMenu(bound, evt)));
		menu.addItem((item) => item.setTitle('GVKit功能项').setIcon('list-checks')
			.onClick((evt) => this.openFeatureMenu(bound, evt)));
	}

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.entries.values()) this.discard(entry);
		this.entries.clear();
	}

	private discard(entry: ViewEntry): void {
		entry.live = false;
		entry.button?.remove();
		entry.button = null;
		this.entries.delete(entry.leaf);
	}

	private isCurrent(entry: ViewEntry): boolean {
		return !this.disposed && entry.live && this.entries.get(entry.leaf) === entry &&
			this.host.getMarkdownLeaves().includes(entry.leaf) && entry.leaf.view === entry.view &&
			entry.view.file === entry.file && this.host.isMarkdownFile(entry.file) &&
			isPublishableMarkdownPath(entry.file.path);
	}

	private context(entry: ViewEntry): PublishDocumentContext {
		return { file: entry.file, view: entry.view, leaf: entry.leaf, isCurrent: () => this.isCurrent(entry) };
	}

	private openFeatureMenu(entry: ViewEntry, event: MouseEvent | KeyboardEvent): void {
		if (!this.isCurrent(entry)) return;
		const menu = this.host.createMenu();
		for (const action of CURRENT_DOCUMENT_ACTIONS) {
			menu.addItem((item) => item.setTitle(action.title).setIcon(action.icon)
				.setChecked(this.preferences.getPublishShortcut())
				.onClick(() => {
					if (!this.isCurrent(entry)) return;
					const next = !this.preferences.getPublishShortcut();
					void this.preferences.setPublishShortcut(next).then(() => {
						if (!this.disposed) this.refresh();
					}).catch(() => {
						if (this.disposed) return;
						this.refresh();
						this.host.notify('快捷图标设置未保存，请重试。');
					});
					// The preference changes in memory immediately; refresh the current view.
					this.refresh();
				}));
		}
		this.positionMenu(menu, entry, event);
	}

	private openTargetMenu(entry: ViewEntry, event: MouseEvent | KeyboardEvent): void {
		if (!this.isCurrent(entry)) return;
		const menu = this.host.createMenu();
		menu.addItem((item) => item.setTitle('发布到协作板').onClick(() => {
            if (!this.isCurrent(entry)) return;
            const handler = this.host.onCollabTarget;
            if (!handler) { this.host.notify('协作板发布功能尚未初始化'); return; }
            void Promise.resolve(handler(this.context(entry))).catch(() => {
                this.host.notify('协作板发布失败，请查看当前文档与凭据');
            });
        }));
		const status = this.host.zhouyouStatusLabel?.(this.context(entry)) ?? '';
		menu.addItem((item) => item.setTitle('发布到宙游文档中心' + (status ? ' · ' + status : '')).onClick(() => {
			if (!this.isCurrent(entry)) return;
			const handler = this.host.onZhouyouTarget;
			if (!handler) {
				this.host.notify('请先配置宙游文档中心。');
				return;
			}
			try {
				// Consumers must re-check context.isCurrent() after their own awaits.
				void Promise.resolve(handler(this.context(entry))).catch(() => {
					this.host.notify('宙游文档中心当前无法继续，请检查配置。');
				});
			} catch {
				this.host.notify('宙游文档中心当前无法继续，请检查配置。');
			}
		}));
		this.positionMenu(menu, entry, event);
	}

	private positionMenu(menu: Menu, entry: ViewEntry, event: MouseEvent | KeyboardEvent): void {
		const element = entry.view.containerEl;
		const doc = element.ownerDocument;
		const rect = element.getBoundingClientRect();
		const pointer = event as Partial<MouseEvent>;
		const viewWidth = doc.defaultView?.innerWidth ?? rect.right;
		const viewHeight = doc.defaultView?.innerHeight ?? rect.bottom;
		const x = typeof pointer.clientX === 'number' && Number.isFinite(pointer.clientX) ?
			pointer.clientX : rect.right - 36;
		const y = typeof pointer.clientY === 'number' && Number.isFinite(pointer.clientY) ?
			pointer.clientY : rect.top + 36;
		menu.showAtPosition({
			x: Math.max(8, Math.min(x, Math.max(8, viewWidth - 8))),
			y: Math.max(8, Math.min(y, Math.max(8, viewHeight - 8))),
		}, doc);
	}
}
