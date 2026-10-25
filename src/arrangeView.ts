import { ItemView, MarkdownRenderer, Menu, Modal, Notice, Platform, Plugin, setIcon, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { dayKey, offsetDay, SUBMIT_BLUE_COLORS, todayFacts, validParent, type ArrangeItem, type ArrangeState, type RowAction } from './arrangeCore';
import { ARRANGE_STATE_PATH, ArrangeStore } from './arrangeStore';

export const ARRANGE_VIEW = 'gvkit-arrange';
const actions: Record<RowAction, { title: string; icon: string }> = {
	parent: { title: '查看上级', icon: 'corner-left-up' }, date: { title: '设置日期', icon: 'calendar' },
	top: { title: '置顶', icon: 'arrow-up-to-line' }, pin: { title: '钉住位置', icon: 'pin' },
};
function iconButton(parent: HTMLElement, label: string, icon: string, action: (event: MouseEvent) => void): HTMLButtonElement {
	const button = parent.createEl('button', { cls: 'gvkit-arrange-icon', attr: { type: 'button', 'aria-label': label, title: label } });
	setIcon(button, icon);
	button.addEventListener('click', event => { event.stopPropagation(); action(event); });
	return button;
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
	private selected: string | null = null;
	private filter: 'all' | 'today' | 'completed' | 'overdue' = 'all';
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
	private expanded = new Set<string>();
	private editing: { id: string; title: HTMLTextAreaElement; body: HTMLTextAreaElement; preview: HTMLElement; error: HTMLElement; savedTitle: string; savedBody: string; composing: boolean } | null = null;
	private editTimer: number | null = null;
	private savingEdit: Promise<boolean> | null = null;
	private timer: number | null = null;
	private today = '';
	private restoreHeader: (() => void) | null = null;
	private cancelReorder: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, store: ArrangeStore) { super(leaf); this.store = store; }
	getViewType(): string { return ARRANGE_VIEW; }
	getDisplayText(): string { return '自御安排'; }
	getIcon(): string { return 'list-checks'; }

	async onOpen(): Promise<void> {
		this.closed = false;
		const root = this.contentEl;
		root.empty();
		root.addClass('gvkit-arrange');
		root.toggleClass('gvkit-arrange-mobile', Platform.isMobileApp);
		const header = root.createDiv('gvkit-arrange-header');
		this.headline = header.createEl('button', { cls: 'gvkit-arrange-today' });
		this.headline.onclick = () => this.setFilter(this.filter === 'today' ? 'all' : 'today');
		iconButton(header, '安排更多', 'more-horizontal', event => this.headerMenu(event));
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
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void this.create(); }
		};
		this.registerDomEvent(root, 'keydown', event => { if (event.key === 'Escape') void this.select(null); });
		const refresh = () => {
			if (this.timer !== null) window.clearTimeout(this.timer);
			this.timer = window.setTimeout(() => { this.timer = null; if (!this.busy) void this.reload(); }, 180);
		};
		for (const name of ['create', 'modify', 'delete', 'rename'] as const) {
			this.registerEvent(this.app.vault.on(name as 'modify', file => {
				if (file.path.startsWith('安排/') || file.path === ARRANGE_STATE_PATH) refresh();
			}));
		}
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
			// Let only the input strip span the host's side insets; list/header stay put.
			composer.style.marginLeft = `-${css.paddingLeft}`;
			composer.style.marginRight = `-${css.paddingRight}`;
			root.classList.toggle('gvkit-arrange-keyboard-open', keyboard > 0);
			const visibleBottom = Math.min(viewport ? viewport.height + viewport.offsetTop : window.innerHeight,
				keyboard > 0 ? window.innerHeight - keyboard : Infinity);
			const overlap = Math.max(0, bottom - visibleBottom);
			if (keyboard > 0 || overlap > 0) {
				// Explicit zero must override the host CSS inset after it has resized.
				root.style.setProperty('padding-bottom', `${overlap}px`, keyboard > 0 ? 'important' : '');
			} else root.style.removeProperty('padding-bottom');
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
		this.cancelReorder?.();
		this.restoreHeader?.();
		this.contentEl.style.removeProperty('--gvkit-arrange-detail-shadow');
		this.contentEl.style.removeProperty('--gvkit-arrange-submit-size');
		this.contentEl.style.removeProperty('--gvkit-arrange-submit-color');
		this.keyboardBackdrop?.remove(); this.keyboardBackdrop = null;
		if (this.timer !== null) window.clearTimeout(this.timer);
		if (this.editTimer !== null) window.clearTimeout(this.editTimer);
		await this.saveEdit();
	}
	private async reload(): Promise<void> {
		try { await this.store.load(); if (!this.closed) { this.applyComposerSettings(); this.paintLists(); if (!this.keepEditor()) this.paintDetail(); } }
		catch (error) { this.error(error); }
	}
	private error(error: unknown): void { new Notice(error instanceof Error ? error.message : '安排操作未成功，请重试', 7000); }
	private applyComposerSettings(): void {
		this.contentEl.style.setProperty('--gvkit-arrange-keyboard-gap', `${this.store.state.keyboardGap}px`);
		this.contentEl.style.setProperty('--gvkit-arrange-submit-size', `${this.store.state.submitArrowSize}px`);
		this.contentEl.style.setProperty('--gvkit-arrange-submit-color', SUBMIT_BLUE_COLORS[this.store.state.submitColor]);
		this.contentEl.style.setProperty('--gvkit-arrange-detail-shadow', this.store.state.detailShadow === 0 ? 'none' : `0 -7px ${this.store.state.detailShadow ?? 24}px #0003`);
		const edit = this.editing;
		if (edit) {
			edit.body.placeholder = this.store.state.bodyPlaceholder;
			// Update only the empty hint; never replace an editor or its unsaved text.
			const hint = edit.preview.querySelector<HTMLElement>('.gvkit-arrange-body-placeholder');
			if (hint) hint.textContent = this.store.state.bodyPlaceholder;
		}
	}
	private updateComposer(): void {
		const empty = !this.input.value.trim();
		this.createButton.hidden = empty;
		this.createButton.disabled = this.busy || empty;
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
		const facts = todayFacts(this.store.items, this.store.state);
		this.today = facts.day;
		this.headline.empty();
		const statusIcon = this.headline.createSpan({ cls: 'gvkit-arrange-status-icon', attr: { 'aria-hidden': 'true' } });
		setIcon(statusIcon, facts.color === 'red' ? 'circle-alert' : facts.color === 'gold' ? 'trophy' : 'circle-check');
		this.headline.createSpan({ text: `今天达成 ${facts.x}/${facts.y}` });
		this.headline.setAttribute('aria-label', `今天达成 ${facts.x}/${facts.y}，今天必做剩余 ${facts.remaining} 项。点击切换必做筛选`);
		this.headline.dataset.color = facts.color;
		this.headline.setAttribute('aria-pressed', String(this.filter === 'today'));
		const scroll = this.list.scrollTop;
		this.list.empty();
		if (this.filter === 'completed' || this.filter === 'overdue') {
			const bar = this.list.createDiv('gvkit-arrange-scope');
			bar.createSpan({ text: this.filter === 'completed' ? '今天完成' : '逾期事项' });
			iconButton(bar, '返回全部事项', 'x', () => this.setFilter('all'));
		}
		let items = this.ordered();
		if (this.filter === 'today') items = items.filter(item => item.date === facts.day);
		if (this.filter === 'overdue') items = items.filter(item => item.date && item.date < facts.day);
		if (this.filter === 'completed') items = this.store.items.filter(item => item.completedAt && dayKey(new Date(item.completedAt), this.store.state.timezone) === facts.day)
			.sort((a, b) => b.completedAt!.localeCompare(a.completedAt!));
		for (const item of items) this.row(this.list, item);
		if (!items.length) this.list.createDiv({ cls: 'gvkit-arrange-empty', text: this.filter === 'all' ? '想到什么，就从下面记下来。' : '这里已经清空。' });
		this.list.scrollTop = scroll;
		if (this.children && this.selected) {
			this.children.empty();
			for (const item of this.ordered().filter(item => item.parent === this.selected)) this.row(this.children, item);
		}
	}
	private setFilter(filter: typeof this.filter): void {
		this.scrolls.set(this.filter, this.list.scrollTop);
		this.filter = filter;
		this.paintLists();
		this.list.scrollTop = this.scrolls.get(filter) ?? 0;
	}
	private row(parent: HTMLElement, item: ArrangeItem): void {
		const row = parent.createDiv('gvkit-arrange-row');
		row.dataset.id = item.id;
		row.toggleClass('is-selected', item.id === this.selected);
		row.toggleClass('is-pinned', item.pinned);
		const complete = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': `${item.completedAt ? '撤销完成' : '完成'}：${item.title}` } });
		complete.checked = Boolean(item.completedAt);
		complete.onclick = event => {
			event.stopPropagation(); complete.checked = Boolean(item.completedAt);
			void this.run(() => this.store.complete(item.id, !item.completedAt));
		};
		const label = row.createEl('button', { cls: 'gvkit-arrange-title', text: item.title, attr: { title: item.title } });
		label.onclick = () => { void this.select(this.selected === item.id ? null : item.id); };
		if (item.date) {
			label.dataset.date = item.date;
			label.title = `${item.title} · ${item.date}${item.date < this.today && !item.completedAt ? ' · 逾期' : ''}`;
			if (!item.completedAt && item.date < this.today) label.addClass('is-overdue');
		}
		const actionArea = row.createDiv('gvkit-arrange-actions');
		const visible = this.expanded.has(item.id) ? ['parent', 'date', 'top', 'pin'] as RowAction[] : this.store.state.rowActions;
		for (const key of visible) {
			if (key === 'parent' && !item.parent || (key === 'top' || key === 'pin') && item.completedAt) continue;
			const button = iconButton(actionArea, actions[key].title, actions[key].icon, event => this.action(key, item, event));
			if (key === 'pin' && item.pinned) button.addClass('is-active');
			if (key === 'date' && item.date) button.addClass('is-active');
		}
		iconButton(row, '事项更多', 'more-horizontal', event => this.itemMenu(item, event));
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
			let lastX = x, lastY = y;
			let target: HTMLElement | null = null;
			let after = false;
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
					if (Math.hypot(clientX - x, clientY - y) > 8) { moved = true; window.clearTimeout(timer); }
					return;
				}
				event.preventDefault();
				row.style.transform = `translateY(${clientY - y}px)`;
				target?.removeClass('is-drop-target');
				const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.gvkit-arrange-row');
				target = hit && hit !== row && hit.parentElement === row.parentElement ? hit : null;
				after = Boolean(target && clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2);
				target?.addClass('is-drop-target');
				if (target) target.dataset.dropAfter = String(after);
				const scroller = row.closest<HTMLElement>('.gvkit-arrange-detail-scroll') ?? this.list;
				const bounds = scroller.getBoundingClientRect();
				if (clientY < bounds.top + 32) scroller.scrollTop -= 14;
				if (clientY > bounds.bottom - 32) scroller.scrollTop += 14;
			};
			const end = (event: Event) => {
				const targetId = target?.dataset.id;
				if (dragging) event.preventDefault();
				cleanup();
				if (dragging && targetId) void this.run(() => this.store.move(item.id, targetId, after));
				else if (!dragging && x - lastX > 45 && Math.abs(y - lastY) < 28) {
					this.expanded.add(item.id); this.paintLists();
				}
			};
			const extraTouch = (e: TouchEvent) => { if (e.touches.length !== 1) cancel(); };
			const touchMove = (e: TouchEvent) => { const p = e.touches[0]; if (p && e.touches.length === 1) move(p.clientX, p.clientY, e); else cancel(); };
			const touchEnd = (e: TouchEvent) => { const p = e.changedTouches[0]; if (p) { lastX = p.clientX; lastY = p.clientY; } end(e); };
			const mouseMove = (e: PointerEvent) => move(e.clientX, e.clientY, e);
			const mouseEnd = (e: PointerEvent) => end(e);
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
	private action(key: RowAction, item: ArrangeItem, event: MouseEvent): void {
		if (key === 'parent' && item.parent) {
			void this.select(item.parent).then(() => {
				const row = this.children?.querySelector<HTMLElement>(`[data-id="${item.id}"]`);
				row?.scrollIntoView({ block: 'nearest' }); row?.addClass('is-located');
			});
		} else if (key === 'date') this.dateMenu(item, event);
		else if (key === 'top') void this.run(() => this.store.move(item.id)).then(() => this.reveal(item.id));
		else if (key === 'pin') void this.run(() => this.store.togglePin(item.id));
	}
	private reveal(id: string): void {
		const parent = this.selected ? this.children : this.list;
		parent?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
	}
	private itemMenu(item: ArrangeItem, event: MouseEvent): void {
		const menu = new Menu();
		for (const key of ['parent', 'date', 'top', 'pin'] as RowAction[]) {
			if (key === 'parent' && !item.parent || (key === 'top' || key === 'pin') && item.completedAt) continue;
			menu.addItem(entry => entry.setTitle(key === 'pin' && item.pinned ? '取消钉住' : actions[key].title).setIcon(actions[key].icon).onClick(() => this.action(key, item, event)));
		}
		menu.addItem(entry => entry.setTitle('修改上级').setIcon('corner-left-up').onClick(() => { void this.changeParent(item.id); }));
		menu.addItem(entry => entry.setTitle('打开 Markdown').setIcon('file-text').onClick(() => {
			const file = this.app.vault.getAbstractFileByPath(item.path);
			if (file instanceof TFile) void this.app.workspace.getLeaf('tab').openFile(file);
		}));
		menu.showAtMouseEvent(event);
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
		if (!(await this.saveEdit())) return;
		this.editing = null;
		this.selected = id;
		this.full = false;
		this.detail.style.height = '';
		this.detail.style.maxHeight = '';
		this.paintLists(); this.paintDetail();
	}
	private paintDetail(): void {
		const item = this.store.items.find(item => item.id === this.selected);
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
		const shortcuts = [...new Set<RowAction>([...(item.parent ? ['parent' as const] : []), ...this.store.state.rowActions])];
		for (const key of shortcuts) {
			if (key === 'parent' && !item.parent || (key === 'top' || key === 'pin') && item.completedAt) continue;
			const label = key === 'date' && item.date ? `日期：${item.date}` : actions[key].title;
			const button = iconButton(tools, label, actions[key].icon, event => this.action(key, item, event));
			button.toggleClass('is-active', key === 'date' && Boolean(item.date) || key === 'pin' && item.pinned);
		}
		iconButton(tools, '事项更多', 'more-horizontal', event => this.itemMenu(item, event));
		this.detailScroll = this.detail.createDiv('gvkit-arrange-detail-scroll');
		if (item.parent) {
			const parent = this.store.items.find(candidate => candidate.id === item.parent);
			if (parent) this.detailScroll.createDiv({ cls: 'gvkit-arrange-parent-name', text: parent.title, attr: { title: parent.title } });
		}
		const title = this.detailScroll.createEl('textarea', { cls: 'gvkit-arrange-detail-title', attr: { 'aria-label': '事项完整标题', rows: '1' } });
		title.value = item.title;
		const error = this.detailScroll.createDiv({ cls: 'gvkit-arrange-edit-error', attr: { role: 'status', 'aria-live': 'polite' } });
		error.hidden = true;
		const preview = this.detailScroll.createDiv({ cls: 'gvkit-arrange-body', attr: { tabindex: '0', 'aria-label': '编辑事项正文' } });
		const body = this.detailScroll.createEl('textarea', { cls: 'gvkit-arrange-inline-body', attr: { 'aria-label': '事项正文', rows: '1', placeholder: this.store.state.bodyPlaceholder } });
		body.value = item.body; body.hidden = true;
		const edit = this.editing = { id: item.id, title, body, preview, error, savedTitle: item.title, savedBody: item.body, composing: false as boolean };
		this.renderBody();
		const resize = (input: HTMLTextAreaElement) => { input.style.height = '0'; input.style.height = `${input.scrollHeight}px`; };
		resize(title);
		// Only the first focus places the caret at the end; later taps can position it normally.
		let titleFocused = false;
		title.onpointerdown = () => { titleFocused = document.activeElement === title; };
		title.onclick = () => { if (!titleFocused) title.setSelectionRange(title.value.length, title.value.length); };
		const openBody = () => {
			preview.hidden = true; body.hidden = false; resize(body); body.focus({ preventScroll: true });
			body.setSelectionRange(body.value.length, body.value.length);
		};
		preview.onclick = event => {
			if ((event.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
			openBody();
		};
		preview.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); openBody(); } };
		this.detailScroll.onclick = event => { if (event.target === this.detailScroll && !window.getSelection()?.toString()) openBody(); };
		for (const input of [title, body]) {
			input.addEventListener('compositionstart', () => { edit.composing = true; });
			input.addEventListener('compositionend', () => { edit.composing = false; this.scheduleEdit(); });
			input.oninput = () => { resize(input); error.hidden = true; title.removeAttribute('aria-invalid'); this.scheduleEdit(); };
			input.onblur = () => { void this.saveEdit().then(ok => {
				// Replacing preview text on title blur can swallow the click landing on it.
				if (ok && input === body && this.editing === edit && document.activeElement !== body) this.renderBody();
			}); };
		}
		this.children = this.detailScroll.createDiv('gvkit-arrange-children');
		for (const child of this.ordered().filter(child => child.parent === item.id)) this.row(this.children, child);
		this.detailScroll.scrollTop = scroll;
		this.fullscreenPull(this.detailScroll);
	}
	private panelGesture(grip: HTMLElement): void {
		grip.onpointerdown = event => {
			if (!Platform.isMobileApp) return;
			event.preventDefault(); grip.setPointerCapture(event.pointerId);
			const startY = event.clientY, startHeight = this.detail.getBoundingClientRect().height;
			const available = this.area.getBoundingClientRect().height;
			let height = startHeight;
			this.detail.style.maxHeight = '100%';
			const move = (e: PointerEvent) => {
				height = Math.min(available, Math.max(90, startHeight + startY - e.clientY));
				this.detail.style.height = `${height}px`;
			};
			const end = (e: PointerEvent) => {
				grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end);
				if (e.type === 'pointercancel') { this.detail.style.height = ''; this.detail.style.maxHeight = ''; return; }
				this.full = height / available * 100 >= this.store.state.fullscreenThreshold;
				this.detail.toggleClass('is-full', this.full);
				if (this.full) this.detail.style.height = '100%';
			};
			grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
		};
	}
	private fullscreenPull(scroll: HTMLElement): void {
		let start: { x: number; y: number } | null = null;
		scroll.addEventListener('touchstart', event => {
			const p = event.touches[0];
			start = this.full && scroll.scrollTop <= 0 && p && !(event.target as HTMLElement).closest('button,input,textarea,a') ? { x: p.clientX, y: p.clientY } : null;
		}, { passive: true });
		scroll.addEventListener('touchend', event => {
			const p = event.changedTouches[0];
			if (start && p && scroll.scrollTop <= 0 && p.clientY - start.y > 90 && Math.abs(p.clientX - start.x) < 35) void this.select(null);
			start = null;
		}, { passive: true });
	}
	private async changeParent(id: string): Promise<void> {
		if (!(await this.saveEdit())) return;
		const item = this.store.items.find(item => item.id === id);
		if (!item) return;
		const modal = new Modal(this.app); modal.setTitle('修改上级');
		const parent = modal.contentEl.createEl('select', { attr: { 'aria-label': '上级事项' } });
		Object.assign(parent.style, { width: '100%', fontSize: '16px' });
		parent.createEl('option', { value: '', text: '无上级' });
		for (const candidate of this.store.items.filter(candidate => validParent(this.store.items, item.id, candidate.id)))
			parent.createEl('option', { value: candidate.id, text: candidate.title });
		parent.value = item.parent ?? '';
		new Setting(modal.contentEl).addButton(button => button.setButtonText('完成').setCta().onClick(async () => {
			const current = this.store.items.find(item => item.id === id);
			if (current && await this.run(() => this.store.edit(id, current.title, current.body, parent.value || null))) modal.close();
		}));
		modal.open();
	}
	private keepEditor(): boolean {
		const edit = this.editing;
		return Boolean(edit && (edit.title.value !== edit.savedTitle || edit.body.value !== edit.savedBody
			|| edit.composing || document.activeElement === edit.title || document.activeElement === edit.body));
	}
	private renderBody(): void {
		const edit = this.editing;
		if (!edit) return;
		edit.body.hidden = true; edit.preview.hidden = false; edit.preview.empty();
		if (edit.body.value) {
			const item = this.store.items.find(item => item.id === edit.id);
			void MarkdownRenderer.render(this.app, edit.body.value, edit.preview, item?.path ?? '', this);
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
		menu.addItem(item => item.setTitle('今天完成明细').setIcon('check-check').onClick(() => this.setFilter('completed')));
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
		let rowActions = [...this.store.state.rowActions];
		const configure = (changes: Parameters<ArrangeStore['configure']>[0]) => {
			void this.store.configure(changes).then(() => { this.applyComposerSettings(); this.paintLists(); }).catch(error => this.error(error));
		};
		new Setting(modal.contentEl).setName('详情面板顶部阴影范围').setDesc('0～40 像素，默认 24；0 为关闭阴影，可先试 12～16。')
			.addSlider(slider => slider.setLimits(0, 40, 1).setValue(this.store.state.detailShadow).setDynamicTooltip()
				.onChange(value => configure({ detailShadow: value })));
		new Setting(modal.contentEl).setName('空正文提示文字').setDesc('留空则不显示提示；只改变界面，不修改事项正文。')
			.addText(text => text.setValue(this.store.state.bodyPlaceholder).onChange(value => configure({ bodyPlaceholder: value })));
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
		for (const key of ['parent', 'date', 'top', 'pin'] as RowAction[]) {
			new Setting(modal.contentEl).setName(`常驻${actions[key].title}`).addToggle(toggle => toggle.setValue(this.store.state.rowActions.includes(key)).onChange(value => {
				rowActions = rowActions.filter(action => action !== key);
				if (value) rowActions.push(key);
				configure({ rowActions: [...rowActions] });
			}));
		}
		modal.contentEl.createEl('p', { text: '更多始终在最右侧。未常驻的操作仍可从左滑或更多进入。' });
		new Setting(modal.contentEl).setName('统一日界时区').setDesc('所有设备使用同一时区计算“今天”。')
			.addText(text => text.setValue(this.store.state.timezone).onChange(value => {
				try { new Intl.DateTimeFormat('en', { timeZone: value }); configure({ timezone: value }); } catch { /* Wait for a complete timezone. */ }
			}));
		modal.open();
	}
}
