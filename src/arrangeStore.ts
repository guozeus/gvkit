import { rewardRecord, rewardValue, type RewardRecord } from './arrangeRewards';
import { App, getFrontMatterInfo, parseYaml, stringifyYaml, TFile, TFolder } from 'obsidian';
import { createGvid } from './fileIdCore';
import { ArrangeTrace, configFingerprint } from './arrangeTrace';
import { ARRANGE_ACTIONS, ARRANGE_FREE_SIZES, ARRANGE_NUMBER_SETTINGS, COMPLETION_SOUNDS, DATE_HINT_COLORS, dayKey, defaultArrangeState, moveInOrder, pendingOrder, SUBMIT_BLUE_COLORS, todayFacts, validParent, type ArrangeItem, type ArrangeState } from './arrangeCore';

export const ARRANGE_STATE_PATH = 'settings/gvkit/arrange.md';
const TODO = '安排/待执行';
const DONE = '安排/已完成';
const HISTORY = '安排/历史';

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
	rewards: RewardRecord[] = [];
	state = defaultArrangeState();
	archivedDailyGoalCompletedAt: string | null = null;
	private archivedCompletions: string[] = [];
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private app: App, readonly trace?: ArrangeTrace) {}

	async load(trigger = 'direct'): Promise<void> {
		const run = this.trace?.nextRun() ?? 0;
		const context = { run, stage: 'start' };
		this.trace?.record('load.start', { run, trigger });
		try {
			await this.loadInner(context);
			this.trace?.record('load.ok', { run });
		} catch (error) {
			this.trace?.failure('load.fail', error, { run, trigger, stage: context.stage });
			throw error;
		}
	}

	private async loadInner(context: { run: number; stage: string }): Promise<void> {
		let state = defaultArrangeState();
		const file = this.app.vault.getAbstractFileByPath(ARRANGE_STATE_PATH);
		if (file instanceof TFile) {
			context.stage = 'read_config';
			this.trace?.record('config.read.start', { run: context.run, mtime: file.stat?.mtime, size: file.stat?.size });
			const source = await this.app.vault.read(file);
			this.trace?.record('config.read.ok', { run: context.run, ...configFingerprint(source) });
			context.stage = 'parse_config';
			this.trace?.record('config.parse.start', { run: context.run });
			const { fields } = documentParts(source);
			this.trace?.record('config.parse.ok', { run: context.run });
			context.stage = 'validate_config';
			if (fields.gvkit_arrange_state !== 1) throw Error('安排配置版本不兼容');
			const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(x => typeof x === 'string');
			if (!strings(fields.order) || !strings(fields.achievedDays)) throw Error('安排顺序格式不正确');
			state.order = fields.order;
			if (typeof fields.rewardsEnabledAt === 'string' && Number.isFinite(Date.parse(fields.rewardsEnabledAt))) state.rewardsEnabledAt = fields.rewardsEnabledAt;
			state.achievedDays = fields.achievedDays;
			const goal = fields.dailyGoal as ArrangeState['dailyGoal'];
			if (goal && typeof goal.day === 'string' && (typeof goal.id === 'string' || goal.id === null)) {
				state.dailyGoal = { day: goal.day, id: goal.id };
				if (typeof goal.returnedId === 'string') state.dailyGoal.returnedId = goal.returnedId;
			}
			if (typeof fields.tips === 'string') state.tips = fields.tips;
			if (typeof fields.tipsProbability === 'number' && Number.isFinite(fields.tipsProbability))
				state.tipsProbability = Math.max(0, Math.min(100, fields.tipsProbability));
			for (const key of ['tipsTextColor', 'tipsBackgroundColor'] as const) {
				const value = fields[key];
				if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) state[key] = value;
			}
			for (const key of ['tipsScrollSpeed', 'tipsInterval'] as const) {
				const value = fields[key];
				if (typeof value === 'number' && Number.isFinite(value) && value > 0) state[key] = value;
			}
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
			for (const key of ['composerMaxRows', 'bodyMinRows'] as const) {
				const value = fields[key];
				if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) state[key] = value;
			}
			if (fields.completedStyle === 'background' || fields.completedStyle === 'text') state.completedStyle = fields.completedStyle;
			if (fields.rootItemStyle === 'background' || fields.rootItemStyle === 'text' || fields.rootItemStyle === 'none') state.rootItemStyle = fields.rootItemStyle;
			if (typeof fields.completionSound === 'string' && Object.keys(COMPLETION_SOUNDS).includes(fields.completionSound))
				state.completionSound = fields.completionSound as ArrangeState['completionSound'];
			for (const key of ['rowActions', 'detailActions'] as const) {
				const value = fields[key];
				if (strings(value)) state[key] = value.filter((a): a is ArrangeState['rowActions'][number] => (ARRANGE_ACTIONS as readonly string[]).includes(a));
			}
			if (typeof fields.showCompletedChildren === 'boolean') state.showCompletedChildren = fields.showCompletedChildren;
			if (fields.swipeAction === 'none' || (ARRANGE_ACTIONS as readonly unknown[]).includes(fields.swipeAction))
				state.swipeAction = fields.swipeAction as ArrangeState['swipeAction'];
			if (typeof fields.pullDownClose === 'boolean') state.pullDownClose = fields.pullDownClose;
			for (const key of Object.keys(ARRANGE_NUMBER_SETTINGS) as (keyof typeof ARRANGE_NUMBER_SETTINGS)[]) {
				const value = fields[key], [min, max] = ARRANGE_NUMBER_SETTINGS[key];
				if (typeof value === 'number' && Number.isFinite(value)) state[key] = Math.max(min, Math.min(max, Math.round(value)));
			}
			for (const key of Object.keys(ARRANGE_FREE_SIZES) as (keyof typeof ARRANGE_FREE_SIZES)[]) {
				const value = fields[key];
				if (typeof value === 'number' && Number.isFinite(value) && value >= 0) state[key] = value;
			}
			if (typeof fields.rowDividers === 'boolean') state.rowDividers = fields.rowDividers;
			if (fields.selectionColor === 'blue' || fields.selectionColor === 'purple' || fields.selectionColor === 'gold') state.selectionColor = fields.selectionColor;
			if (fields.pinColor === 'gold' || fields.pinColor === 'purple' || fields.pinColor === 'blue') state.pinColor = fields.pinColor;
			if (typeof fields.dateHintColor === 'string' && Object.keys(DATE_HINT_COLORS).includes(fields.dateHintColor))
				state.dateHintColor = fields.dateHintColor as ArrangeState['dateHintColor'];
		} else this.trace?.record('config.missing', { run: context.run });
		context.stage = 'scan_items';
		const items: ArrangeItem[] = [], archivedCompletions: string[] = [];
		const rewards: RewardRecord[] = [];
		let archivedDailyGoalCompletedAt: string | null = null;
		const today = dayKey(new Date(), state.timezone);
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.path.startsWith(`${HISTORY}/`)) {
				// The index may lag a just-completed/undone note. Today's modified
				// files need their real fields; mtime selects reads, never counts completions.
				let fields = this.app.metadataCache?.getFileCache(file)?.frontmatter;
				const changedToday = file.stat && dayKey(new Date(file.stat.mtime), state.timezone) === today;
				const rewardHistory = state.rewardsEnabledAt && (!file.stat || file.stat.mtime >= Date.parse(state.rewardsEnabledAt));
				const currentMonth = file.path.startsWith(`${HISTORY}/${today.slice(0, 4)}/${today.slice(5, 7)}/`);
				if (changedToday || (!fields && (currentMonth || rewardHistory))) {
					const source = await this.app.vault.read(file);
					fields = getFrontMatterInfo(source).frontmatter.includes('gvkit_arrange') ? documentParts(source).fields : undefined;
				}
				const record = fields && rewardRecord(fields);
				if (record) rewards.push(record);
				const completed = fields?.completed_at;
				if (fields?.gvkit_arrange === true && typeof completed === 'string' && Number.isFinite(Date.parse(completed))
					&& dayKey(new Date(completed), state.timezone) === today) {
					archivedCompletions.push(completed);
					if (state.dailyGoal?.day === today && fields.gvid === state.dailyGoal.id) archivedDailyGoalCompletedAt = completed;
				}
				continue;
			}
			if (!file.path.startsWith(`${TODO}/`) && !file.path.startsWith(`${DONE}/`)) continue;
			const source = await this.app.vault.read(file);
			if (!getFrontMatterInfo(source).frontmatter.includes('gvkit_arrange')) continue;
			const { fields, body } = documentParts(source);
			if (fields.gvkit_arrange !== true) continue;
			const record = rewardRecord(fields);
			if (record) rewards.push(record);
			if (typeof fields.gvid !== 'string') throw Error(`事项缺少 GVID：${file.basename}`);
			if (items.some(item => item.id === fields.gvid)) throw Error('事项 GVID 重复，请先修正重复身份');
			items.push({ id: fields.gvid, path: file.path,
				title: typeof fields.title === 'string' ? fields.title : file.basename, body,
				parent: typeof fields.parent === 'string' ? fields.parent : null,
				date: typeof fields.date === 'string' ? fields.date : null,
				completedAt: typeof fields.completed_at === 'string' ? fields.completed_at : null,
				rewardPoints: rewardValue(fields.reward_points),
				pinned: fields.pinned === true, developmentCompleted: fields.development_completed === true,
				developmentProject: fields.development_project === true });
		}
		this.rewards = rewards;
		state.order = pendingOrder(items, state.order);
		this.items = items;
		this.state = state;
		this.archivedCompletions = archivedCompletions;
		this.archivedDailyGoalCompletedAt = archivedDailyGoalCompletedAt;
		if (state.dailyGoal && state.dailyGoal.day < today) {
			context.stage = 'day_rollover';
			this.trace?.record('day_rollover.start', { run: context.run, trigger: 'dailyGoal_day_changed' });
			const previous = items.find(item => item.id === state.dailyGoal!.id);
			if (previous && !previous.completedAt) {
				// This explicit daily return is an insertion at the very front, not
				// ordinary top. All other items keep their relative order and pins;
				// subsequent ordinary moves protect their resulting global slots.
				state.order = [previous.id, ...state.order.filter(id => id !== previous.id)];
				state.dailyGoal = { day: today, id: null, returnedId: previous.id };
			} else state.dailyGoal = null;
			await this.saveState('day_rollover');
			this.trace?.record('day_rollover.ok', { run: context.run });
		}
		context.stage = 'done';
	}
	facts() { return todayFacts(this.items, this.state, new Date(), this.archivedCompletions); }

	private serial<T>(trigger: string, action: () => Promise<T>): Promise<T> {
		const next = this.queue.then(async () => { await this.load('before_' + trigger); return action(); });
		this.queue = next.catch(() => {});
		return next;
	}
	private async requireFolder(path: string): Promise<void> {
		if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder))
			throw Error(`请先确认信息库已有目录「${path}」；插件不会改变一级、二级目录`);
	}
	private async saveState(trigger = 'internal'): Promise<void> {
		const run = this.trace?.nextRun() ?? 0;
		let stage = 'folder_check';
		this.trace?.record('save.start', { run, trigger });
		try {
			await this.requireFolder('settings/gvkit');
			stage = 'lookup_config';
			const file = this.app.vault.getAbstractFileByPath(ARRANGE_STATE_PATH);
			if (file instanceof TFile) {
				stage = 'vault_process';
				await this.app.vault.process(file, source => {
					this.trace?.record('save.process.source', { run, ...configFingerprint(source) });
					stage = 'parse_config_before_write';
					this.trace?.record('save.parse.start', { run });
					const { fields, body } = documentParts(source);
					this.trace?.record('save.parse.ok', { run });
					stage = 'serialize_config';
					const next = markdown({ ...fields, ...this.state, gvkit_arrange_state: 1 }, body);
					this.trace?.record('save.proposed', { run, ...configFingerprint(next) });
					stage = 'vault_process_commit';
					return next;
				});
			} else {
				stage = 'create_config';
				const next = markdown({ gvkit_arrange_state: 1, ...this.state }, '# 安排\n\n全局执行顺序、界面设置与每日基础投入确认。\n');
				this.trace?.record('save.proposed', { run, ...configFingerprint(next) });
				await this.app.vault.create(ARRANGE_STATE_PATH, next);
			}
			this.trace?.record('save.ok', { run, trigger, stage: 'vault_committed' });
		} catch (error) {
			this.trace?.failure('save.fail', error, { run, trigger, stage });
			throw error;
		}
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

	create(title: string, parent: string | null, date: string | null = null): Promise<string> {
		return this.serial('create', async () => {
			if (!title.trim()) throw Error('请填写事项');
			await this.requireFolder(TODO);
			await this.requireFolder('settings/gvkit');
			const id = createGvid();
			if (!validParent(this.items, id, parent)) throw Error('上级事项已不存在');
			this.state.order = moveInOrder(this.state.order, this.items, id);
			await this.saveState('create');
			await this.app.vault.create(`${TODO}/${id}.md`, markdown({ gvid: id, gvkit_arrange: true,
				title: title.trim(), parent, date, completed_at: null, pinned: false }, ''));
			await this.load();
			return id;
		});
	}
	edit(id: string, title: string, body: string, parent: string | null): Promise<void> {
		return this.serial('edit', async () => {
			if (!title.trim()) throw Error('标题不能为空');
			if (!validParent(this.items, id, parent)) throw Error('不能将自己或自己的下级设为上级');
			await this.patch(id, { title: title.trim(), parent }, body);
			await this.load();
		});
	}
	setParent(id: string, parent: string | null): Promise<void> {
		return this.serial('setParent', async () => {
			if (!validParent(this.items, id, parent)) throw Error('不能将自己或自己的下级设为上级');
			await this.patch(id, { parent });
			await this.load();
		});
	}
	complete(id: string, done: boolean): Promise<boolean> {
		return this.serial('complete', async () => {
			const folder = done ? DONE : TODO;
			await this.requireFolder(folder);
			const item = this.items.find(item => item.id === id);
			if (!item || Boolean(item.completedAt) === done) return false;
			if (done) {
				const parents = [id], visited = new Set(parents);
				for (const parent of parents) {
					for (const child of this.items.filter(value => value.parent === parent)) {
						if (visited.has(child.id)) continue;
						if (!child.completedAt) throw Error('需先完成所有下级事项');
						visited.add(child.id); parents.push(child.id);
					}
				}
			}
			const destination = `${folder}/${this.file(id).name}`;
			if (destination !== item.path && this.app.vault.getAbstractFileByPath(destination)) throw Error('目标目录已有同名文件，事项未改动');
			if (done && !this.state.rewardsEnabledAt) {
				this.state.rewardsEnabledAt = new Date().toISOString();
				await this.saveState('complete_enable_rewards');
			}
			const completedAt = done ? new Date().toISOString() : null;
			await this.patch(id, { completed_at: completedAt, pinned: false,
				reward_completed_at: completedAt, reward_awarded: done ? rewardValue(item.rewardPoints) : null });
			const file = this.file(id);
			await this.app.fileManager.renameFile(file, `${folder}/${file.name}`);
			await this.load();
			await this.saveState('complete');
			return true;
		});
	}
 enableRewards(): Promise<void> {
  return this.serial('enableRewards', async () => {
   if (!this.state.rewardsEnabledAt) { this.state.rewardsEnabledAt = new Date().toISOString(); await this.saveState('enable_rewards'); }
  });
 }
 setReward(id: string, points: number): Promise<void> {
  return this.serial('setReward', async () => {
   if (![0, 1, 2, 3, 5, 8].includes(points)) throw Error('请选择奖励点数');
   await this.app.vault.process(this.file(id), source => {
    const { fields, body } = documentParts(source);
    // Correct only this explicit award. Old completed notes are never backfilled.
    const changes = rewardRecord(fields) ? { reward_awarded: points } : {};
    return markdown({ ...fields, reward_points: points, ...changes }, body);
   });
   await this.load();
  });
 }

	setDate(id: string, date: string | null): Promise<void> {
		return this.serial('setDate', async () => { await this.patch(id, { date }); await this.load(); });
	}
	setDailyGoal(id: string): Promise<void> {
		return this.serial('setDailyGoal', async () => {
			const item = this.items.find(item => item.id === id);
			const day = dayKey(new Date(), this.state.timezone);
			if (!item || (item.completedAt && dayKey(new Date(item.completedAt), this.state.timezone) !== day))
				throw Error('请选择未完成或今天完成的事项');
			await this.patch(id, { date: day });
			this.state.dailyGoal = { ...this.state.dailyGoal, day, id };
			await this.saveState('set_daily_goal');
			await this.load();
		});
	}
	archive(id: string): Promise<void> {
		return this.serial('archive', async () => {
			const file = this.file(id);
			const day = dayKey(new Date(), this.state.timezone);
			const year = `${HISTORY}/${day.slice(0, 4)}`, month = `${year}/${day.slice(5, 7)}`;
			const destination = `${month}/${file.name}`;
			if (this.app.vault.getAbstractFileByPath(destination)) throw Error('历史目录已有同名文件，事项未归档');
			await this.requireFolder(HISTORY);
			for (const path of [year, month]) {
				if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
				await this.requireFolder(path);
			}
			// A move preserves the original Markdown and every completion fact.
			await this.app.fileManager.renameFile(file, destination);
			await this.load();
			await this.saveState('archive');
		});
	}
	togglePin(id: string): Promise<void> {
		return this.serial('togglePin', async () => {
			const item = this.items.find(item => item.id === id);
			if (!item || item.completedAt) return;
			await this.patch(id, { pinned: !item.pinned }); await this.load();
			await this.saveState('toggle_pin');
		});
	}
	toggleDevelopmentCompleted(id: string): Promise<void> {
		return this.serial('toggleDevelopmentCompleted', async () => {
			const item = this.items.find(item => item.id === id);
			if (!item || item.completedAt) return;
			await this.patch(id, { development_completed: !item.developmentCompleted });
			await this.load();
		});
	}
	toggleDevelopmentProject(id: string): Promise<void> {
		return this.serial('toggleDevelopmentProject', async () => {
			const item = this.items.find(item => item.id === id);
			if (!item) return;
			await this.patch(id, { development_project: !item.developmentProject });
			await this.load();
		});
	}
	move(id: string, before?: string, after = false): Promise<void> {
		return this.serial('move', async () => {
			if (!this.state.order.includes(id)) return;
			this.state.order = moveInOrder(this.state.order, this.items, id, before, after);
			await this.saveState('move');
		});
	}
	/** A clicked Top action overrides pinned slots; ordinary moves still protect them. */
	top(id: string): Promise<void> {
		return this.serial('top', async () => {
			if (!this.state.order.includes(id) || this.state.order[0] === id) return;
			this.state.order = [id, ...this.state.order.filter(value => value !== id)];
			await this.saveState('top');
		});
	}
	configure(changes: Partial<Omit<ArrangeState, 'order' | 'achievedDays'>>): Promise<void> {
		return this.serial('configure', async () => { Object.assign(this.state, changes); await this.saveState('configure'); });
	}
	setAchieved(day: string, achieved: boolean): Promise<void> {
		return this.serial('setAchieved', async () => {
			this.state.achievedDays = this.state.achievedDays.filter(value => value !== day);
			if (achieved) this.state.achievedDays.push(day);
			await this.saveState('set_achieved');
		});
	}
}
