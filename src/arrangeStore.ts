import { App, getFrontMatterInfo, parseYaml, stringifyYaml, TFile, TFolder } from 'obsidian';
import { createGvid } from './fileIdCore';
import { defaultArrangeState, moveInOrder, pendingOrder, SUBMIT_BLUE_COLORS, validParent, type ArrangeItem, type ArrangeState } from './arrangeCore';

export const ARRANGE_STATE_PATH = 'settings/gvkit/arrange.md';
const TODO = '安排/待执行';
const DONE = '安排/已完成';

function documentParts(source: string): { fields: Record<string, unknown>; body: string } {
	const info = getFrontMatterInfo(source);
	const parsed: unknown = info.exists ? parseYaml(info.frontmatter) : {};
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('事项属性格式不正确，请先在 Markdown 中修正');
	return { fields: parsed as Record<string, unknown>, body: source.slice(info.contentStart) };
}
function markdown(fields: Record<string, unknown>, body: string): string {
	return `---\n${stringifyYaml(fields)}---\n${body}`;
}

export class ArrangeStore {
	items: ArrangeItem[] = [];
	state = defaultArrangeState();
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private app: App) {}

	async load(): Promise<void> {
		const items: ArrangeItem[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith('安排/')) continue;
			const source = await this.app.vault.read(file);
			if (!getFrontMatterInfo(source).frontmatter.includes('gvkit_arrange')) continue;
			const { fields, body } = documentParts(source);
			if (fields.gvkit_arrange !== true) continue;
			if (typeof fields.gvid !== 'string') throw Error(`事项缺少 GVID：${file.basename}`);
			if (items.some(item => item.id === fields.gvid)) throw Error('事项 GVID 重复，请先修正重复身份');
			items.push({ id: fields.gvid, path: file.path,
				title: typeof fields.title === 'string' ? fields.title : file.basename, body,
				parent: typeof fields.parent === 'string' ? fields.parent : null,
				date: typeof fields.date === 'string' ? fields.date : null,
				completedAt: typeof fields.completed_at === 'string' ? fields.completed_at : null,
				pinned: fields.pinned === true });
		}
		let state = defaultArrangeState();
		const file = this.app.vault.getAbstractFileByPath(ARRANGE_STATE_PATH);
		if (file instanceof TFile) {
			const { fields } = documentParts(await this.app.vault.read(file));
			if (fields.gvkit_arrange_state !== 1) throw Error('安排配置版本不兼容');
			const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(x => typeof x === 'string');
			if (!strings(fields.order) || !strings(fields.achievedDays)) throw Error('安排顺序格式不正确');
			state.order = fields.order;
			state.achievedDays = fields.achievedDays;
			if (typeof fields.timezone === 'string') { new Intl.DateTimeFormat('en', { timeZone: fields.timezone }); state.timezone = fields.timezone; }
			if (typeof fields.fullscreenThreshold === 'number') state.fullscreenThreshold = Math.max(55, Math.min(95, fields.fullscreenThreshold));
			if (typeof fields.keyboardGap === 'number' && Number.isFinite(fields.keyboardGap))
				state.keyboardGap = Math.max(0, Math.min(40, Math.round(fields.keyboardGap)));
			if (typeof fields.submitArrowSize === 'number' && Number.isFinite(fields.submitArrowSize))
				state.submitArrowSize = Math.max(16, Math.min(32, Math.round(fields.submitArrowSize)));
			if (typeof fields.submitColor === 'string' && Object.keys(SUBMIT_BLUE_COLORS).includes(fields.submitColor))
				state.submitColor = fields.submitColor as ArrangeState['submitColor'];
			if (typeof fields.detailShadow === 'number' && Number.isFinite(fields.detailShadow))
				state.detailShadow = Math.max(0, Math.min(40, Math.round(fields.detailShadow)));
			if (typeof fields.bodyPlaceholder === 'string') state.bodyPlaceholder = fields.bodyPlaceholder;
			if (strings(fields.rowActions)) state.rowActions = fields.rowActions.filter((a): a is ArrangeState['rowActions'][number] => ['parent', 'date', 'top', 'pin'].includes(a));
		}
		state.order = pendingOrder(items, state.order);
		this.items = items;
		this.state = state;
	}

	private serial<T>(action: () => Promise<T>): Promise<T> {
		const next = this.queue.then(async () => { await this.load(); return action(); });
		this.queue = next.catch(() => {});
		return next;
	}
	private async requireFolder(path: string): Promise<void> {
		if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder))
			throw Error(`请先确认信息库已有目录「${path}」；插件不会改变一级、二级目录`);
	}
	private async saveState(): Promise<void> {
		await this.requireFolder('settings/gvkit');
		const file = this.app.vault.getAbstractFileByPath(ARRANGE_STATE_PATH);
		if (file instanceof TFile) {
			await this.app.vault.process(file, source => {
				const { fields, body } = documentParts(source);
				return markdown({ ...fields, ...this.state, gvkit_arrange_state: 1 }, body);
			});
		} else await this.app.vault.create(ARRANGE_STATE_PATH, markdown({ gvkit_arrange_state: 1, ...this.state }, '# 安排\n\n全局执行顺序、界面设置与每日基础投入确认。\n'));
	}
	private file(id: string): TFile {
		const item = this.items.find(item => item.id === id);
		const file = item && this.app.vault.getAbstractFileByPath(item.path);
		if (!(file instanceof TFile)) throw Error('事项已移动或删除，请刷新后重试');
		return file;
	}
	private async patch(id: string, changes: Record<string, unknown>, body?: string): Promise<void> {
		await this.app.vault.process(this.file(id), source => {
			const current = documentParts(source);
			return markdown({ ...current.fields, ...changes }, body ?? current.body);
		});
	}

	create(title: string, parent: string | null): Promise<string> {
		return this.serial(async () => {
			if (!title.trim()) throw Error('请填写事项');
			await this.requireFolder(TODO);
			await this.requireFolder('settings/gvkit');
			const id = createGvid();
			if (!validParent(this.items, id, parent)) throw Error('上级事项已不存在');
			this.state.order = moveInOrder(this.state.order, this.items, id);
			await this.saveState();
			await this.app.vault.create(`${TODO}/${id}.md`, markdown({ gvid: id, gvkit_arrange: true,
				title: title.trim(), parent, date: null, completed_at: null, pinned: false }, ''));
			await this.load();
			return id;
		});
	}
	edit(id: string, title: string, body: string, parent: string | null): Promise<void> {
		return this.serial(async () => {
			if (!title.trim()) throw Error('标题不能为空');
			if (!validParent(this.items, id, parent)) throw Error('不能将自己或自己的下级设为上级');
			await this.patch(id, { title: title.trim(), parent }, body);
			await this.load();
		});
	}
	complete(id: string, done: boolean): Promise<void> {
		return this.serial(async () => {
			const folder = done ? DONE : TODO;
			await this.requireFolder(folder);
			const item = this.items.find(item => item.id === id);
			if (!item || Boolean(item.completedAt) === done) return;
			const destination = `${folder}/${this.file(id).name}`;
			if (destination !== item.path && this.app.vault.getAbstractFileByPath(destination)) throw Error('目标目录已有同名文件，事项未改动');
			await this.patch(id, { completed_at: done ? new Date().toISOString() : null, pinned: false });
			const file = this.file(id);
			await this.app.fileManager.renameFile(file, `${folder}/${file.name}`);
			await this.load();
			await this.saveState();
		});
	}
	setDate(id: string, date: string | null): Promise<void> {
		return this.serial(async () => { await this.patch(id, { date }); await this.load(); });
	}
	togglePin(id: string): Promise<void> {
		return this.serial(async () => {
			const item = this.items.find(item => item.id === id);
			if (!item || item.completedAt) return;
			await this.patch(id, { pinned: !item.pinned }); await this.load();
		});
	}
	move(id: string, before?: string, after = false): Promise<void> {
		return this.serial(async () => {
			if (!this.state.order.includes(id)) return;
			this.state.order = moveInOrder(this.state.order, this.items, id, before, after);
			await this.saveState();
		});
	}
	configure(changes: Partial<Pick<ArrangeState, 'timezone' | 'fullscreenThreshold' | 'keyboardGap' | 'submitArrowSize' | 'submitColor' | 'detailShadow' | 'bodyPlaceholder' | 'rowActions'>>): Promise<void> {
		return this.serial(async () => { Object.assign(this.state, changes); await this.saveState(); });
	}
	setAchieved(day: string, achieved: boolean): Promise<void> {
		return this.serial(async () => {
			this.state.achievedDays = this.state.achievedDays.filter(value => value !== day);
			if (achieved) this.state.achievedDays.push(day);
			await this.saveState();
		});
	}
}
