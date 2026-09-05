import { addIcon, Editor, MarkdownView, Notice, Platform, Plugin, removeIcon, type EditorPosition } from 'obsidian';
import {
	applyStyleToSourceSelection,
	type StyleAction,
} from './formatting';
import { gvkitEditorDecorations } from './editorDecorations';
import { renderGvkitStyles } from './readingView';

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

interface ToolbarAction {
	action: StyleAction;
	label: string;
	title: string;
	icon: string;
	className?: string;
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
	{
		action: 'text-blue',
		label: '蓝字',
		title: '蓝色文字',
		icon: 'gvkit-text-blue',
		className: 'gvkit-action-text-blue',
	},
	{
		action: 'text-purple',
		label: '紫字',
		title: '紫色文字',
		icon: 'gvkit-text-purple',
		className: 'gvkit-action-text-purple',
	},
	{
		action: 'bg-blue',
		label: '蓝底',
		title: '蓝色背景',
		icon: 'gvkit-bg-blue',
		className: 'gvkit-action-bg-blue',
	},
	{
		action: 'bg-purple',
		label: '紫底',
		title: '紫色背景',
		icon: 'gvkit-bg-purple',
		className: 'gvkit-action-bg-purple',
	},
	{
		action: 'clear',
		label: '清除',
		title: '清除 gvkit 标色',
		icon: 'eraser',
		className: 'gvkit-action-clear',
	},
];

export default class GvkitPlugin extends Plugin {
	private toolbarEl: HTMLDivElement | null = null;
	private refreshFrame: number | null = null;

	onload(): void {
		registerGvkitIcons();
		this.registerStyleCommands();
		this.registerEditorExtension(gvkitEditorDecorations);
		this.registerMarkdownPostProcessor((element) => renderGvkitStyles(element));

		// V0.1 uses a floating selection toolbar on desktop and Obsidian's native
		// mobile editor toolbar for the same registered formatting commands.
		if (!Platform.isMobileApp) {
			this.createFloatingToolbar();
			this.registerSelectionListeners();
		}
	}

	onunload(): void {
		if (this.refreshFrame !== null) {
			window.cancelAnimationFrame(this.refreshFrame);
			this.refreshFrame = null;
		}
		this.toolbarEl?.remove();
		this.toolbarEl = null;
		for (const iconId of CUSTOM_ICON_IDS) removeIcon(iconId);
	}

	private registerStyleCommands(): void {
		for (const item of TOOLBAR_ACTIONS) {
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

	private createFloatingToolbar(): void {
		const toolbar = document.createElement('div');
		toolbar.className = 'gvkit-format-toolbar';
		toolbar.setAttribute('role', 'toolbar');
		toolbar.setAttribute('aria-label', 'gvkit 标色工具条');
		toolbar.hidden = true;

		for (const item of TOOLBAR_ACTIONS) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = `gvkit-format-button ${item.className ?? ''}`.trim();
			button.textContent = item.label;
			button.title = item.title;
			button.setAttribute('aria-label', item.title);

			// Prevent the editor from losing its selection before the action runs.
			button.addEventListener('pointerdown', (event: PointerEvent) => {
				event.preventDefault();
				event.stopPropagation();

				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return;

				this.applyAction(view.editor, item.action);
				this.hideToolbar();
				view.editor.focus();
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
		this.registerDomEvent(window, 'scroll', () => this.hideToolbar(), true);
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

		const selection = window.getSelection();
		const anchorNode = selection?.anchorNode ?? null;
		if (
			!selection ||
			selection.isCollapsed ||
			selection.rangeCount === 0 ||
			!anchorNode ||
			!view.containerEl.contains(anchorNode)
		) {
			this.hideToolbar();
			return;
		}

		const range = selection.getRangeAt(0);
		const clientRects = range.getClientRects();
		const rect = clientRects.length > 0 ? clientRects[0] : range.getBoundingClientRect();
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			this.hideToolbar();
			return;
		}

		toolbar.hidden = false;
		toolbar.style.visibility = 'hidden';
		toolbar.style.left = '0px';
		toolbar.style.top = '0px';

		const toolbarWidth = toolbar.offsetWidth;
		const toolbarHeight = toolbar.offsetHeight;
		const margin = 8;
		const desiredLeft = rect.left + rect.width / 2 - toolbarWidth / 2;
		const left = Math.max(
			margin,
			Math.min(desiredLeft, window.innerWidth - toolbarWidth - margin),
		);
		const above = rect.top - toolbarHeight - margin;
		const top = above >= margin ? above : rect.bottom + margin;

		toolbar.style.left = `${Math.round(left)}px`;
		toolbar.style.top = `${Math.round(top)}px`;
		toolbar.style.visibility = 'visible';
	}

	private hideToolbar(): void {
		if (!this.toolbarEl) return;
		this.toolbarEl.hidden = true;
		this.toolbarEl.style.visibility = 'hidden';
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
		const change = computeMinimalChange(source, result.source);
		if (!change) return;

		editor.transaction({
			changes: [{
				from: editor.offsetToPos(change.from),
				to: editor.offsetToPos(change.to),
				text: change.text,
			}],
			selection: {
				from: offsetToPosition(result.source, result.selectionFrom),
				to: offsetToPosition(result.source, result.selectionTo),
			},
		});
	}
}
