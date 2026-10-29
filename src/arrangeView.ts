import { ItemView, MarkdownRenderer, Menu, Modal, Notice, Platform, Plugin, setIcon, Setting, WorkspaceLeaf, type SliderComponent } from 'obsidian';
import { ARRANGE_ACTIONS, ARRANGE_FREE_SIZES, ARRANGE_NUMBER_SETTINGS, DATE_HINT_COLORS, PIN_COLORS, dateRange, dayKey, matchesDateRange, offsetDay, relativeDate, rowDateLabel, shiftPeriod, SUBMIT_BLUE_COLORS, todayFacts, validParent, type ArrangeItem, type ArrangeState, type DateGrain, type RowAction } from './arrangeCore';
import { ARRANGE_STATE_PATH, ArrangeStore } from './arrangeStore';
import { ArrangeFeedback } from './arrangeFeedback';
import { ArrangeBodyEditor } from './arrangeBodyEditor';

export const ARRANGE_VIEW = 'gvkit-arrange';
const actions: Record<RowAction, { title: string; icon: string }> = {
	parent: { title: '查看上级', icon: 'corner-left-up' }, date: { title: '设置日期', icon: 'calendar' },
	top: { title: '置顶', icon: 'arrow-up-to-line' }, pin: { title: '钉住位置', icon: 'pin' },
	changeParent: { title: '修改上级', icon: 'list-tree' }, copy: { title: '复制标题', icon: 'copy' },
	archive: { title: '归档', icon: 'archive' },
	developmentCompleted: { title: '已完成开发', icon: 'code-xml' },
	developmentProject: { title: '开发工程', icon: 'folder-code' },
};
function iconButton(parent: HTMLElement, label: string, icon: string, action: (event: MouseEvent) => void): HTMLButtonElement {
	const button = parent.createEl('button', { cls: 'gvkit-arrange-icon', attr: { type: 'button', 'aria-label': label, title: label } });
	setIcon(button, icon);
	button.addEventListener('click', event => { event.stopPropagation(); action(event); });
	return button;
}

/** WebKit/Chromium caret hit → original Markdown offset. No Markdown is rewritten.
 * Ordinary rendered text nodes match source spans; transformed embeds/entities
 * fall back to the nearest preceding source span rather than the end of the note. */
function bodyCaretOffset(preview: HTMLElement, source: string, event: MouseEvent): number {
	const doc = preview.ownerDocument as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
	const range = position ? null : doc.caretRangeFromPoint?.(event.clientX, event.clientY);
	const node = position?.offsetNode ?? range?.startContainer;
	const offset = position?.offset ?? range?.startOffset ?? 0;
	const target = node && preview.contains(node) ? node : event.target as Node;
	const walker = doc.createTreeWalker(preview, 4 /* SHOW_TEXT */);
	let cursor = 0;
	while (walker.nextNode()) {
		const text = walker.currentNode.textContent ?? '';
		const index = source.indexOf(text, cursor);
		if (walker.currentNode === target || target.contains?.(walker.currentNode)) {
			return index < 0 ? cursor : Math.min(source.length, index + (walker.currentNode === node ? offset : 0));
		}
		if (index >= 0) cursor = index + text.length;
	}
	return 0;
}

export function registerArrange(plugin: Plugin): void {
	const store = new ArrangeStore(plugin.app);
	plugin.registerView(ARRANGE_VIEW, leaf => new ArrangeView(leaf, store));
	const syncChrome = () => document.body.classList.toggle(
		'gvkit-arrange-active', Platform.isMobileApp && plugin.app.workspace.getActiveViewOfType(ArrangeView) !== null,
	);
	const open = async () => {
		const leaf = plugin.app.workspace.getLeavesOfType(ARRANGE_VIEW)[0] ?? plugin.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: ARRANGE_VIEW, active: true });
		await plugin.app.workspace.revealLeaf(leaf);
		if (Platform.isMobileApp) syncChrome();
	};
	plugin.addCommand({ id: 'open-arrange', name: '打开自御安排', callback: () => { void open(); } });
	plugin.addRibbonIcon('list-checks', '自御安排', () => { void open(); });
	plugin.registerObsidianProtocolHandler('gvkit-arrange', () => {
		plugin.app.workspace.onLayoutReady(() => { void open(); });
	});
	// Only hide Obsidian's mobile navigation when the Arrange view is active.
	if (Platform.isMobileApp) {
		plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', syncChrome));
		plugin.app.workspace.onLayoutReady(syncChrome);
		plugin.register(() => document.body.classList.remove('gvkit-arrange-active'));
	}
}

export class ArrangeView extends ItemView {
	private store: ArrangeStore;
	private feedback = new ArrangeFeedback();
	private selected: string | null = null;
	private filter: 'all' | 'today' | 'overdue' = 'all';
	private searchOpen = false;
	private hierarchyFilter: 'all' | 'roots' | 'leaves' = 'all';
	private hierarchyButton!: HTMLButtonElement;
	private searchScroll = 0;
	private searchBar!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private includeCompleted = false;
	private searchDate: { day: string; grain: DateGrain } | null = null;
	private completedButton!: HTMLButtonElement;
	private dateButton!: HTMLButtonElement;
	private dateBar!: HTMLElement;
	private searchButton!: HTMLButtonElement;
	private moreButton!: HTMLButtonElement;
	private parentBar!: HTMLElement;
	private parentError!: HTMLElement;
	private choosingParent: { id: string; scroll: number; detailScroll: number; searchOpen: boolean; query: string; searchScroll: number } | null = null;
	private scrolls = new Map<string, number>();
	private list!: HTMLElement;
	private detail!: HTMLElement;
	private detailScroll!: HTMLElement;
	private children!: HTMLElement;
	private area!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private createButton!: HTMLButtonElement;
	private keyboardBackdrop: HTMLElement | null = null;
	private headline!: HTMLButtonElement;
	private full = false;
	private busy = false;
	private closed = false;
	private editing: { id: string; title: HTMLTextAreaElement; body: ArrangeBodyEditor; preview: HTMLElement; error: HTMLElement; savedTitle: string; savedBody: string; composing: boolean } | null = null;
	private editTimer: number | null = null;
	private savingEdit: Promise<boolean> | null = null;
	private timer: number | null = null;
	private today = '';
	private restoreHeader: (() => void) | null = null;
	private cancelReorder: (() => void) | null = null;
	private titleFocusScroll: { input: HTMLTextAreaElement; top: number } | null = null;
	private bodyRender = 0;

	constructor(leaf: WorkspaceLeaf, store: ArrangeStore) { super(leaf); this.store = store; }
	getViewType(): string { return ARRANGE_VIEW; }
	getDisplayText(): string { return '自御安排'; }
	getIcon(): string { return 'list-checks'; }

	async onOpen(): Promise<void> {
		this.closed = false;
		const root = this.contentEl;
		root.empty();
		root.addClass('gvkit-arrange');
		// Obsidian's mobile swipe recognizer explicitly honors this ancestor flag.
		root.dataset.ignoreSwipe = 'true';
		this.register(() => { delete root.dataset.ignoreSwipe; });
		root.toggleClass('gvkit-arrange-mobile', Platform.isMobileApp);
		if (Platform.isIosApp) this.guardSmallEditorZoom(root);
		const header = root.createDiv('gvkit-arrange-header');
		header.dataset.ignoreSwipe = 'true';
		this.headline = header.createEl('button', { cls: 'gvkit-arrange-today' });
		this.headline.onclick = () => this.setFilter(this.filter === 'today' ? 'all' : 'today');
		this.hierarchyButton = iconButton(header, '事项筛选：全部', 'list-filter', event => {
			const menu = new Menu();
			for (const [value, label] of [['all', '全部'], ['roots', '无上级'], ['leaves', '无下级']] as const) {
				menu.addItem(entry => entry.setTitle(`${this.hierarchyFilter === value ? '✓ ' : ''}${label}`).onClick(() => {
					this.hierarchyFilter = value; this.paintLists(); this.list.scrollTop = 0;
				}));
			}
			menu.showAtMouseEvent(event);
		});
		this.searchButton = iconButton(header, '搜索事项', 'search', () => this.toggleSearch());
		this.moreButton = iconButton(header, '安排更多', 'more-horizontal', event => this.headerMenu(event));
		// Use only this leaf's title slot. Unknown/hidden host layouts keep the thin local bar.
		const titleSlot = this.containerEl?.querySelector<HTMLElement>('.view-header-title-container');
		const hostHeader = titleSlot?.closest<HTMLElement>('.view-header');
		if (titleSlot && hostHeader) {
			const syncHeader = () => {
				const active = !this.closed && this.app.workspace.getActiveViewOfType(ArrangeView) === this;
				const visible = hostHeader.getBoundingClientRect().height > 0;
				titleSlot.classList.toggle('gvkit-arrange-host-title', active && visible);
				if (active && visible) titleSlot.append(header);
				else root.prepend(header);
			};
			this.restoreHeader = () => { titleSlot.classList.remove('gvkit-arrange-host-title'); root.prepend(header); };
			this.registerEvent(this.app.workspace.on('active-leaf-change', syncHeader));
			this.registerEvent(this.app.workspace.on('layout-change', syncHeader));
			this.register(() => this.restoreHeader?.());
			syncHeader();
		}
		this.parentBar = root.createDiv('gvkit-arrange-parent-picker');
		this.parentBar.hidden = true;
		this.parentBar.createSpan({ text: '选择上一级事项' });
		this.parentBar.createEl('button', { text: '无上级' }).onclick = () => { void this.chooseParent(null); };
		this.parentBar.createEl('button', { text: '取消' }).onclick = () => this.finishParentChoice();
		this.parentError = this.parentBar.createDiv({ cls: 'gvkit-arrange-edit-error', attr: { role: 'status' } });
		this.parentError.hidden = true;
		this.searchBar = root.createDiv('gvkit-arrange-search');
		this.searchBar.hidden = true;
		this.searchInput = this.searchBar.createEl('input', { type: 'search', attr: { placeholder: '搜索事项标题', 'aria-label': '搜索事项标题' } });
		this.searchInput.oninput = () => { this.paintLists(); this.list.scrollTop = 0; };
		this.completedButton = iconButton(this.searchBar, '包含已完成', 'list-checks', () => {
			this.includeCompleted = !this.includeCompleted; this.syncSearch(); this.paintLists(); this.list.scrollTop = 0;
		});
		this.dateButton = iconButton(this.searchBar, '时间范围', 'calendar-range', () => {
			this.searchDate = this.searchDate ? null : { day: dayKey(new Date(), this.store.state.timezone), grain: 'day' };
			this.syncSearch(); this.paintLists(); this.list.scrollTop = 0;
		});
		iconButton(this.searchBar, '关闭搜索', 'x', () => this.toggleSearch());
		this.dateBar = root.createDiv('gvkit-arrange-date-filter'); this.dateBar.hidden = true;
		this.area = root.createDiv('gvkit-arrange-area');
		this.list = this.area.createDiv('gvkit-arrange-list');
		this.list.setAttribute('aria-label', '事项列表');
		this.detail = this.area.createDiv('gvkit-arrange-detail');
		this.detail.hidden = true;
		const composer = root.createDiv('gvkit-arrange-composer');
		this.input = composer.createEl('textarea', { attr: { rows: '1', placeholder: '想到就记…', 'aria-label': '新增事项' } });
		this.createButton = iconButton(composer, '创建事项', 'arrow-up', () => { void this.create(); });
		this.createButton.addClass('gvkit-arrange-submit');
		this.registerDomEvent(this.input, 'input', () => this.updateComposer());
		this.updateComposer();
		this.applyComposerSettings();
		if (Platform.isIosApp) {
			this.keyboardBackdrop = document.body.createDiv({ cls: 'gvkit-arrange-keyboard-backdrop', attr: { 'aria-hidden': 'true' } });
			this.keyboardBackdrop.hidden = true;
			this.register(() => { this.keyboardBackdrop?.remove(); this.keyboardBackdrop = null; });
		}
		this.input.onkeydown = event => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) {
				event.preventDefault(); event.stopPropagation();
				if (!event.repeat) this.createButton.click();
			}
		};
		this.registerDomEvent(root, 'keydown', event => {
			if (event.key !== 'Escape') return;
			if (this.choosingParent) this.finishParentChoice();
			else if (this.searchOpen) this.toggleSearch();
			else void this.select(null);
		});
		const refresh = () => {
			if (this.timer !== null) window.clearTimeout(this.timer);
			this.timer = window.setTimeout(() => {
				this.timer = null;
				if (this.busy) refresh(); else void this.reload();
			}, 180);
		};
		for (const name of ['create', 'modify', 'delete', 'rename'] as const) {
			this.registerEvent(this.app.vault.on(name as 'modify', file => {
				if (file.path.startsWith('安排/') || file.path === ARRANGE_STATE_PATH) refresh();
			}));
		}
		if (this.app.metadataCache) this.registerEvent(this.app.metadataCache.on('changed', file => {
			if (file.path.startsWith('安排/历史/')) refresh();
		}));
		this.registerInterval(window.setInterval(() => this.paintLists(), 60_000));
		this.registerDomEvent(document, 'visibilitychange', () => { if (document.hidden) void this.saveEdit(); else void this.reload(); });
		// iOS can keep visualViewport unchanged while Obsidian first adds a CSS
		// keyboard inset, then shrinks the host. Reserve only the remaining overlap.
		const fit = () => {
			const viewport = window.visualViewport;
			const bounds = root.getBoundingClientRect();
			const bottom = bounds.bottom;
			const css = window.getComputedStyle(root);
			const keyboard = Platform.isIosApp
				? Math.max(0, parseFloat(css.getPropertyValue('--keyboard-height')) || 0) : 0;
			// Span host insets for the input and panel, retaining the list's original inset.
			composer.style.marginLeft = `-${css.paddingLeft}`;
			composer.style.marginRight = `-${css.paddingRight}`;
			this.updateComposer();
			if (Platform.isMobileApp) {
				this.area.style.marginLeft = `-${css.paddingLeft}`; this.area.style.marginRight = `-${css.paddingRight}`;
				this.list.style.paddingLeft = css.paddingLeft; this.list.style.paddingRight = css.paddingRight;
			}
			root.classList.toggle('gvkit-arrange-keyboard-open', keyboard > 0);
			const visibleBottom = Math.min(viewport ? viewport.height + viewport.offsetTop : window.innerHeight,
				keyboard > 0 ? window.innerHeight - keyboard : Infinity);
			const overlap = Math.max(0, bottom - visibleBottom);
			if (keyboard > 0 || overlap > 0) {
				// Explicit zero must override the host CSS inset after it has resized.
				root.style.setProperty('padding-bottom', `${overlap}px`, keyboard > 0 ? 'important' : '');
			} else root.style.removeProperty('padding-bottom');
			// First keyboard opening can scroll the title using the old panel geometry.
			// Restore the pre-focus position after fitting, without changing the caret.
			const anchor = this.titleFocusScroll;
			if (anchor && document.activeElement === anchor.input && this.editing?.title === anchor.input)
				this.detailScroll.scrollTop = anchor.top;
			// Paint behind native keyboard corners, outside the host's clipped pane.
			// This is decoration only: it never changes keyboard/composer geometry.
			if (this.keyboardBackdrop) {
				this.keyboardBackdrop.hidden = this.closed || keyboard <= 0
					|| this.app.workspace.getActiveViewOfType(ArrangeView) !== this;
				Object.assign(this.keyboardBackdrop.style, {
					top: `${Math.max(0, visibleBottom - 1)}px`, left: `${bounds.left}px`, width: `${bounds.width}px`,
				});
			}
		};
		if (Platform.isIosApp) this.registerEvent(this.app.workspace.on('active-leaf-change', fit));
		if (window.visualViewport) {
			const viewport = window.visualViewport;
			const observer = new ResizeObserver(fit);
			// Padding changes the content box; watch the host-controlled border box
			// so our own compensation does not trigger a resize feedback loop.
			observer.observe(root, { box: 'border-box' });
			const resize = () => fit(), scroll = () => fit();
			viewport.addEventListener('resize', resize);
			viewport.addEventListener('scroll', scroll);
			this.register(() => {
				observer.disconnect();
				viewport.removeEventListener('resize', resize);
				viewport.removeEventListener('scroll', scroll);
				root.style.paddingBottom = '';
				root.classList.remove('gvkit-arrange-keyboard-open');
				root.style.removeProperty('--gvkit-arrange-keyboard-gap');
			});
			fit();
		}
		await this.reload();
	}
	async onClose(): Promise<void> {
		this.closed = true;
		this.feedback.close();
		this.titleFocusScroll = null;
		delete this.contentEl.dataset.ignoreSwipe;
		this.cancelReorder?.();
		this.restoreHeader?.();
		this.contentEl.style.removeProperty('--gvkit-arrange-detail-shadow');
		this.contentEl.style.removeProperty('--gvkit-arrange-submit-size');
		this.contentEl.style.removeProperty('--gvkit-arrange-submit-color');
		this.keyboardBackdrop?.remove(); this.keyboardBackdrop = null;
		if (this.timer !== null) window.clearTimeout(this.timer);
		if (this.editTimer !== null) window.clearTimeout(this.editTimer);
		await this.saveEdit();
		this.editing?.body.destroy();
	}
	private async reload(): Promise<void> {
		try { await this.store.load(); if (!this.closed) { this.applyComposerSettings(); this.paintLists(); if (!this.keepEditor()) this.paintDetail(); } }
		catch (error) { this.error(error); }
	}
	private error(error: unknown): void { new Notice(error instanceof Error ? error.message : '安排操作未成功，请重试', 7000); }
	private guardSmallEditorZoom(root: HTMLElement): void {
		const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
		if (!meta) return;
		let locked = false, original: string | null = null;
		let timer: number | null = null;
		const smallEditor = (target: EventTarget | null): boolean => {
			const el = target as HTMLElement | null;
			return Boolean(el && root.contains(el) && el.matches?.('textarea,input:not([type="checkbox"]),.gvkit-arrange-inline-body .cm-content')
				&& parseFloat(window.getComputedStyle(el).fontSize) < 16);
		};
		const restore = () => {
			if (!locked) return;
			if (original === null) meta.removeAttribute('content'); else meta.setAttribute('content', original);
			locked = false;
		};
		const enable = (target: EventTarget | null) => {
			if (!smallEditor(target) || locked) return;
			original = meta.getAttribute('content'); locked = true;
			const parts = (original ?? 'width=device-width, initial-scale=1').split(',')
				.map(part => part.trim()).filter(part => part && !/^maximum-scale\s*=/i.test(part));
			meta.setAttribute('content', [...parts, 'maximum-scale=1'].join(', '));
		};
		this.registerDomEvent(root, 'pointerdown', event => enable(event.target));
		this.registerDomEvent(root, 'touchstart', event => enable(event.target), { passive: true });
		this.registerDomEvent(root, 'focusin', event => { if (smallEditor(event.target)) enable(event.target); else restore(); });
		const restoreAfterGesture = () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => { timer = null; if (!smallEditor(document.activeElement)) restore(); }, 0);
		};
		this.registerDomEvent(root, 'focusout', restoreAfterGesture);
		// A touch can turn into a scroll without ever focusing the editor.
		for (const type of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const)
			this.registerDomEvent(document, type, restoreAfterGesture, { passive: true });
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			if (this.app.workspace.getActiveViewOfType(ArrangeView) !== this) restore();
		}));
		this.register(() => { if (timer !== null) window.clearTimeout(timer); restore(); });
	}
	private applyComposerSettings(): void {
		const state = this.store.state;
		for (const [name, value] of Object.entries({
			'list-font': state.listFontSize, 'row-height': state.rowHeight,
			'row-icon': state.listFontSize + 2, 'row-slot': state.listFontSize + 2 + state.rowIconGap,
			'checkbox': (state.listFontSize + 5) * state.checkboxScale / 100, 'check-gap': Math.round(state.listFontSize * 0.5),
			'right-gap': state.listFontSize * state.rowRightGap,
			'detail-font': state.detailFontSize, 'body-font': state.bodyFontSize, 'date-font': state.dateFontSize,
			'detail-checkbox': (state.detailFontSize + 3) * state.checkboxScale / 100, 'detail-icon': state.detailFontSize + 1,
			'detail-slot': state.detailFontSize + 1 + state.detailIconGap,
			'grip-height': state.gripHeight, 'grip-width': state.gripWidth,
			'toolbar-height': state.toolbarHeight, 'parent-font': state.parentFontSize,
		})) this.contentEl.style.setProperty(`--gvkit-arrange-${name}`, `${value}px`);
		this.contentEl.dataset.rowDividers = String(state.rowDividers);
		this.contentEl.style.setProperty('--gvkit-arrange-pin-color', PIN_COLORS[state.pinColor]);
		this.contentEl.style.setProperty('--gvkit-arrange-date-color', DATE_HINT_COLORS[state.dateHintColor] ?? DATE_HINT_COLORS.vivid);
		this.headline.dataset.selectionColor = state.selectionColor;
		this.contentEl.style.setProperty('--gvkit-arrange-keyboard-gap', `${this.store.state.keyboardGap}px`);
		this.contentEl.style.setProperty('--gvkit-arrange-submit-size', `${this.store.state.submitArrowSize}px`);
		this.contentEl.style.setProperty('--gvkit-arrange-submit-color', SUBMIT_BLUE_COLORS[this.store.state.submitColor]);
		this.contentEl.style.setProperty('--gvkit-arrange-detail-shadow', this.store.state.detailShadow === 0 ? 'none' : `0 -7px ${this.store.state.detailShadow ?? 24}px #0003`);
		this.contentEl.style.setProperty('--gvkit-arrange-body-rows', String(state.bodyMinRows));
		this.updateComposer();
		const edit = this.editing;
		if (edit) {
			edit.title.style.height = '0'; edit.title.style.height = `${edit.title.scrollHeight}px`;
			edit.body.placeholder = this.store.state.bodyPlaceholder;
			// Update only the empty hint; never replace an editor or its unsaved text.
			const hint = edit.preview.querySelector<HTMLElement>('.gvkit-arrange-body-placeholder');
			if (hint) hint.textContent = this.store.state.bodyPlaceholder;
		}
	}
	private updateComposer(): void {
		const css = window.getComputedStyle(this.input);
		const line = parseFloat(css.lineHeight) || 24;
		const padding = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0);
		const minimum = line + padding;
		const maximum = line * (this.store.state.composerMaxRows ?? 6) + padding;
		this.input.style.height = '0';
		const height = Math.min(maximum, Math.max(minimum, this.input.scrollHeight));
		this.input.style.height = `${height}px`;
		this.input.style.overflowY = this.input.scrollHeight > height ? 'auto' : 'hidden';
		// Keep the mobile panel's visible height while its bottom follows the composer.
		this.contentEl.style.setProperty('--gvkit-arrange-composer-growth', `${Math.max(0, height - minimum)}px`);
		const empty = !this.input.value.trim();
		this.createButton.hidden = empty;
		this.input.disabled = Boolean(this.choosingParent);
		this.createButton.disabled = this.busy || empty || Boolean(this.choosingParent);
	}
	private async run(action: () => Promise<unknown>): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		this.updateComposer();
		try { await action(); this.paintLists(); if (!this.keepEditor()) this.paintDetail(); return true; }
		catch (error) { this.error(error); await this.reload(); return false; }
		finally { this.busy = false; this.updateComposer(); }
	}
	private ordered(): ArrangeItem[] {
		const byId = new Map(this.store.items.map(item => [item.id, item]));
		return this.store.state.order.map(id => byId.get(id)).filter((item): item is ArrangeItem => Boolean(item));
	}
	private paintLists(): void {
		if (!this.headline || this.closed) return;
		this.cancelReorder?.();
		const facts = this.store.facts();
		this.today = facts.day;
		this.headline.empty();
		const statusIcon = this.headline.createSpan({ cls: 'gvkit-arrange-status-icon', attr: { 'aria-hidden': 'true' } });
		setIcon(statusIcon, facts.color === 'red' ? 'circle-alert' : facts.color === 'gold' ? 'trophy' : 'circle-check');
		this.headline.createSpan({ text: `今天达成 ${facts.x}/${facts.y}` });
		this.headline.setAttribute('aria-label', `今天达成 ${facts.x}/${facts.y}，今天必做剩余 ${facts.remaining} 项。点击切换今日必做与完成事项`);
		this.headline.dataset.color = facts.color;
		this.headline.setAttribute('aria-pressed', String(this.filter === 'today' && !this.searchOpen && !this.choosingParent));
		this.headline.disabled = Boolean(this.choosingParent);
		this.moreButton.disabled = Boolean(this.choosingParent);
		this.hierarchyButton.disabled = Boolean(this.choosingParent);
		const hierarchyLabel = `事项筛选：${{ all: '全部', roots: '无上级', leaves: '无下级' }[this.hierarchyFilter]}`;
		this.hierarchyButton.setAttribute('aria-label', hierarchyLabel);
		this.hierarchyButton.title = hierarchyLabel;
		this.hierarchyButton.setAttribute('aria-pressed', String(this.hierarchyFilter !== 'all'));
		this.contentEl.dataset.completedStyle = this.store.state.completedStyle ?? 'background';
		this.contentEl.dataset.rootItemStyle = this.store.state.rootItemStyle;
		const scroll = this.list.scrollTop;
		this.list.empty();
		if (this.filter === 'overdue' && !this.searchOpen && !this.choosingParent) {
			const bar = this.list.createDiv('gvkit-arrange-scope');
			bar.createSpan({ text: '逾期事项' });
			iconButton(bar, '返回全部事项', 'x', () => this.setFilter('all'));
		}
		let items = this.ordered();
		if (this.choosingParent) {
			items = [...items, ...this.store.items.filter(item => item.completedAt)];
		} else if (!this.searchOpen) {
			if (this.filter === 'today') items = [
				...items.filter(item => item.date === facts.day),
				...this.store.items.filter(item => item.completedAt && dayKey(new Date(item.completedAt), this.store.state.timezone) === facts.day)
					.sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!)),
			];
			if (this.filter === 'overdue') items = items.filter(item => item.date && item.date < facts.day);
		}
		if (this.searchOpen) {
			if (!this.choosingParent) {
				if (this.includeCompleted) items.push(...this.store.items.filter(item => item.completedAt)
					.sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!)));
				if (this.searchDate) items = items.filter(item => matchesDateRange(item, dateRange(this.searchDate!.day, this.searchDate!.grain), this.store.state.timezone));
			}
			const query = this.searchInput.value.trim().toLowerCase();
			items = items.filter(item => item.title.toLowerCase().includes(query));
		}
		if (!this.choosingParent) {
			// Relationships come from all loaded items, before any visibility filter.
			if (this.hierarchyFilter === 'roots') items = items.filter(item => item.parent === null);
			if (this.hierarchyFilter === 'leaves') {
				const parents = new Set(this.store.items.map(item => item.parent).filter(Boolean));
				items = items.filter(item => !parents.has(item.id));
			}
			// Only the default main list folds projects. Search/date views can still
			// find their descendants; details and parent choice retain real relations.
			if (!this.searchOpen && this.filter === 'all') {
				const byId = new Map(this.store.items.map(item => [item.id, item]));
				items = items.filter(item => {
					const seen = new Set([item.id]);
					let parent = item.parent;
					while (parent && !seen.has(parent)) {
						seen.add(parent);
						const ancestor = byId.get(parent);
						if (ancestor?.developmentProject) return false;
						parent = ancestor?.parent ?? null;
					}
					return true;
				});
			}
		}
		for (const item of items) this.row(this.list, item);
		if (!items.length) this.list.createDiv({ cls: 'gvkit-arrange-empty', text: this.searchOpen || this.choosingParent ? '没有符合条件的事项' : this.filter === 'all' ? '想到什么，就从下面记下来。' : '这里已经清空。' });
		this.list.scrollTop = scroll;
		if (this.children && this.selected && !this.choosingParent) {
			this.children.empty();
			for (const item of this.directChildren(this.selected)) this.row(this.children, item);
		}
		this.paintDetailState();
	}
	private directChildren(id: string): ArrangeItem[] {
		return [...this.ordered().filter(item => item.parent === id),
			...(this.store.state.showCompletedChildren ? this.store.items.filter(item => item.parent === id && item.completedAt)
				.sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!)) : [])];
	}
	private paintTitle(label: HTMLElement, title: string, searchable: boolean): void {
		const query = searchable && this.searchOpen ? this.searchInput.value.trim().toLowerCase() : '';
		if (!query) { label.textContent = title; return; }
		const lower = title.toLowerCase();
		let cursor = 0, index = lower.indexOf(query);
		while (index >= 0) {
			label.append(document.createTextNode(title.slice(cursor, index)));
			label.createSpan({ cls: 'gvkit-arrange-match', text: title.slice(index, index + query.length) });
			cursor = index + query.length; index = lower.indexOf(query, cursor);
		}
		label.append(document.createTextNode(title.slice(cursor)));
	}
	private setFilter(filter: typeof this.filter): void {
		if (this.choosingParent) return;
		if (this.searchOpen) this.toggleSearch();
		this.scrolls.set(this.filter, this.list.scrollTop);
		this.filter = filter;
		this.paintLists();
		this.list.scrollTop = this.scrolls.get(filter) ?? 0;
	}
	private toggleSearch(): void {
		if (!this.searchOpen) this.searchScroll = this.list.scrollTop;
		this.searchOpen = !this.searchOpen;
		if (!this.searchOpen) this.searchInput.blur();
		this.searchInput.value = '';
		this.syncSearch();
		this.paintLists();
		this.list.scrollTop = this.searchOpen ? 0 : this.searchScroll;
		if (this.searchOpen) this.searchInput.focus({ preventScroll: true });
	}
	private syncSearch(): void {
		this.searchBar.hidden = !this.searchOpen;
		this.searchButton.setAttribute('aria-pressed', String(this.searchOpen));
		this.completedButton.hidden = Boolean(this.choosingParent);
		this.dateButton.hidden = Boolean(this.choosingParent);
		this.completedButton.setAttribute('aria-pressed', String(this.includeCompleted));
		this.dateButton.setAttribute('aria-pressed', String(Boolean(this.searchDate)));
		this.dateBar.hidden = !this.searchOpen || !this.searchDate || Boolean(this.choosingParent);
		this.dateBar.empty();
		if (this.dateBar.hidden || !this.searchDate) return;
		const filter = this.searchDate;
		const update = () => { this.syncSearch(); this.paintLists(); this.list.scrollTop = 0; };
		const grains = this.dateBar.createDiv('gvkit-arrange-date-grains');
		for (const [grain, name] of [['day', '日'], ['week', '周'], ['month', '月'], ['year', '年']] as const) {
			const button = grains.createEl('button', { text: name, attr: { 'aria-pressed': String(filter.grain === grain) } });
			button.onclick = () => { filter.grain = grain; update(); };
		}
		iconButton(grains, '清除日期条件', 'x', () => { this.searchDate = null; update(); });
		const period = this.dateBar.createDiv('gvkit-arrange-date-period');
		iconButton(period, '上一期', 'chevron-left', () => { filter.day = shiftPeriod(filter.day, filter.grain, -1); update(); });
		if (filter.grain === 'day') {
			const input = period.createEl('input', { type: 'date', value: filter.day, attr: { 'aria-label': '搜索日期' } });
			input.onchange = () => { if (input.value) { filter.day = input.value; update(); } };
		} else {
			const range = dateRange(filter.day, filter.grain);
			period.createSpan({ text: `${range.start} — ${range.end}` });
		}
		iconButton(period, '下一期', 'chevron-right', () => { filter.day = shiftPeriod(filter.day, filter.grain, 1); update(); });
	}
	private row(parent: HTMLElement, item: ArrangeItem): void {
		const row = parent.createDiv('gvkit-arrange-row');
		row.dataset.id = item.id;
		row.toggleClass('is-selected', item.id === this.selected);
		row.toggleClass('is-pinned', item.pinned);
		row.toggleClass('is-root-item', item.parent === null);
		row.toggleClass('is-development-project', Boolean(item.developmentProject));
		row.toggleClass('is-completed', Boolean(item.completedAt));
		if (this.choosingParent) {
			const invalid = !validParent(this.store.items, this.choosingParent.id, item.id);
			row.toggleClass('is-invalid-parent', invalid);
			const label = row.createEl('button', { cls: 'gvkit-arrange-title', attr: { 'aria-disabled': String(invalid) } });
			this.paintTitle(label, item.title, true);
			label.onclick = () => { void this.chooseParent(item.id); };
			return;
		}
		const complete = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': `${item.completedAt ? '撤销完成' : '完成'}：${item.title}` } });
		complete.checked = Boolean(item.completedAt);
		complete.toggleClass('is-development-completed', Boolean(item.developmentCompleted && !item.completedAt));
		complete.onclick = event => {
			event.stopPropagation(); complete.checked = Boolean(item.completedAt);
			void this.toggleComplete(item.id);
		};
		const label = row.createEl('button', { cls: 'gvkit-arrange-title', attr: { title: item.title } });
		this.paintTitle(label, item.title, parent === this.list);
		label.onclick = () => { void this.select(this.selected === item.id ? null : item.id); };
		if (this.store.items.some(child => child.parent === item.id)) {
			const indicator = row.createSpan({ cls: 'gvkit-arrange-has-children', attr: { title: '有直接下级事项', 'aria-label': '有直接下级事项' } });
			setIcon(indicator, 'list-tree');
		}
		if (item.date) {
			label.dataset.date = item.date;
			label.title = `${item.title} · ${item.date}${item.date < this.today && !item.completedAt ? ' · 逾期' : ''}`;
			if (!item.completedAt && item.date < this.today) label.addClass('is-overdue');
		}
		const dateText = rowDateLabel(item, this.today);
		if (dateText) {
			const hint = row.createSpan({ cls: 'gvkit-arrange-row-date', text: dateText, attr: { title: item.date! } });
			hint.toggleClass('is-overdue', item.date! < this.today);
		}
		const actionArea = row.createDiv('gvkit-arrange-actions');
		for (const key of this.store.state.rowActions) {
			if (!this.actionAvailable(key, item)) continue;
			const button = iconButton(actionArea, actions[key].title, actions[key].icon, event => this.action(key, item, event));
			if (key === 'pin' && item.pinned) button.addClass('is-active');
			if (key === 'date' && item.date) button.addClass('is-active');
			if (key === 'developmentCompleted') button.toggleClass('is-active', Boolean(item.developmentCompleted));
			if (key === 'developmentProject') button.toggleClass('is-active', Boolean(item.developmentProject));
		}
		this.rowGesture(row, label, item);
	}
	private rowGesture(row: HTMLElement, label: HTMLElement, item: ArrangeItem): void {
		let suppressClickUntil = 0;
		row.addEventListener('click', event => {
			if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
		}, true);
		label.addEventListener('contextmenu', event => event.preventDefault());
		const start = (x: number, y: number, touch: boolean) => {
			this.cancelReorder?.();
			let dragging = false, moved = false;
			let target: HTMLElement | null = null;
			let after = false;
			let topDrop = false;
			let axis: 'left' | 'other' | null = null;
			let lastX = x, lastY = y;
			const timer = window.setTimeout(() => {
				if (moved || this.busy || item.pinned || item.completedAt) return;
				dragging = true; row.addClass('is-dragging');
				suppressClickUntil = Infinity;
			}, 380);
			const cleanup = () => {
				window.clearTimeout(timer);
				document.removeEventListener('touchmove', touchMove); document.removeEventListener('touchend', touchEnd);
				document.removeEventListener('touchcancel', cancel); document.removeEventListener('touchstart', extraTouch);
				document.removeEventListener('pointermove', mouseMove); document.removeEventListener('pointerup', mouseEnd);
				document.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel);
				row.removeClass('is-dragging'); row.style.removeProperty('transform'); target?.removeClass('is-drop-target');
				if (dragging || moved) suppressClickUntil = Date.now() + 500;
				if (this.cancelReorder === cancel) this.cancelReorder = null;
			};
			const cancel = () => cleanup();
			const move = (clientX: number, clientY: number, event: Event) => {
				lastX = clientX; lastY = clientY;
				if (!dragging) {
					const dx = clientX - x, dy = clientY - y;
					if (Math.hypot(dx, dy) > 8) {
						moved = true; window.clearTimeout(timer);
						axis ??= dx < -Math.abs(dy) * 1.5 ? 'left' : 'other';
					}
					if (axis === 'left' && this.store.state.swipeAction !== 'none') {
						event.preventDefault();
						row.style.transform = `translateX(${Math.max(-80, Math.min(0, dx))}px)`;
					}
					return;
				}
				event.preventDefault();
				row.style.transform = `translateY(${clientY - y}px)`;
				target?.removeClass('is-drop-target');
				const container = row.parentElement!;
				const first = container.querySelector<HTMLElement>('.gvkit-arrange-row:not(.is-completed)');
				const scroller = row.closest<HTMLElement>('.gvkit-arrange-detail-scroll') ?? this.list;
				const bounds = scroller.getBoundingClientRect();
				// Above the list remains a real global-top destination, even outside the pane.
				topDrop = Boolean(first && clientY <= Math.max(bounds.top, first === row ? container.getBoundingClientRect().top : first.getBoundingClientRect().top));
				if (topDrop) {
					target = container.querySelector<HTMLElement>('.gvkit-arrange-row:not(.is-completed):not(.is-pinned):not(.is-dragging)');
					after = false;
				} else {
					const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.gvkit-arrange-row');
					target = hit && hit !== row && hit.parentElement === container && !hit.classList.contains('is-completed') ? hit : null;
					after = Boolean(target && clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2);
				}
				target?.addClass('is-drop-target');
				if (target) target.dataset.dropAfter = String(after);
				if (topDrop && target) {
					// Show the actual first free slot, not an off-screen preview in a long list.
					const targetTop = target.getBoundingClientRect().top;
					if (targetTop < bounds.top || targetTop >= bounds.bottom - 2) scroller.scrollTop += targetTop - bounds.top;
				} else {
					if (clientY < bounds.top + 32) scroller.scrollTop -= 14;
					if (clientY > bounds.bottom - 32) scroller.scrollTop += 14;
				}
			};
			const end = (event: Event) => {
				const targetId = target?.dataset.id;
				const key = this.store.state.swipeAction;
				const swipe = !dragging && axis === 'left' && x - lastX >= 56 && x - lastX > Math.abs(lastY - y) * 1.5;
				if (dragging || swipe) event.preventDefault();
				cleanup();
				if (dragging && (topDrop || targetId)) void this.run(() => this.store.move(item.id, topDrop ? undefined : targetId, after));
				else if (swipe && key !== 'none' && !this.busy) this.action(key, item,
					new MouseEvent('click', { clientX: lastX, clientY: lastY, view: window }));
			};
			const extraTouch = (e: TouchEvent) => { if (e.touches.length !== 1) cancel(); };
			const touchMove = (e: TouchEvent) => { const p = e.touches[0]; if (p && e.touches.length === 1) move(p.clientX, p.clientY, e); else cancel(); };
			const touchEnd = (e: TouchEvent) => { const p = e.changedTouches[0]; if (p) { lastX = p.clientX; lastY = p.clientY; } end(e); };
			const mouseMove = (e: PointerEvent) => move(e.clientX, e.clientY, e);
			const mouseEnd = (e: PointerEvent) => { lastX = e.clientX; lastY = e.clientY; end(e); };
			if (touch) {
				document.addEventListener('touchmove', touchMove, { passive: false });
				document.addEventListener('touchend', touchEnd, { passive: false });
				document.addEventListener('touchcancel', cancel); document.addEventListener('touchstart', extraTouch);
			} else {
				document.addEventListener('pointermove', mouseMove); document.addEventListener('pointerup', mouseEnd); document.addEventListener('pointercancel', cancel);
			}
			window.addEventListener('blur', cancel);
			this.cancelReorder = cancel;
		};
		const onBody = (target: EventTarget | null) => target === row || label.contains(target as Node);
		row.addEventListener('touchstart', event => {
			// New presses, including checkboxes/shortcuts, are not the old gesture's synthetic click.
			suppressClickUntil = 0;
			if (event.touches.length === 1 && onBody(event.target)) start(event.touches[0]!.clientX, event.touches[0]!.clientY, true);
		}, { passive: true });
		row.addEventListener('pointerdown', event => {
			suppressClickUntil = 0;
			if (event.pointerType !== 'touch' && event.button === 0 && onBody(event.target)) start(event.clientX, event.clientY, false);
		});
	}
	private actionAvailable(key: RowAction, item: ArrangeItem): boolean {
		if (key === 'parent') return Boolean(item.parent && this.store.items.some(parent => parent.id === item.parent));
		if (key === 'top') return !item.completedAt;
		if (key === 'pin' || key === 'developmentCompleted') return !item.completedAt;
		return true;
	}
	private action(key: RowAction, item: ArrangeItem, event: MouseEvent): void {
		if (!this.store.items.some(value => value.id === item.id)) return;
		if (!this.actionAvailable(key, item)) return;
		if (key === 'parent' && item.parent) {
			void this.select(item.parent).then(() => {
				const row = this.children?.querySelector<HTMLElement>(`[data-id="${item.id}"]`);
				row?.scrollIntoView({ block: 'nearest' }); row?.addClass('is-located');
			});
		} else if (key === 'date') this.dateMenu(item, event);
		else if (key === 'top') void this.run(() => this.store.move(item.id)).then(() => this.reveal(item.id));
		else if (key === 'pin') void this.run(() => this.store.togglePin(item.id));
		else if (key === 'developmentCompleted') void this.run(() => this.store.toggleDevelopmentCompleted(item.id));
		else if (key === 'developmentProject') void this.run(() => this.store.toggleDevelopmentProject(item.id));
		else if (key === 'changeParent') void this.changeParent(item.id);
		else if (key === 'copy') void this.copyItem(item);
		else if (key === 'archive') void this.run(async () => {
			if (!(await this.saveEdit())) return;
			await this.store.archive(item.id);
			if (this.selected === item.id) {
				this.editing?.body.destroy(); this.editing = null; this.selected = null; this.full = false;
				this.detail.style.height = ''; this.detail.style.maxHeight = '';
			}
		});
	}
	private async copyItem(item: ArrangeItem, includeBody = false): Promise<void> {
		const edit = this.editing?.id === item.id ? this.editing : null;
		const title = edit?.title.value ?? item.title, body = edit?.body.value ?? item.body;
		try {
			await navigator.clipboard.writeText(includeBody ? `${title}\n\n${body}` : title);
			new Notice(includeBody ? '已复制标题及附注' : '已复制标题');
		} catch { new Notice('复制失败，请重试'); }
	}
	private reveal(id: string): void {
		const parent = this.selected ? this.children : this.list;
		parent?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
	}
	private itemMenu(item: ArrangeItem, event: MouseEvent): void {
		const modal = new Modal(this.app);
		modal.setTitle('事项操作');
		modal.contentEl.addClass('gvkit-arrange-item-menu');
		const headings = modal.contentEl.createDiv('gvkit-arrange-menu-headings');
		headings.createSpan({ text: '列表' }); headings.createSpan({ text: '详情' });
		const entry = (title: string, icon: string, action: () => void) => {
			const row = modal.contentEl.createDiv('gvkit-arrange-menu-row');
			const button = row.createEl('button', { cls: 'gvkit-arrange-menu-action' });
			setIcon(button.createSpan(), icon);
			button.createSpan({ text: title });
			button.onclick = () => { modal.close(); action(); };
			return row;
		};
		for (const key of ARRANGE_ACTIONS) {
			const title = key === 'pin' && item.pinned ? '取消钉住'
				: key === 'developmentCompleted' && item.developmentCompleted ? '取消已完成开发'
				: key === 'developmentProject' && item.developmentProject ? '取消开发工程' : actions[key].title;
			const row = entry(title, actions[key].icon, () => this.action(key, item, event));
			if (key === 'developmentCompleted' || key === 'developmentProject') {
				const button = row.querySelector<HTMLButtonElement>('.gvkit-arrange-menu-action')!;
				button.setAttribute('aria-pressed', String(Boolean(item[key])));
				button.toggleClass('is-active', Boolean(item[key]));
			}
			row.querySelector<HTMLButtonElement>('.gvkit-arrange-menu-action')!.disabled = !this.actionAvailable(key, item);
			for (const [setting, name] of [['rowActions', '列表'], ['detailActions', '详情']] as const) {
				const toggle = row.createEl('button', { cls: 'gvkit-arrange-menu-toggle', attr: { role: 'checkbox', 'aria-label': `${name}显示${actions[key].title}` } });
				const paint = () => {
					const checked = this.store.state[setting].includes(key);
					toggle.setAttribute('aria-checked', String(checked)); setIcon(toggle, checked ? 'square-check' : 'square');
				};
				paint();
				toggle.onclick = async () => {
					if (toggle.disabled) return;
					toggle.disabled = true;
					await this.run(() => {
						const values = this.store.state[setting];
						return this.store.configure({ [setting]: values.includes(key) ? values.filter(value => value !== key) : [...values, key] });
					});
					this.paintDetailActions();
					paint(); toggle.disabled = false;
				};
			}
		}
		modal.open();
	}
	private dateMenu(item: ArrangeItem, event: MouseEvent): void {
		const day = todayFacts(this.store.items, this.store.state).day;
		const menu = new Menu();
		if (item.date) menu.addItem(entry => entry.setTitle(`当前日期：${item.date}`).setDisabled(true));
		for (const [label, date] of [['清除日期', null], ['今天', day], ['明天', offsetDay(day, 1)]] as const)
			menu.addItem(entry => entry.setTitle(label).onClick(() => { void this.run(() => this.store.setDate(item.id, date)); }));
		menu.addItem(entry => entry.setTitle('选择日期…').setIcon('calendar').onClick(() => {
			const modal = new Modal(this.app);
			modal.setTitle('选择日期');
			const input = modal.contentEl.createEl('input', { type: 'date', value: item.date ?? day, attr: { 'aria-label': '必做日期' } });
			new Setting(modal.contentEl).addButton(button => button.setButtonText('取消').onClick(() => modal.close()))
				.addButton(button => button.setButtonText('完成').setCta().onClick(async () => {
					if (input.value && await this.run(() => this.store.setDate(item.id, input.value))) modal.close();
				}));
			modal.open();
		}));
		menu.showAtMouseEvent(event);
	}
	private async select(id: string | null): Promise<void> {
		if (this.choosingParent) return;
		if (!(await this.saveEdit())) return;
		this.editing?.body.destroy(); this.editing = null;
		this.selected = id;
		this.full = false;
		this.detail.style.height = '';
		this.detail.style.maxHeight = '';
		this.paintLists(); this.paintDetail();
	}
	private async toggleComplete(id: string): Promise<void> {
		if (this.busy) return;
		if (!this.store.items.find(item => item.id === id)?.completedAt) this.feedback.prepare();
		await this.run(async () => {
			if (!(await this.saveEdit())) return;
			const item = this.store.items.find(item => item.id === id);
			if (item) {
				const done = !item.completedAt;
				const changed = await this.store.complete(id, done);
				if (changed && done && !this.closed) this.feedback.play();
			}
		});
	}
	private paintDetailState(): void {
		const item = this.store.items.find(item => item.id === this.selected);
		if (!item) return;
		if (!this.store.items.some(parent => parent.id === item.parent))
			this.detail.querySelector('.gvkit-arrange-parent-name')?.remove();
		const label = this.detail.querySelector<HTMLElement>('.gvkit-arrange-detail-date');
		if (label) {
			label.hidden = !item.date;
			const text = item.date ? relativeDate(item.date, this.today, Boolean(item.completedAt)) : '';
			const overdue = text.indexOf('已逾期');
			label.empty();
			if (overdue >= 0) {
				label.append(document.createTextNode(text.slice(0, overdue)));
				label.createSpan({ cls: 'gvkit-arrange-detail-overdue', text: '已逾期' });
				label.append(document.createTextNode(text.slice(overdue + 3)));
			} else label.textContent = text;
			label.title = item.date ?? '';
		}
		const row = this.detail.querySelector<HTMLElement>('.gvkit-arrange-detail-title-row');
		row?.toggleClass('is-completed', Boolean(item.completedAt));
		row?.toggleClass('is-development-project', Boolean(item.developmentProject));
		const checkbox = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (checkbox) {
			checkbox.checked = Boolean(item.completedAt);
			checkbox.toggleClass('is-development-completed', Boolean(item.developmentCompleted && !item.completedAt));
			checkbox.setAttribute('aria-label', `${item.completedAt ? '撤销完成' : '完成'}：${item.title}`);
		}
		this.paintDetailActions();
	}
	private paintDetail(): void {
		if (this.choosingParent) { this.detail.hidden = true; return; }
		const item = this.store.items.find(item => item.id === this.selected);
		this.editing?.body.destroy();
		if (!item) { this.selected = null; this.editing = null; this.detail.hidden = true; return; }
		const scroll = this.editing?.id === item.id ? this.detailScroll?.scrollTop ?? 0 : 0;
		this.detail.hidden = false;
		this.detail.toggleClass('is-full', this.full);
		this.detail.empty();
		const grip = this.detail.createDiv('gvkit-arrange-panel-grip');
		grip.setAttribute('aria-label', '拖动调整详情高度');
		this.panelGesture(grip);
		const tools = this.detail.createDiv('gvkit-arrange-detail-tools');
		iconButton(tools, '返回主列表', 'arrow-left', () => { void this.select(null); });
		const date = tools.createEl('button', { cls: 'gvkit-arrange-detail-date', attr: { type: 'button', 'aria-label': '设置日期' } });
		date.onclick = event => this.action('date', this.store.items.find(value => value.id === item.id) ?? item, event);
		tools.createDiv('gvkit-arrange-detail-actions');
		this.paintDetailActions();
		iconButton(tools, '事项更多', 'more-horizontal', event => this.itemMenu(item, event));
		this.detailScroll = this.detail.createDiv('gvkit-arrange-detail-scroll');
		if (item.parent) {
			const parent = this.store.items.find(candidate => candidate.id === item.parent);
			if (parent) {
				const nav = this.detailScroll.createEl('button', { cls: 'gvkit-arrange-parent-name', attr: { title: parent.title } });
				nav.createSpan({ text: parent.title });
				setIcon(nav.createSpan({ cls: 'gvkit-arrange-parent-chevron' }), 'chevron-right');
				nav.onclick = () => { void this.select(parent.id); };
			}
		}
		const titleRow = this.detailScroll.createDiv('gvkit-arrange-detail-title-row');
		const complete = titleRow.createEl('input', { type: 'checkbox' });
		complete.onclick = () => { complete.checked = Boolean(this.store.items.find(value => value.id === item.id)?.completedAt); void this.toggleComplete(item.id); };
		const title = titleRow.createEl('textarea', { cls: 'gvkit-arrange-detail-title', attr: { 'aria-label': '事项完整标题', rows: '1' } });
		title.value = item.title;
		title.addEventListener('focus', () => {
			if (Platform.isIosApp && this.titleFocusScroll?.input !== title)
				this.titleFocusScroll = { input: title, top: this.detailScroll.scrollTop };
		});
		// A new selection/scroll or actual editing takes ownership after keyboard fitting.
		for (const type of ['touchstart', 'pointerdown'] as const)
			this.detailScroll.addEventListener(type, event => {
				this.titleFocusScroll = Platform.isIosApp && event.target === title && document.activeElement !== title
					? { input: title, top: this.detailScroll.scrollTop } : null;
			}, { passive: true });
		for (const type of ['touchmove', 'input', 'focusout'] as const)
			this.detailScroll.addEventListener(type, () => { this.titleFocusScroll = null; }, { passive: true });
		const error = this.detailScroll.createDiv({ cls: 'gvkit-arrange-edit-error', attr: { role: 'status', 'aria-live': 'polite' } });
		error.hidden = true;
		const preview = this.detailScroll.createDiv({ cls: 'gvkit-arrange-body', attr: { tabindex: '0', 'aria-label': '编辑事项正文' } });
		const body = new ArrangeBodyEditor(this.detailScroll, item.body, this.store.state.bodyPlaceholder, this.app, item.path, this, () => {
			error.hidden = true; this.scheduleEdit();
		});
		body.hidden = true;
		const edit = this.editing = { id: item.id, title, body, preview, error, savedTitle: item.title, savedBody: item.body, composing: false as boolean };
		this.renderBody();
		const resize = (input: HTMLTextAreaElement) => { input.style.height = '0'; input.style.height = `${input.scrollHeight}px`; };
		resize(title);
		// Native textarea hit testing handles the title, including its very first tap.
		const openBody = (offset = 0) => {
			preview.hidden = true; body.hidden = false; body.focus(offset);
		};
		preview.onclick = event => {
			if ((event.target as HTMLElement).closest('a, button') || window.getSelection()?.toString()) return;
			openBody(bodyCaretOffset(preview, body.value, event));
		};
		preview.onkeydown = event => { if (event.target === preview && event.key === 'Enter') { event.preventDefault(); openBody(); } };
		this.detailScroll.onclick = event => { if (event.target === this.detailScroll && !window.getSelection()?.toString()) openBody(); };
		for (const input of [title, body.editor.contentDOM]) {
			input.addEventListener('compositionstart', () => { edit.composing = true; });
			input.addEventListener('compositionend', () => { edit.composing = false; this.scheduleEdit(); });
			if (input === title) input.oninput = () => { resize(title); error.hidden = true; title.removeAttribute('aria-invalid'); this.scheduleEdit(); };
			input.onblur = () => { void this.saveEdit().then(ok => {
				// Replacing preview text on title blur can swallow the click landing on it.
				if (ok && input !== title && this.editing === edit && !body.focused) this.renderBody();
			}); };
		}
		this.children = this.detailScroll.createDiv('gvkit-arrange-children');
		for (const child of this.directChildren(item.id)) this.row(this.children, child);
		this.detailScroll.scrollTop = scroll;
		this.contentPullGesture(this.detailScroll);
		this.paintDetailState();
	}
	private contentPullGesture(scroller: HTMLElement): void {
		let start: { x: number; y: number; time: number } | null = null;
		let distance = 0, suppressClickUntil = 0;
		const editing = () => this.editing?.composing || Boolean(window.getSelection()?.toString())
			|| Boolean(document.activeElement?.matches('input, textarea, [contenteditable="true"]'));
		const reset = () => { start = null; distance = 0; this.detail.style.removeProperty('transform'); };
		scroller.addEventListener('click', event => {
			if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
		}, true);
		scroller.addEventListener('touchstart', event => {
			reset(); suppressClickUntil = 0;
			if (!Platform.isMobileApp || !this.store.state.pullDownClose || this.busy || editing()
				|| event.touches.length !== 1 || scroller.scrollTop < 0 || scroller.scrollTop > 1
				|| (event.target as HTMLElement).closest('input, textarea, button, a, [contenteditable], .gvkit-arrange-row')) return;
			const p = event.touches[0]!;
			start = { x: p.clientX, y: p.clientY, time: Date.now() };
		}, { passive: true });
		scroller.addEventListener('touchmove', event => {
			if (!start) return;
			if (!this.store.state.pullDownClose || event.touches.length !== 1 || editing() || scroller.scrollTop > 1
				|| Date.now() - start.time > 900) { reset(); return; }
			const p = event.touches[0]!, dx = p.clientX - start.x, dy = p.clientY - start.y;
			if (dy < -8 || Math.abs(dx) > Math.max(8, dy / 1.5)) { reset(); return; }
			distance = Math.max(0, dy);
			if (distance > 8) {
				event.preventDefault(); suppressClickUntil = Date.now() + 500;
				this.detail.style.transform = `translateY(${Math.min(120, distance)}px)`;
			}
		}, { passive: false });
		scroller.addEventListener('touchend', event => {
			const p = event.changedTouches[0];
			const close = start && p && distance >= 72 && p.clientY - start.y >= 72
				&& Math.abs(p.clientX - start.x) < (p.clientY - start.y) / 1.5
				&& this.store.state.pullDownClose && !editing() && !this.busy;
			if (distance > 8) { event.preventDefault(); suppressClickUntil = Date.now() + 500; }
			reset();
			if (close) void this.select(null);
		}, { passive: false });
		scroller.addEventListener('touchcancel', reset);
	}
	private panelGesture(grip: HTMLElement): void {
		grip.onpointerdown = event => {
			if (!Platform.isMobileApp || event.isPrimary === false || event.button > 0) return;
			const available = this.area.getBoundingClientRect().height;
			if (available <= 0) return;
			event.preventDefault(); grip.setPointerCapture(event.pointerId);
			const startY = event.clientY, startHeight = this.detail.getBoundingClientRect().height;
			const previous = { height: this.detail.style.height, maxHeight: this.detail.style.maxHeight, full: this.full };
			const restore = () => { this.detail.style.height = previous.height; this.detail.style.maxHeight = previous.maxHeight;
				this.full = previous.full; this.detail.toggleClass('is-full', this.full); };
			let height = startHeight;
			let moved = false;
			this.detail.style.maxHeight = '100%';
			const move = (e: PointerEvent) => {
				if (e.pointerId !== event.pointerId) return;
				moved = true;
				height = Math.min(available, Math.max(0, startHeight + startY - e.clientY));
				this.detail.style.height = `${height}px`;
			};
			const end = (e: PointerEvent) => {
				if (e.pointerId !== event.pointerId) return;
				grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end);
				if (e.type === 'pointercancel' || !moved) { restore(); return; }
				if (height / available * 100 <= this.store.state.closeThreshold) {
					void this.select(null).then(() => { if (this.selected) restore(); });
					return;
				}
				this.full = height / available * 100 >= this.store.state.fullscreenThreshold;
				this.detail.toggleClass('is-full', this.full);
				if (this.full) this.detail.style.height = '100%';
			};
			grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
		};
	}
	private paintDetailActions(): void {
		const item = this.store.items.find(item => item.id === this.selected);
		const strip = this.detail.querySelector<HTMLElement>('.gvkit-arrange-detail-actions');
		if (!item || !strip) return;
		const scroll = strip.scrollLeft;
		strip.empty();
		for (const key of this.store.state.detailActions) {
			if (!this.actionAvailable(key, item)) continue;
			const label = key === 'date' && item.date ? `日期：${item.date}` : actions[key].title;
			const button = iconButton(strip, label, actions[key].icon, event => this.action(key, item, event));
			button.toggleClass('is-active', key === 'date' && Boolean(item.date) || key === 'pin' && item.pinned
				|| key === 'developmentCompleted' && Boolean(item.developmentCompleted)
				|| key === 'developmentProject' && Boolean(item.developmentProject));
		}
		strip.scrollLeft = scroll;
	}
	private async changeParent(id: string): Promise<void> {
		if (this.busy || this.choosingParent) return;
		if (!(await this.saveEdit())) return;
		const item = this.store.items.find(item => item.id === id);
		if (!item) return;
		this.choosingParent = { id, scroll: this.list.scrollTop, detailScroll: this.detailScroll?.scrollTop ?? 0,
			searchOpen: this.searchOpen, query: this.searchInput.value, searchScroll: this.searchScroll };
		this.cancelReorder?.();
		this.searchOpen = false; this.searchInput.value = ''; this.syncSearch();
		this.parentError.textContent = ''; this.parentError.hidden = true; this.parentBar.hidden = false;
		this.detail.hidden = true; this.updateComposer(); this.paintLists(); this.list.scrollTop = 0;
	}
	private async chooseParent(parent: string | null): Promise<void> {
		const choice = this.choosingParent;
		if (!choice || this.busy) return;
		if (parent && !validParent(this.store.items, choice.id, parent)) {
			new Notice(parent === choice.id ? '不能选择自己作为上级' : '不能选择自己的下级事项作为上级', 2500);
			return;
		}
		this.busy = true;
		this.parentError.textContent = '';
		this.parentError.hidden = true;
		try {
			await this.store.setParent(choice.id, parent);
			this.busy = false;
			this.finishParentChoice();
		} catch (error) {
			this.parentError.textContent = error instanceof Error ? error.message : '保存失败，请重试';
			this.parentError.hidden = false;
		} finally { this.busy = false; this.updateComposer(); }
	}
	private finishParentChoice(): void {
		const choice = this.choosingParent;
		if (!choice || this.busy) return;
		this.choosingParent = null;
		this.searchInput.blur();
		this.searchOpen = choice.searchOpen; this.searchInput.value = choice.query; this.searchScroll = choice.searchScroll;
		this.syncSearch(); this.parentBar.hidden = true; this.parentError.hidden = true; this.updateComposer();
		this.paintLists(); this.paintDetail(); this.list.scrollTop = choice.scroll;
		if (this.detailScroll) this.detailScroll.scrollTop = choice.detailScroll;
	}
	private keepEditor(): boolean {
		const edit = this.editing;
		return Boolean(edit && (edit.title.value !== edit.savedTitle || edit.body.value !== edit.savedBody
			|| edit.composing || document.activeElement === edit.title || edit.body.focused));
	}
	private renderBody(): void {
		const render = ++this.bodyRender;
		const edit = this.editing;
		if (!edit) return;
		edit.body.hidden = true; edit.preview.hidden = false; edit.preview.empty();
		if (edit.body.value) {
			const item = this.store.items.find(item => item.id === edit.id);
			void MarkdownRenderer.render(this.app, edit.body.value, edit.preview, item?.path ?? '', this).then(() => {
				if (render !== this.bodyRender || this.editing !== edit || edit.preview.hidden || !item || !edit.body.value.trim()) return;
				const walker = edit.preview.ownerDocument.createTreeWalker(edit.preview, 4 /* SHOW_TEXT */);
				let last: Node | null = null;
				while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) last = walker.currentNode;
				const link = last?.parentElement?.closest('a');
				const end = link?.parentElement ?? last?.parentElement ?? edit.preview;
				const copy = iconButton(end, '复制标题及附注', 'copy', () => { void this.copyItem(item, true); });
				copy.addClass('gvkit-arrange-body-copy');
				if (link) link.after(copy);
			});
		} else edit.preview.createSpan({ cls: 'gvkit-arrange-body-placeholder', text: this.store.state.bodyPlaceholder });
	}
	private scheduleEdit(): void {
		if (this.editTimer !== null) window.clearTimeout(this.editTimer);
		this.editTimer = window.setTimeout(() => { this.editTimer = null; void this.saveEdit(); }, 600);
	}
	private saveEdit(): Promise<boolean> {
		if (this.editTimer !== null) { window.clearTimeout(this.editTimer); this.editTimer = null; }
		if (this.savingEdit) return this.savingEdit;
		this.savingEdit = this.flushEdit().finally(() => { this.savingEdit = null; });
		return this.savingEdit;
	}
	private async flushEdit(): Promise<boolean> {
		const edit = this.editing;
		if (!edit) return true;
		while (true) {
			if (edit.composing) return false;
			const title = edit.title.value, body = edit.body.value;
			if (!title.trim()) {
				edit.error.textContent = '标题不能为空，请在原处补充标题'; edit.error.hidden = false;
				edit.title.setAttribute('aria-invalid', 'true'); return false;
			}
			if (title === edit.savedTitle && body === edit.savedBody) return true;
			try {
				const item = this.store.items.find(item => item.id === edit.id);
				await this.store.edit(edit.id, title, body, item?.parent ?? null);
				edit.savedTitle = title; edit.savedBody = body; edit.error.hidden = true;
			} catch (error) {
				edit.error.textContent = `${error instanceof Error ? error.message : '保存失败'}；输入已保留，离开编辑区可重试`;
				edit.error.hidden = false; return false;
			}
			// A slow write must not swallow characters typed while it was pending.
		}
	}
	private async create(): Promise<void> {
		if (this.choosingParent) return;
		const draft = this.input.value;
		if (!draft.trim()) return;
		const parent = this.selected;
		let id: string | undefined;
		if (await this.run(async () => { id = await this.store.create(draft, parent); })) {
			if (this.input.value === draft) this.input.value = '';
			this.updateComposer();
			if (id) this.reveal(id);
		}
	}
	private headerMenu(event: MouseEvent): void {
		const facts = todayFacts(this.store.items, this.store.state);
		const menu = new Menu();
		menu.addItem(item => item.setTitle(facts.achieved ? '撤销今天基础特产投入达标' : '确认今天基础特产投入已达标').setIcon('sun').onClick(() => { void this.run(() => this.store.setAchieved(facts.day, !facts.achieved)); }));
		menu.addItem(item => item.setTitle('检查逾期事项').setIcon('calendar-clock').onClick(() => this.setFilter('overdue')));
		menu.addItem(item => item.setTitle('安排界面设置').setIcon('settings').onClick(() => this.settings()));
		menu.addItem(item => item.setTitle('复制手机快捷入口').setIcon('link').onClick(async () => {
			try { await navigator.clipboard.writeText(`obsidian://gvkit-arrange?vault=${encodeURIComponent(this.app.vault.getName())}`); new Notice('已复制。iPhone 快捷指令使用“打开 URL”，再添加到主屏幕。'); }
			catch { new Notice('无法复制，请使用命令面板“打开自御安排”'); }
		}));
		menu.addItem(item => item.setTitle('刷新').setIcon('refresh-cw').onClick(() => { void this.reload(); }));
		menu.showAtMouseEvent(event);
	}
	private settings(): void {
		const modal = new Modal(this.app); modal.setTitle('安排界面设置');
		modal.contentEl.createEl('p', { text: '设置自动保存在 settings/gvkit/arrange.md，随同一 Vault 的文件同步到其他设备。请确保同步包含 settings 目录。完成时播放轻音；触觉反馈取决于设备支持与系统设置，不支持震动的平台仅播放音效。' });
		modal.contentEl.dataset.ignoreSwipe = 'true';
		let rowActions = [...this.store.state.rowActions];
		const configure = (changes: Parameters<ArrangeStore['configure']>[0]) => {
			void this.store.configure(changes).then(() => { this.applyComposerSettings(); this.paintLists(); }).catch(error => this.error(error));
		};
		const names: Record<keyof typeof ARRANGE_NUMBER_SETTINGS | keyof typeof ARRANGE_FREE_SIZES, string> = {
			listFontSize: '列表标题字号', rowHeight: '事项行高', gripHeight: '顶部抓取触摸带高度',
			gripWidth: '可见拖动横条宽度', toolbarHeight: '详情操作栏高度', parentFontSize: '上级导航文字字号',
			closeThreshold: '向下拖动关闭阈值',
			detailFontSize: '详情标题字号', bodyFontSize: '详情正文字号', dateFontSize: '日期提示字号（列表与详情共用）',
			rowIconGap: '列表操作图标间距', detailIconGap: '详情操作图标间距',
			checkboxScale: '勾选框尺寸（原尺寸百分比）', rowRightGap: '列表右侧留白（字宽）',
		};
		// Keep the established settings order; input implementation must not reorder it.
		for (const settingKey of Object.keys(names) as (keyof typeof names)[]) {
			if (settingKey in ARRANGE_NUMBER_SETTINGS) {
				const key = settingKey as keyof typeof ARRANGE_NUMBER_SETTINGS;
				const [min, max, initial] = ARRANGE_NUMBER_SETTINGS[key];
				new Setting(modal.contentEl).setName(names[key])
					.setDesc(key === 'closeThreshold' ? `松手时剩余高度不大于此比例则关闭；默认 ${initial}%。`
						: `${min}～${max} 像素，默认 ${initial}。`)
					.addSlider(slider => slider.setLimits(min, max, 1).setValue(this.store.state[key]).setDynamicTooltip()
						.onChange(value => configure({ [key]: value })));
				continue;
			}
			const key = settingKey as keyof typeof ARRANGE_FREE_SIZES;
			const initial = ARRANGE_FREE_SIZES[key];
			let input: HTMLInputElement;
			let sizeSlider: SliderComponent;
			const sliderMax = (value: number) => Math.max(key === 'rowHeight' ? 128 : 64, value);
			const updateSlider = (value: number) => {
				sizeSlider.setLimits(0, sliderMax(value), 1);
				// Opening settings must preserve arbitrary saved fractions.
				sizeSlider.sliderEl.step = 'any';
				sizeSlider.setValue(value);
			};
			const setting = new Setting(modal.contentEl).setName(names[key])
				.setDesc(`滑动调节；也可精确输入，范围随数值扩展。支持小数和0，默认 ${initial}。`);
			setting.settingEl.addClass('gvkit-arrange-size-setting');
			setting.addSlider(slider => {
					sizeSlider = slider; updateSlider(this.store.state[key]);
					slider.sliderEl.setAttribute('aria-label', names[key]);
					slider.setDynamicTooltip().onChange(value => {
						// Use familiar whole-pixel drag steps without rounding stored/custom input values.
						value = Math.min(Number(slider.sliderEl.max), Math.round(value)); slider.setValue(value);
						input.value = String(value); input.removeAttribute('aria-invalid'); configure({ [key]: value });
					});
				})
				.addText(text => {
					input = text.inputEl;
					input.type = 'number'; input.min = '0'; input.step = 'any';
					input.setAttribute('aria-label', names[key]);
					text.setValue(String(this.store.state[key])).onChange(raw => {
						const value = Number(raw);
						const valid = raw.trim() !== '' && Number.isFinite(value) && value >= 0;
						input.setAttribute('aria-invalid', String(!valid));
						if (valid) { updateSlider(value); configure({ [key]: value }); }
					});
				});
			iconButton(setting.nameEl, `${names[key]}恢复默认`, 'rotate-ccw', () => {
				input.value = String(initial); input.removeAttribute('aria-invalid'); updateSlider(initial); configure({ [key]: initial });
			}).addClass('gvkit-arrange-setting-reset');
		}
		new Setting(modal.contentEl).setName('钉住竖条颜色')
			.addDropdown(dropdown => dropdown.addOptions({ gold: '金色（默认）', purple: '紫色', blue: '蓝色' })
				.setValue(this.store.state.pinColor).onChange(value => configure({ pinColor: value as ArrangeState['pinColor'] })));
		new Setting(modal.contentEl).setName('今天与日期提示颜色').setDesc('列表“今天”与详情日期共用；逾期仍为红色。')
			.addDropdown(dropdown => dropdown.addOptions({ vivid: '鲜亮蓝（默认）', electric: '电光蓝', cyan: '亮青蓝' })
				.setValue(this.store.state.dateHintColor).onChange(value => configure({ dateHintColor: value as ArrangeState['dateHintColor'] })));
		new Setting(modal.contentEl).setName('事项行分隔线')
			.addToggle(toggle => toggle.setValue(this.store.state.rowDividers).onChange(value => configure({ rowDividers: value })));
		new Setting(modal.contentEl).setName('今天达成筛选选中强调色').setDesc('仅改变选中底板与边框，不改变成就状态和统计。')
			.addDropdown(dropdown => dropdown.addOptions({ blue: '蓝色（默认）', purple: '紫色', gold: '金色' })
				.setValue(this.store.state.selectionColor).onChange(value => configure({ selectionColor: value as ArrangeState['selectionColor'] })));
		new Setting(modal.contentEl).setName('已完成事项外观')
			.addDropdown(dropdown => dropdown.addOptions({ background: '淡蓝底板、正常文字', text: '原底板、蓝色文字' })
				.setValue(this.store.state.completedStyle).onChange(value => configure({ completedStyle: value as ArrangeState['completedStyle'] })));
		new Setting(modal.contentEl).setName('无上级事项外观').setDesc('仅应用于真实上级为空的事项；不改变排序或钉住位置，已完成外观优先。')
			.addDropdown(dropdown => dropdown.addOptions({ background: '淡紫底板（默认）', text: '紫色文字', none: '普通样式' })
				.setValue(this.store.state.rootItemStyle).onChange(value => configure({ rootItemStyle: value as ArrangeState['rootItemStyle'] })));
		new Setting(modal.contentEl).setName('事项详情显示已完成下级')
			.addToggle(toggle => toggle.setValue(this.store.state.showCompletedChildren).onChange(value => configure({ showCompletedChildren: value })));
		new Setting(modal.contentEl).setName('事项左滑操作')
			.addDropdown(dropdown => dropdown.addOptions({ none: '无／关闭', ...Object.fromEntries(ARRANGE_ACTIONS.map(key => [key, actions[key].title])) })
				.setValue(this.store.state.swipeAction).onChange(value => configure({ swipeAction: value as ArrangeState['swipeAction'] })));
		new Setting(modal.contentEl).setName('详情到顶下拉关闭').setDesc('滚动到顶部并松手后，再向下拖动关闭；顶部抓取带不受此开关影响。')
			.addToggle(toggle => toggle.setValue(this.store.state.pullDownClose).onChange(value => configure({ pullDownClose: value })));
		new Setting(modal.contentEl).setName('详情面板顶部阴影范围').setDesc('0～40 像素，默认 24；0 为关闭阴影，可先试 12～16。')
			.addSlider(slider => slider.setLimits(0, 40, 1).setValue(this.store.state.detailShadow).setDynamicTooltip()
				.onChange(value => configure({ detailShadow: value })));
		new Setting(modal.contentEl).setName('空正文提示文字').setDesc('留空则不显示提示；只改变界面，不修改事项正文。')
			.addText(text => text.setValue(this.store.state.bodyPlaceholder).onChange(value => configure({ bodyPlaceholder: value })));
		for (const [key, name, initial] of [['composerMaxRows', '事项输入框最多行数', 6], ['bodyMinRows', '附注默认可见行数', 3]] as const) {
			new Setting(modal.contentEl).setName(name).setDesc(`正整数，默认 ${initial} 行。`)
				.addText(text => {
					text.inputEl.type = 'number'; text.inputEl.min = '1'; text.inputEl.step = '1';
					text.setValue(String(this.store.state[key])).onChange(raw => {
						const value = Number(raw), valid = Number.isSafeInteger(value) && value > 0;
						text.inputEl.setAttribute('aria-invalid', String(!valid));
						if (valid) configure({ [key]: value });
					});
				});
		}
		new Setting(modal.contentEl).setName('键盘上方留白').setDesc('输入区与键盘之间的留白（像素）；0 为贴紧，默认 7。键盘收起后保留系统安全区。')
			.addSlider(slider => slider.setLimits(0, 40, 1).setValue(this.store.state.keyboardGap).setDynamicTooltip()
				.onChange(value => configure({ keyboardGap: value })));
		new Setting(modal.contentEl).setName('提交箭头大小').setDesc('16～32 像素，默认 24；按钮外框大小保持不变。')
			.addSlider(slider => slider.setLimits(16, 32, 1).setValue(this.store.state.submitArrowSize).setDynamicTooltip()
				.onChange(value => configure({ submitArrowSize: value })));
		new Setting(modal.contentEl).setName('提交按钮颜色').setDesc('三档蓝色，均搭配白色箭头。')
			.addDropdown(dropdown => dropdown.addOptions({ classic: '深蓝（默认）', console: '亮蓝（网页控制台）', navy: '藏蓝' })
				.setValue(this.store.state.submitColor).onChange(value => configure({ submitColor: value as ArrangeState['submitColor'] })));
		new Setting(modal.contentEl).setName('松手后全屏阈值').setDesc('占底部输入区以上可用高度的百分比；默认 80%。')
			.addSlider(slider => slider.setLimits(55, 95, 5).setValue(this.store.state.fullscreenThreshold).setDynamicTooltip()
				.onChange(value => configure({ fullscreenThreshold: value })));
		for (const key of ARRANGE_ACTIONS) {
			new Setting(modal.contentEl).setName(`常驻${actions[key].title}`).addToggle(toggle => toggle.setValue(this.store.state.rowActions.includes(key)).onChange(value => {
				rowActions = rowActions.filter(action => action !== key);
				if (value) rowActions.push(key);
				configure({ rowActions: [...rowActions] });
			}));
		}
		modal.contentEl.createEl('p', { text: '列表始终只显示已勾选的快捷图标；所有操作均可从详情右侧更多进入。' });
		new Setting(modal.contentEl).setName('统一日界时区').setDesc('所有设备使用同一时区计算“今天”。')
			.addText(text => text.setValue(this.store.state.timezone).onChange(value => {
				try { new Intl.DateTimeFormat('en', { timeZone: value }); configure({ timezone: value }); } catch { /* Wait for a complete timezone. */ }
			}));
		modal.open();
	}
}
