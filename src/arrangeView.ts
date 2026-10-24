import { ItemView, MarkdownRenderer, Menu, Modal, Notice, Platform, Plugin, setIcon, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { dayKey, offsetDay, todayFacts, validParent, type ArrangeItem, type RowAction } from './arrangeCore';
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
	const open = async () => {
		const leaf = plugin.app.workspace.getLeavesOfType(ARRANGE_VIEW)[0] ?? plugin.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: ARRANGE_VIEW, active: true });
		await plugin.app.workspace.revealLeaf(leaf);
	};
	plugin.addCommand({ id: 'open-arrange', name: '打开自御安排', callback: () => { void open(); } });
	plugin.addRibbonIcon('list-checks', '自御安排', () => { void open(); });
	plugin.registerObsidianProtocolHandler('gvkit-arrange', () => {
		plugin.app.workspace.onLayoutReady(() => { void open(); });
	});
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
	private headline!: HTMLButtonElement;
	private full = false;
	private busy = false;
	private closed = false;
	private expanded = new Set<string>();
	private editing: { id: string; title: HTMLTextAreaElement; body: HTMLTextAreaElement; parent: HTMLSelectElement } | null = null;
	private timer: number | null = null;
	private today = '';

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
		this.area = root.createDiv('gvkit-arrange-area');
		this.list = this.area.createDiv('gvkit-arrange-list');
		this.list.setAttribute('aria-label', '事项列表');
		this.detail = this.area.createDiv('gvkit-arrange-detail');
		this.detail.hidden = true;
		const composer = root.createDiv('gvkit-arrange-composer');
		this.input = composer.createEl('textarea', { attr: { rows: '1', placeholder: '想到就记…', 'aria-label': '新增事项' } });
		this.createButton = iconButton(composer, '创建事项', 'arrow-up', () => { void this.create(); });
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
		this.registerDomEvent(document, 'visibilitychange', () => { if (!document.hidden) void this.reload(); });
		// Keep the one composer inside the visible WebView when iOS opens its keyboard.
		const fit = () => {
			const viewport = window.visualViewport;
			const bottom = root.getBoundingClientRect().bottom;
			const overlap = viewport ? Math.max(0, bottom - viewport.height - viewport.offsetTop) : 0;
			root.style.paddingBottom = overlap > 0 ? `${overlap}px` : '';
		};
		if (window.visualViewport) {
			const viewport = window.visualViewport;
			viewport.addEventListener('resize', fit);
			viewport.addEventListener('scroll', fit);
			this.register(() => { viewport.removeEventListener('resize', fit); viewport.removeEventListener('scroll', fit); });
		}
		await this.reload();
	}
	async onClose(): Promise<void> {
		this.closed = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		await this.saveEdit();
	}
	private async reload(): Promise<void> {
		try { await this.store.load(); if (!this.closed) { this.paintLists(); if (!this.editing) this.paintDetail(); } }
		catch (error) { this.error(error); }
	}
	private error(error: unknown): void { new Notice(error instanceof Error ? error.message : '安排操作未成功，请重试', 7000); }
	private async run(action: () => Promise<unknown>): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		this.createButton.disabled = true;
		try { await action(); this.paintLists(); if (!this.editing) this.paintDetail(); return true; }
		catch (error) { this.error(error); await this.reload(); return false; }
		finally { this.busy = false; this.createButton.disabled = false; }
	}
	private ordered(): ArrangeItem[] {
		const byId = new Map(this.store.items.map(item => [item.id, item]));
		return this.store.state.order.map(id => byId.get(id)).filter((item): item is ArrangeItem => Boolean(item));
	}
	private paintLists(): void {
		if (!this.headline || this.closed) return;
		const facts = todayFacts(this.store.items, this.store.state);
		this.today = facts.day;
		this.headline.empty();
		this.headline.createSpan({ text: `今天达成 ${facts.x}/${facts.y}` });
		this.headline.createEl('small', { text: `今日尚有 ${facts.remaining} 项必做` });
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
		if (!item.completedAt) {
			const handle = iconButton(row, item.pinned ? '已钉住，先取消钉住再排序' : '拖动排序', 'grip-vertical', () => {});
			handle.addClass('gvkit-arrange-grip');
			this.reorderHandle(handle, row, item);
		}
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
		let x = 0, y = 0;
		row.addEventListener('touchstart', event => { const p = event.touches[0]; if (p) { x = p.clientX; y = p.clientY; } }, { passive: true });
		row.addEventListener('touchend', event => {
			const p = event.changedTouches[0];
			if (p && x - p.clientX > 45 && Math.abs(y - p.clientY) < 28) {
				this.expanded.add(item.id); this.paintLists();
			}
		}, { passive: true });
	}
	private reorderHandle(handle: HTMLButtonElement, row: HTMLElement, item: ArrangeItem): void {
		handle.addEventListener('pointerdown', event => {
			if (item.pinned || this.busy || event.button !== 0) return;
			event.preventDefault(); event.stopPropagation();
			handle.setPointerCapture(event.pointerId);
			row.addClass('is-dragging');
			let target: HTMLElement | null = null;
			let after = false;
			const move = (e: PointerEvent) => {
				target?.removeClass('is-drop-target');
				const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.gvkit-arrange-row');
				target = hit && hit !== row && hit.parentElement === row.parentElement ? hit : null;
				after = Boolean(target && e.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2);
				target?.addClass('is-drop-target');
				if (target) target.dataset.dropAfter = String(after);
				const scroller = row.closest<HTMLElement>('.gvkit-arrange-detail-scroll') ?? this.list;
				const bounds = scroller.getBoundingClientRect();
				if (e.clientY < bounds.top + 32) scroller.scrollTop -= 14;
				if (e.clientY > bounds.bottom - 32) scroller.scrollTop += 14;
			};
			const end = (e: PointerEvent) => {
				handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
				row.removeClass('is-dragging'); target?.removeClass('is-drop-target');
				if (e.type === 'pointerup' && target?.dataset.id) void this.run(() => this.store.move(item.id, target!.dataset.id, after));
			};
			handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
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
		menu.addItem(entry => entry.setTitle('编辑标题、正文与归属').setIcon('pencil').onClick(() => { void this.select(item.id).then(() => this.edit(item)); }));
		menu.addItem(entry => entry.setTitle('打开 Markdown').setIcon('file-text').onClick(() => {
			const file = this.app.vault.getAbstractFileByPath(item.path);
			if (file instanceof TFile) void this.app.workspace.getLeaf('tab').openFile(file);
		}));
		menu.showAtMouseEvent(event);
	}
	private dateMenu(item: ArrangeItem, event: MouseEvent): void {
		const day = todayFacts(this.store.items, this.store.state).day;
		const menu = new Menu();
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
		this.selected = id;
		this.full = false;
		this.detail.style.height = '';
		this.detail.style.maxHeight = '';
		this.paintLists(); this.paintDetail();
	}
	private paintDetail(): void {
		const item = this.store.items.find(item => item.id === this.selected);
		if (!item) { this.selected = null; this.detail.hidden = true; return; }
		const scroll = this.detailScroll?.scrollTop ?? 0;
		this.detail.hidden = false;
		this.detail.toggleClass('is-full', this.full);
		this.detail.empty();
		const grip = this.detail.createDiv('gvkit-arrange-panel-grip');
		grip.setAttribute('aria-label', '拖动调整详情高度');
		this.panelGesture(grip);
		const tools = this.detail.createDiv('gvkit-arrange-detail-tools');
		iconButton(tools, '返回主列表', 'arrow-left', () => { void this.select(null); });
		if (item.parent) iconButton(tools, '查看上级', 'corner-left-up', event => this.action('parent', item, event));
		iconButton(tools, '编辑事项', 'pencil', () => this.edit(item));
		iconButton(tools, '事项更多', 'more-horizontal', event => this.itemMenu(item, event));
		this.detailScroll = this.detail.createDiv('gvkit-arrange-detail-scroll');
		this.detailScroll.createEl('h2', { text: item.title, cls: 'gvkit-arrange-detail-title' });
		if (item.date) this.detailScroll.createEl('button', { text: item.date, cls: 'gvkit-arrange-date' }).onclick = event => this.dateMenu(item, event);
		const body = this.detailScroll.createDiv('gvkit-arrange-body');
		void MarkdownRenderer.render(this.app, item.body, body, item.path, this);
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
	private edit(item: ArrangeItem): void {
		if (this.editing) return;
		this.detailScroll.empty();
		const title = this.detailScroll.createEl('textarea', { cls: 'gvkit-arrange-edit-title', value: item.title, attr: { 'aria-label': '事项完整标题', rows: '2' } });
		const body = this.detailScroll.createEl('textarea', { cls: 'gvkit-arrange-edit-body', value: item.body, attr: { 'aria-label': '事项正文', placeholder: '自由记录正文、链接、思路…', rows: '5' } });
		const parent = this.detailScroll.createEl('select', { attr: { 'aria-label': '上级事项' } });
		parent.createEl('option', { value: '', text: '无上级' });
		for (const candidate of this.store.items.filter(candidate => validParent(this.store.items, item.id, candidate.id)))
			parent.createEl('option', { value: candidate.id, text: candidate.title });
		parent.value = item.parent ?? '';
		this.editing = { id: item.id, title, body, parent };
		const buttons = this.detailScroll.createDiv('gvkit-arrange-edit-buttons');
		buttons.createEl('button', { text: '保存' }).onclick = () => { void this.saveEdit(); };
		buttons.createEl('button', { text: '取消' }).onclick = () => { this.editing = null; this.paintDetail(); };
	}
	private async saveEdit(): Promise<boolean> {
		const edit = this.editing;
		if (!edit) return true;
		const ok = await this.run(() => this.store.edit(edit.id, edit.title.value, edit.body.value, edit.parent.value || null));
		if (ok) { this.editing = null; if (!this.closed) this.paintDetail(); }
		return ok;
	}
	private async create(): Promise<void> {
		const draft = this.input.value;
		if (!draft.trim()) return;
		const parent = this.selected;
		let id: string | undefined;
		if (await this.run(async () => { id = await this.store.create(draft, parent); })) {
			if (this.input.value === draft) this.input.value = '';
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
			void this.store.configure(changes).then(() => this.paintLists()).catch(error => this.error(error));
		};
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
