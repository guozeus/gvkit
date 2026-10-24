import { addIcon, Editor, getFrontMatterInfo, MarkdownRenderChild, MarkdownView, Menu, Notice, parseYaml, Platform, Plugin, removeIcon, requestUrl, setIcon, TFile, type EditorPosition } from 'obsidian';
import {
	applyStyleToSourceSelection,
	toggleBoldInSourceSelection,
	type StyleAction,
} from './formatting';
import { gvkitEditorDecorations } from './editorDecorations';
import { resolveEditorSelectionRect, type CodeMirrorSelectionGeometry } from './toolbarSelection';
import { renderGvkitStyles } from './readingView';
import { FileIdManager } from './fileIds';
import { GvkitSettingTab } from './fileIdSettings';
import { SafeMoveManager } from './safeMove';
import { createBlockSearchInsertion, type BlockLinkKind } from './blockLinks';
import { DocumentActions, isPublishableMarkdownPath, type PublishDocumentContext } from './documentActions';
import { PublishSettings } from './publishSettings';
import { ZhouyouAutoPublisher } from './zhouyouAutoPublish';
import { PublishWorkflow, recordNativeRename, matchesNativeRename, resolveExistingRemoteByRead, type NativeRenameTrail } from './publishWorkflow';
import { readPublishBindings } from './publishBindings';
import { observeLegacyForCurrentNote } from './publishLegacy';
import { openZhouyouPublishDialog } from './publishDialog';
import { DeviceZhouyouSecret } from './publishSecretSettings';
import { ZhouyouClient, createZhouyouRequestUrlTransport, validateZhouyouEndpoint } from './zhouyouClient';
import { CollabBoardPublisher, confirmCollabPublish, validCollabPath } from './collabBoard';

const CUSTOM_ICON_IDS = [
	'gvkit-text-blue',
	'gvkit-text-purple',
	'gvkit-bg-blue',
	'gvkit-bg-purple',
] as const;

function registerGvkitIcons(): void {
	addIcon(
		'gvkit-text-blue',
		'<g transform="scale(4.1666667)"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 12 5l6 13"/><path d="M8.5 13h7"/></g><circle cx="18.5" cy="6" r="2.4" fill="var(--color-blue)" stroke="none"/></g>',
	);
	addIcon(
		'gvkit-text-purple',
		'<g transform="scale(4.1666667)"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 12 5l6 13"/><path d="M8.5 13h7"/></g><circle cx="18.5" cy="6" r="2.4" fill="var(--color-purple)" stroke="none"/></g>',
	);
	addIcon(
		'gvkit-bg-blue',
		'<g transform="scale(4.1666667)"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 5 10 10-4 4H9l-4-4L15 5"/><path d="M6 20h12"/></g><rect x="15.5" y="3" width="5" height="5" rx="1.2" fill="var(--color-blue)" stroke="none"/></g>',
	);
	addIcon(
		'gvkit-bg-purple',
		'<g transform="scale(4.1666667)"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 5 10 10-4 4H9l-4-4L15 5"/><path d="M6 20h12"/></g><rect x="15.5" y="3" width="5" height="5" rx="1.2" fill="var(--color-purple)" stroke="none"/></g>',
	);
}

function offsetToPosition(source: string, offset: number): EditorPosition {
	const before = source.slice(0, offset);
	const lines = before.split('\n');
	return { line: lines.length - 1, ch: lines[lines.length - 1]?.length ?? 0 };
}

function computeMinimalChange(oldSource: string, newSource: string): { from: number; to: number; text: string } | null {
	if (oldSource === newSource) return null;

	let from = 0;
	const sharedLength = Math.min(oldSource.length, newSource.length);
	while (from < sharedLength && oldSource[from] === newSource[from]) from += 1;

	let oldTo = oldSource.length;
	let newTo = newSource.length;
	while (oldTo > from && newTo > from && oldSource[oldTo - 1] === newSource[newTo - 1]) {
		oldTo -= 1;
		newTo -= 1;
	}

	return { from, to: oldTo, text: newSource.slice(from, newTo) };
}

interface ColorAction {
	action: StyleAction;
	label: string;
	title: string;
	icon: string;
	className?: string;
}

type DesktopToolbarAction = ColorAction | {
	action: 'bold';
	label: string;
	title: string;
	icon: string;
	className?: string;
} | {
	action: 'native';
	commandId: string;
	label: string;
	title: string;
	icon: string;
	className?: string;
};

const COLOR_ACTIONS: ColorAction[] = [
	{
		action: 'text-blue',
		label: '蓝字',
		title: '蓝色文字',
		icon: 'gvkit-text-blue',
	},
	{
		action: 'text-purple',
		label: '紫字',
		title: '紫色文字',
		icon: 'gvkit-text-purple',
	},
	{
		action: 'bg-blue',
		label: '蓝底',
		title: '蓝色背景',
		icon: 'gvkit-bg-blue',
	},
	{
		action: 'bg-purple',
		label: '紫底',
		title: '紫色背景',
		icon: 'gvkit-bg-purple',
	},
	{
		action: 'clear',
		label: '清除',
		title: '清除 gvkit 标色',
		icon: 'eraser',
	},
];

const DESKTOP_TOOLBAR_ACTIONS: DesktopToolbarAction[] = [
	{
		action: 'bold',
		label: '粗体',
		title: '粗体',
		icon: 'bold',
	},
	{ action: 'native', commandId: 'editor:toggle-italics', label: '斜体', title: '斜体', icon: 'italic' },
	{ action: 'native', commandId: 'editor:toggle-strikethrough', label: '删除线', title: '删除线', icon: 'strikethrough' },
	{ action: 'native', commandId: 'editor:toggle-code', label: '行内代码', title: '行内代码', icon: 'code' },
	{ action: 'native', commandId: 'editor:insert-wikilink', label: '内部链接', title: '添加内部链接', icon: 'link' },
	{ action: 'native', commandId: 'editor:insert-link', label: '普通链接', title: '添加 Markdown 链接', icon: 'external-link' },
	{ action: 'native', commandId: 'editor:toggle-bullet-list', label: '无序列表', title: '无序列表', icon: 'list' },
	{ action: 'native', commandId: 'editor:toggle-numbered-list', label: '有序列表', title: '有序列表', icon: 'list-ordered' },
	{ action: 'native', commandId: 'editor:toggle-checklist-status', label: '待办项', title: '待办清单 / 切换勾选', icon: 'check-square' },
	...COLOR_ACTIONS.slice(0, 4),
];

class GvkitReadingRenderChild extends MarkdownRenderChild {
	constructor(containerEl: HTMLElement, private observer: IntersectionObserver) {
		super(containerEl);
	}

	onload(): void {
		this.observer.observe(this.containerEl);
	}

	onunload(): void {
		this.observer.unobserve(this.containerEl);
	}
}

export default class GvkitPlugin extends Plugin {
	private toolbarEl: HTMLDivElement | null = null;
	private refreshFrame: number | null = null;
	private readingObserver: IntersectionObserver | null = null;
	private fileIds: FileIdManager | null = null;
	private safeMoves: SafeMoveManager | null = null;
	private documentActions: DocumentActions | null = null;
	private publishSettings: PublishSettings | null = null;
	private autoPublisher: ZhouyouAutoPublisher | null = null;
	private publishWorkflow: PublishWorkflow | null = null;
    private collabBoard: CollabBoardPublisher | null = null;
	private publishSecretRuntime: DeviceZhouyouSecret | null = null;
	private publishDialog: { close(): void } | null = null;
	private readonly recentFileRenames = new WeakMap<TFile, NativeRenameTrail>();
	private readonly publishFileChanges = new WeakMap<TFile, number>();
	private gvkitSettingsTab: GvkitSettingTab | null = null;
	private publishLifecycleActive = false;

	onload(): void {
		this.publishLifecycleActive = true;
		registerGvkitIcons();

		this.fileIds = new FileIdManager(this.app);
		this.registerEvent(this.app.vault.on('rename', (file, previousPath) => {
			if (file instanceof TFile) {
				this.publishFileChanges.set(file, (this.publishFileChanges.get(file) ?? 0) + 1);
				this.recentFileRenames.set(file,
					recordNativeRename(this.recentFileRenames.get(file), previousPath, file.path));
                void this.collabBoard?.onRename(file, previousPath).catch(() => new Notice('协作板文档已移入禁发目录，撤回未确认；请恢复网络以完成撤回。', 10000));
			}
		}));
		this.registerEvent(this.app.vault.on('modify', file => {
			if (file instanceof TFile) {
                this.publishFileChanges.set(file, (this.publishFileChanges.get(file) ?? 0) + 1);
                this.collabBoard?.onModify(file);
            }
		}));
		this.safeMoves = new SafeMoveManager(this.app);
		this.publishSettings = new PublishSettings({ loadData: () => this.loadData(), saveData: data => this.saveData(data) });
		this.gvkitSettingsTab = new GvkitSettingTab(this.app, this, this.fileIds, this.safeMoves, () => this.publishSettings);
		this.addSettingTab(this.gvkitSettingsTab);
		this.addCommand({
			id: 'execute-safe-batch-move',
			name: '执行安全批量移动',
			callback: async () => {
				const safeMoves = this.safeMoves;
				if (!safeMoves) return;
				try {
					const result = await safeMoves.executeCurrentPlan();
					new Notice(
						`安全批量移动完成：${result.moved}/${result.total} 个文件；修复 ${result.linksRepaired} 条内部链接。`,
						8000,
					);
				} catch (error) {
					console.error('gvkit: safe batch move command failed', error);
					new Notice(error instanceof Error ? error.message : 'AI 安全批量移动失败', 12000);
				}
			},
		});

		// Obsidian emits vault create events for existing files during initialization.
		// Register only after layoutReady so startup never turns into a Vault-wide ID pass.
		this.app.workspace.onLayoutReady(() => {
			const fileIds = this.fileIds;
			if (!fileIds) return;
			this.registerEvent(this.app.vault.on('create', (file) => {
				if (!(file instanceof TFile)) return;
				void fileIds.ensureGvid(file).catch((error) => {
					console.error(`gvkit: failed to add gvid to ${file.path}`, error);
				});
			}));
		});

		this.registerStyleCommands();
		this.registerBlockLinkCommands();
		this.registerEditorExtension(gvkitEditorDecorations);
		void this.initializeDocumentActions();

		// Register reading-view support during plugin load, but keep the callback
		// cheap: actual gvkit DOM conversion only happens after a rendered section
		// enters the viewport. This keeps visual enhancement out of startup work.
		this.readingObserver = new IntersectionObserver((entries, observer) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				observer.unobserve(entry.target);
				if (entry.target instanceof HTMLElement) {
					renderGvkitStyles(entry.target);
				}
			}
		});
		this.register(() => {
			this.readingObserver?.disconnect();
			this.readingObserver = null;
		});
		this.registerMarkdownPostProcessor((element, context) => {
			const observer = this.readingObserver;
			if (!observer) return;
			context.addChild(new GvkitReadingRenderChild(element, observer));
		});

		// V0.1 uses a floating selection toolbar on desktop and Obsidian's native
		// mobile editor toolbar for the same registered formatting commands.
		if (!Platform.isMobileApp) {
			this.createFloatingToolbar();
			this.registerSelectionListeners();
		}
	}

	/** Read ONLY the selected file and native metadata index on explicit target selection.
	 * No background Vault body scan and no access to legacy private settings or Key. */
	private publishSourceRevision(context: PublishDocumentContext): string {
		const file = context.file;
		return JSON.stringify([file.path, file.stat.mtime, file.stat.size,
			this.publishFileChanges.get(file) ?? 0]);
	}
	private async observePublishDocument(context: PublishDocumentContext, productId?: string) {
		const file = context.file;
		const path = file.path;
		if (!context.isCurrent() || !isPublishableMarkdownPath(path) || file.extension !== 'md') throw Error('invalid-publish-source');
		let sourceRevision = this.publishSourceRevision(context);
		let content = await this.app.vault.read(file);
		let info = getFrontMatterInfo(content);
		let frontmatter = info.exists ? parseYaml(info.frontmatter) : null;
		if (info.exists && (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)))
			throw Error('invalid-frontmatter');
		const missingGvid = !info.exists ||
			!Object.prototype.hasOwnProperty.call(frontmatter, 'gvid');
		if (missingGvid) {
			if (!this.fileIds?.isTargetFile(file)) throw Error('ineligible-gvid');
			await this.fileIds.ensureGvid(file); // explicit current file only; no ID replacement
			if (!context.isCurrent() || file.path !== path) throw Error('source-changed');
			sourceRevision = this.publishSourceRevision(context);
			content = await this.app.vault.read(file);
			info = getFrontMatterInfo(content);
			frontmatter = info.exists ? parseYaml(info.frontmatter) : null;
		}
		if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) throw Error('invalid-frontmatter');
		// An unsaved editor is not the same revision as the on-disk body to upload.
		if (context.view.editor.getValue() !== content) throw Error('source-unsaved');
		const fields = frontmatter as Record<string, unknown>;
		const gvid = fields.gvid;
		let identity: 'verified' | 'duplicate' | 'unknown' = 'verified';
		const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!cached || cached.gvid !== gvid) identity = 'unknown';
		for (const another of this.app.vault.getMarkdownFiles()) {
			const otherCache = this.app.metadataCache.getFileCache(another);
			if (!otherCache) continue;
			if (another !== file && otherCache.frontmatter?.gvid === gvid) { identity = 'duplicate'; break; }
		}
		const trail = this.recentFileRenames.get(file);
		const previousPaths = trail?.currentPath === path ? trail.earlierPaths : [];
		const rows = readPublishBindings(this.publishSettings?.getPublishBindingsSnapshot());
		const selected = rows.find(row => row.gvid === gvid && row.productId === productId);
		const pathProof = selected && matchesNativeRename(trail, path, selected.pathHint)
			? 'same-file-rename' as const : 'unverified' as const;
		const configDir = this.app.vault.configDir;
		const referencePath = configDir + '/plugins/zhouyou-producer-sync/data.json';
		const adapter = this.app.vault.adapter;
		const legacy = await observeLegacyForCurrentNote({ path, frontmatter: fields }, {
			configDir, verifiedRenamedFrom: previousPaths,
			existsConfigFile: exactPath => {
				if (exactPath !== referencePath) throw Error('unexpected-reference-path');
				return adapter.exists(exactPath);
			},
			readConfigFile: exactPath => {
				if (exactPath !== referencePath) throw Error('unexpected-reference-path');
				return adapter.read(exactPath);
			},
			nativePath: async candidatePath => {
				if (!context.isCurrent() || file.path !== path) return 'unknown';
				const found = this.app.vault.getAbstractFileByPath(candidatePath);
				return found === file ? 'current-file' : found === null ? 'absent' : 'other-file';
			},
		});
		if (!context.isCurrent() || file.path !== path ||
			this.publishSourceRevision(context) !== sourceRevision ||
			context.view.editor.getValue() !== content) throw Error('source-changed');
		return { note: { gvid, path, identity, pathProof },
			legacy, title: file.basename, content, sourceRevision };
	}

	private async initializeDocumentActions(): Promise<void> {
		try {
			const settings = this.publishSettings;
			if (!settings) return;
			await settings.load();
			if (this.publishLifecycleActive && this.gvkitSettingsTab?.containerEl.isConnected) this.gvkitSettingsTab.display();
			if (!this.publishLifecycleActive) return;
			// One device-only SecretStorage provider, shared by the dialog and client.
			// No runtime credential is inspected here; only the installed Obsidian app
			// invokes this callback after an explicit user operation.
			const device = new DeviceZhouyouSecret({
				secretStorage: this.app.secretStorage,
				loadLocalStorage: key => this.app.loadLocalStorage(key),
				saveLocalStorage: (key, value) => this.app.saveLocalStorage(key, value),
			}, () => settings.getZhouyouSecretReference());
			this.publishSecretRuntime = device;
			const autoPublisher = new ZhouyouAutoPublisher(this.app, settings, device);
			this.autoPublisher = autoPublisher;
			this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) void autoPublisher.renamed(file, oldPath);
			}));
			this.registerEvent(this.app.workspace.on('layout-change', () => autoPublisher.refreshMarkers()));
			this.registerEvent(this.app.workspace.on('file-open', () => autoPublisher.refreshMarkers()));
			this.registerEvent(this.app.metadataCache.on('changed', () => autoPublisher.refreshMarkers()));
			this.app.workspace.onLayoutReady(() => autoPublisher.refreshMarkers());
			const workflow = new PublishWorkflow(settings, {
				availability: () => {
					if (typeof requestUrl !== 'function') return 'unsupported';
					try { validateZhouyouEndpoint(settings.getZhouyouUrl()); }
					catch { return 'url-missing'; }
					const state = device.status();
					if (state === 'unsupported') return 'unsupported';
					if (state !== 'configured') return 'key-unconfigured';
					return 'ready'; // Product/status READ operations are available.
				},
				credentialIdentity: () => String(device.runtimeRevision()),
				observe: (context, productId) => this.observePublishDocument(context, productId),
				currentSourceRevision: context => this.publishSourceRevision(context),
				client: endpoint => new ZhouyouClient(endpoint,
					() => device.runtimeCredential(),
					createZhouyouRequestUrlTransport(requestUrl)),
				resolveRemote: (observation, productId) =>
					resolveExistingRemoteByRead(observation, productId,
						new ZhouyouClient(validateZhouyouEndpoint(settings.getZhouyouUrl()),
							() => device.runtimeCredential(),
							createZhouyouRequestUrlTransport(requestUrl))),
				// Company integration reply confirms UUIDv7, source uniqueness, CAS and idempotency.
				contracts: () => ({
					stableSourceVerified: true, atomicFirstCreateVerified: true,
					multiProductVerified: false,
				}),
				writePermitted: () => true,
			});
			this.publishWorkflow = workflow;
            const collab = new CollabBoardPublisher(this.app, settings, this.fileIds!);
            this.collabBoard = collab;
            void collab.resumeKnown();
			const actions = new DocumentActions({
				getMarkdownLeaves: () => this.app.workspace.getLeavesOfType('markdown'),
				isMarkdownFile: (file): file is TFile => file instanceof TFile && file.extension === 'md',
				createMenu: () => new Menu(),
				zhouyouStatusLabel: context => autoPublisher.statusLabel(context),
				notify: (message) => { new Notice(message); },
                onCollabTarget: async context => {
                    if (!this.publishLifecycleActive || !context.isCurrent() || !validCollabPath(context.file.path)) {
                        new Notice('当前文件不属于协作板可发布范围'); return;
                    }
                    if (!(await confirmCollabPublish(this.app, context.file.path)) || !context.isCurrent()) return;
                    try { new Notice(await collab.publish(context), 8000); }
                    catch (error) { new Notice(error instanceof Error ? error.message : '协作板发布结果未知', 10000); }
                },
				onZhouyouTarget: async context => {
					if (!this.publishLifecycleActive || !context.isCurrent()) return;
					await autoPublisher.publish(context);
				},
			}, settings);
			this.publishSettings = settings;
			this.documentActions = actions;
			this.registerEvent(this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
				actions.onFileMenu(menu, file, source, leaf);
			}));
			for (const name of ['layout-change', 'file-open', 'active-leaf-change', 'window-open', 'window-close'] as const) {
				// The following event names have distinct signatures, but need the same lifecycle refresh.
				if (name === 'layout-change') this.registerEvent(this.app.workspace.on(name, () => actions.refresh()));
				else if (name === 'file-open') this.registerEvent(this.app.workspace.on(name, () => actions.refresh()));
				else if (name === 'active-leaf-change') this.registerEvent(this.app.workspace.on(name, () => actions.refresh()));
				else if (name === 'window-open') this.registerEvent(this.app.workspace.on(name, () => actions.refresh()));
				else this.registerEvent(this.app.workspace.on('window-close', () => actions.refresh()));
			}
			this.app.workspace.onLayoutReady(() => {
				if (this.publishLifecycleActive && this.documentActions === actions) actions.refresh();
			});
		} catch {
			if (this.publishLifecycleActive) new Notice('GVKit 发布入口暂不可用，请重新加载插件。');
		}
	}

	onunload(): void {
		this.publishLifecycleActive = false;
		this.autoPublisher?.stop();
		this.autoPublisher = null;
		this.publishDialog?.close();
		this.publishDialog = null;
		this.publishWorkflow?.stop();
        this.collabBoard?.stop();
        this.collabBoard = null;
		this.publishWorkflow = null;
		this.publishSecretRuntime?.disposeRuntime();
		this.publishSecretRuntime = null;
		this.documentActions?.destroy();
		this.documentActions = null;
		this.gvkitSettingsTab?.dispose();
		this.gvkitSettingsTab = null;
		this.publishSettings = null;
		if (this.refreshFrame !== null) {
			window.cancelAnimationFrame(this.refreshFrame);
			this.refreshFrame = null;
		}
		this.toolbarEl?.remove();
		this.toolbarEl = null;
		this.fileIds = null;
		this.safeMoves = null;
		for (const iconId of CUSTOM_ICON_IDS) removeIcon(iconId);
	}

	private registerStyleCommands(): void {
		for (const item of COLOR_ACTIONS) {
			this.addCommand({
				id: `format-${item.action}`,
				name: `标色：${item.title}`,
				icon: item.icon,
				editorCallback: (editor) => {
					this.applyAction(editor, item.action);
				},
			});
		}
	}

	private registerBlockLinkCommands(): void {
		const commands: Array<{ id: string; name: string; icon: string; kind: BlockLinkKind }> = [
			{ id: 'insert-block-link', name: '块链接', icon: 'link', kind: 'link' },
			{ id: 'insert-block-embed', name: '块引用', icon: 'quote', kind: 'embed' },
		];

		for (const command of commands) {
			this.addCommand({
				id: command.id,
				name: command.name,
				icon: command.icon,
				editorCallback: (editor) => this.insertBlockSearch(editor, command.kind),
			});
		}
	}

	private insertBlockSearch(editor: Editor, kind: BlockLinkKind): void {
		const cursor = editor.getCursor();
		const insertion = createBlockSearchInsertion(kind);
		const target = { line: cursor.line, ch: cursor.ch + insertion.cursorOffset };

		editor.transaction({
			changes: [{ from: cursor, to: cursor, text: insertion.text }],
			selection: { from: target, to: target },
		});
		editor.focus();
	}

	private createFloatingToolbar(): void {
		const toolbar = document.createElement('div');
		toolbar.className = 'gvkit-format-toolbar';
		toolbar.setAttribute('role', 'toolbar');
		toolbar.setAttribute('aria-label', 'gvkit 格式工具条');
		toolbar.hidden = true;

		for (const item of DESKTOP_TOOLBAR_ACTIONS) {
			if (
				(item.action === 'native' && item.commandId === 'editor:toggle-bullet-list') ||
				item.action === 'text-blue'
			) {
				const divider = document.createElement('span');
				divider.className = 'gvkit-format-separator';
				divider.setAttribute('aria-hidden', 'true');
				toolbar.appendChild(divider);
			}
			const button = document.createElement('button');
			button.type = 'button';
			button.className = `gvkit-format-button ${item.className ?? ''}`.trim();
			setIcon(button, item.icon);
			button.title = item.title;
			button.setAttribute('aria-label', item.title);

			// Prevent the editor from losing its selection before the action runs.
			button.addEventListener('pointerdown', (event: PointerEvent) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();

				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.editor.getSelection().trim()) {
					this.hideToolbar();
					return;
				}

				this.applyToolbarAction(view.editor, item);
				view.editor.focus();
				this.scheduleToolbarRefresh();
			});

			toolbar.appendChild(button);
		}

		document.body.appendChild(toolbar);
		this.toolbarEl = toolbar;
	}

	private registerSelectionListeners(): void {
		this.registerDomEvent(document, 'selectionchange', () => {
			this.scheduleToolbarRefresh();
		});

		this.registerDomEvent(document, 'pointerup', () => {
			this.scheduleToolbarRefresh();
		});

		this.registerDomEvent(document, 'keyup', (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				this.hideToolbar();
				return;
			}
			this.scheduleToolbarRefresh();
		});

		this.registerDomEvent(window, 'resize', () => this.hideToolbar());
		this.registerDomEvent(window, 'scroll', (event: Event) => {
			// Narrow panes scroll the toolbar horizontally; that must not dismiss it.
			if (event.target instanceof Node && this.toolbarEl?.contains(event.target)) return;
			this.hideToolbar();
		}, true);
	}

	private scheduleToolbarRefresh(): void {
		if (this.refreshFrame !== null) {
			window.cancelAnimationFrame(this.refreshFrame);
		}

		this.refreshFrame = window.requestAnimationFrame(() => {
			this.refreshFrame = null;
			this.refreshToolbar();
		});
	}

	private refreshToolbar(): void {
		const toolbar = this.toolbarEl;
		if (!toolbar) return;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.editor.getSelection().trim().length === 0) {
			this.hideToolbar();
			return;
		}

		// CodeMirror is not part of Obsidian's public Editor interface, but its
		// live selection/coordinates are required for Live Preview task widgets.
		const cm = (view.editor as Editor & { cm?: CodeMirrorSelectionGeometry }).cm;
		const rect = resolveEditorSelectionRect(view.editor, view.containerEl, cm, window.getSelection());
		if (!rect) {
			this.hideToolbar();
			return;
		}

		const pane = view.containerEl.getBoundingClientRect();
		toolbar.style.maxWidth = `${Math.max(120, Math.min(window.innerWidth, pane.width) - 16)}px`;
		toolbar.hidden = false;
		toolbar.style.visibility = 'hidden';
		toolbar.style.left = '0px';
		toolbar.style.top = '0px';

		const toolbarWidth = toolbar.offsetWidth;
		const toolbarHeight = toolbar.offsetHeight;
		const margin = 8;
		const desiredLeft = rect.left + rect.width / 2 - toolbarWidth / 2;
		const minLeft = Math.max(margin, pane.left + margin);
		const maxLeft = Math.max(minLeft, Math.min(window.innerWidth, pane.right) - toolbarWidth - margin);
		const left = Math.max(minLeft, Math.min(desiredLeft, maxLeft));
		const above = rect.top - toolbarHeight - margin;
		const top = above >= margin ? above : Math.min(rect.bottom + margin, window.innerHeight - toolbarHeight - margin);

		toolbar.style.left = `${Math.round(left)}px`;
		toolbar.style.top = `${Math.round(top)}px`;
		toolbar.style.visibility = 'visible';
	}

	private hideToolbar(): void {
		if (!this.toolbarEl) return;
		this.toolbarEl.hidden = true;
		this.toolbarEl.style.visibility = 'hidden';
	}

	private applyToolbarAction(editor: Editor, item: DesktopToolbarAction): void {
		if (item.action === 'bold') {
			this.applyBold(editor);
		} else if (item.action === 'native') {
			// Reuse Obsidian's own Markdown/link/list semantics rather than
			// maintaining a second parser for these standard operations.
			const commands = (this.app as typeof this.app & {
				commands?: { executeCommandById(id: string): boolean };
			}).commands;
			if (!commands || commands.executeCommandById(item.commandId) === false) {
				new Notice(`${item.label}在当前 Obsidian 版本不可用`);
			}
		} else {
			this.applyAction(editor, item.action);
		}
	}

	private applyBold(editor: Editor): void {
		if (!editor.somethingSelected()) {
			new Notice('请先选中文字');
			return;
		}

		const source = editor.getValue();
		const selectionFrom = editor.posToOffset(editor.getCursor('from'));
		const selectionTo = editor.posToOffset(editor.getCursor('to'));
		const result = toggleBoldInSourceSelection(source, selectionFrom, selectionTo);
		this.applySourceResult(editor, source, result.source, result.selectionFrom, result.selectionTo);
	}

	private applySourceResult(
		editor: Editor,
		source: string,
		nextSource: string,
		selectionFrom: number,
		selectionTo: number,
	): void {
		const change = computeMinimalChange(source, nextSource);
		if (!change) return;

		editor.transaction({
			changes: [{
				from: editor.offsetToPos(change.from),
				to: editor.offsetToPos(change.to),
				text: change.text,
			}],
			selection: {
				from: offsetToPosition(nextSource, selectionFrom),
				to: offsetToPosition(nextSource, selectionTo),
			},
		});
	}

	private applyAction(editor: Editor, action: StyleAction): void {
		if (!editor.somethingSelected()) {
			new Notice('请先选中文字');
			return;
		}

		const source = editor.getValue();
		const selectionFrom = editor.posToOffset(editor.getCursor('from'));
		const selectionTo = editor.posToOffset(editor.getCursor('to'));
		const result = applyStyleToSourceSelection(source, selectionFrom, selectionTo, action);
		this.applySourceResult(editor, source, result.source, result.selectionFrom, result.selectionTo);
	}
}
