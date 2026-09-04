import { Editor, MarkdownView, Notice, Platform, Plugin } from 'obsidian';
import {
	applyGuozhousiStyleMarkup,
	type StyleAction,
} from './formatting';

interface ToolbarAction {
	action: StyleAction;
	label: string;
	title: string;
	className?: string;
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
	{
		action: 'text-blue',
		label: '蓝字',
		title: '蓝色文字',
		className: 'gzt-action-text-blue',
	},
	{
		action: 'text-purple',
		label: '紫字',
		title: '紫色文字',
		className: 'gzt-action-text-purple',
	},
	{
		action: 'bg-blue',
		label: '蓝底',
		title: '蓝色背景',
		className: 'gzt-action-bg-blue',
	},
	{
		action: 'bg-purple',
		label: '紫底',
		title: '紫色背景',
		className: 'gzt-action-bg-purple',
	},
	{
		action: 'clear',
		label: '清除',
		title: '清除 Guozhousi 标色',
		className: 'gzt-action-clear',
	},
];

export default class GuozhousiToolsPlugin extends Plugin {
	private toolbarEl: HTMLDivElement | null = null;
	private refreshFrame: number | null = null;

	onload(): void {
		this.registerStyleCommands();

		// V0.1 only shows the floating toolbar on desktop. The commands remain
		// available on mobile so they can later be pinned to a mobile toolbar.
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
	}

	private registerStyleCommands(): void {
		for (const item of TOOLBAR_ACTIONS) {
			this.addCommand({
				id: `format-${item.action}`,
				name: `标色：${item.title}`,
				editorCallback: (editor) => {
					this.applyAction(editor, item.action);
				},
			});
		}
	}

	private createFloatingToolbar(): void {
		const toolbar = document.createElement('div');
		toolbar.className = 'gzt-format-toolbar';
		toolbar.setAttribute('role', 'toolbar');
		toolbar.setAttribute('aria-label', 'Guozhousi 标色工具条');
		toolbar.hidden = true;

		for (const item of TOOLBAR_ACTIONS) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = `gzt-format-button ${item.className ?? ''}`.trim();
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
		const selected = editor.getSelection();
		if (selected.length === 0) {
			new Notice('请先选中文字');
			return;
		}

		const replacement = applyGuozhousiStyleMarkup(selected, action);
		editor.replaceSelection(replacement);
	}
}
