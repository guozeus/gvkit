import { ArrangeV2Store } from './arrangeV2Store';
import { ArrangeHistory, repairOriginal } from './arrangeRecovery';
import { clone, type OrderIntent } from './arrangeV2';
import { nextRepeatDate, repeatRule, sameRepeatCadence, validDate, type RepeatRule, type RepeatCompletion } from './arrangeRepeat';
import { rewardRecord, rewardValue, type RewardRecord } from './arrangeRewards';
import { App, getFrontMatterInfo, parseYaml, stringifyYaml, TFile, TFolder } from 'obsidian';
import { createGvid } from './fileIdCore';
import { ArrangeTrace, configFingerprint } from './arrangeTrace';
import { ARRANGE_ACTIONS, ARRANGE_BREATHE_SETTINGS, ARRANGE_FREE_SIZES, ARRANGE_NUMBER_SETTINGS, COMPLETION_SOUNDS, DATE_HINT_COLORS, dayKey, defaultArrangeState, moveInOrder, pendingOrder, reminderTopInOrder, SUBMIT_BLUE_COLORS, todayFacts, topInOrder, validParent, type ArrangeItem, type ArrangeState } from './arrangeCore';

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

export class ArrangeConfigError extends Error {
	constructor(readonly fingerprint: string, readonly cause: unknown) {
		super('配置等待同步；已保留本机设置，普通事项可继续使用。');
	}
}
export class ArrangeGoalIssue extends ArrangeConfigError {
	constructor(fingerprint: string) {
		super('goal:' + fingerprint, Error('unconfirmed_returned_id'));
		this.message = '昨日目标返回状态待确认；普通事项可正常保存，目标设置暂不可用。';
	}
}
function unconfirmedReturnedId(goal: ArrangeState['dailyGoal']): boolean {
	if (!goal || !Object.prototype.hasOwnProperty.call(goal, 'returnedId')) return false;
	const id = goal.returnedId;
	return typeof id !== 'string' || (/^[0-9a-f]{8}-/i.test(id)
		&& !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
}
const copyState = (state: ArrangeState): ArrangeState => JSON.parse(JSON.stringify(state));
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function validateConfig(fields: Record<string, unknown>): void {
	if (fields.gvkit_arrange_state !== 1 || !Array.isArray(fields.order) || !fields.order.every(id => typeof id === 'string')
		|| !Array.isArray(fields.achievedDays) || !fields.achievedDays.every(day => typeof day === 'string'))
		throw Error('安排配置格式不正确');
	const uuidLike = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-/i.test(value);
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (fields.order.some(id => uuidLike(id) && !uuid.test(id as string))) throw Error('安排排序身份不完整');
	const goal = fields.dailyGoal as ArrangeState['dailyGoal'];
	if (goal && (typeof goal.day !== 'string' || !validDate(goal.day) || !(goal.id === null || typeof goal.id === 'string')
		|| [goal.id].some(id => uuidLike(id) && !uuid.test(id!)))) throw Error('每日目标配置不完整');
}

export class ArrangeCreateError extends Error {
	constructor(message: string, readonly createdId: string) { super(message); }
}

export type ArrangeBatchAction = { kind: 'top' } | { kind: 'pin' | 'developmentCompleted'; value: boolean }
	| { kind: 'date' | 'parent'; value: string | null };
export type ArrangeBatchTarget = Pick<ArrangeItem, 'id' | 'title' | 'occurrenceId' | 'repeatInstance'>;
export interface ArrangeBatchResult {
	applied: string[];
	failed: { id: string; title: string; message: string; uncertain?: boolean }[];
	refreshError?: string;
}

export class ArrangeStore {
	// Includes queued actions and direct loads, which can also repair an original file.
	static pendingOperations = 0;
	items: ArrangeItem[] = [];
	readonly parentIds = new Set<string>();
	rewards: RewardRecord[] = [];
	state = defaultArrangeState();
	archivedDailyGoalCompletedAt: string | null = null;
	private archivedCompletions: string[] = [];
	private queue: Promise<unknown> = Promise.resolve();
	configIssue: ArrangeConfigError | null = null;
	goalIssue: ArrangeGoalIssue | null = null;
	private notifiedConfig: string | null = null;
	readonly v2: ArrangeV2Store;
	readonly isolatedItems = new Map<string, string>();
	private uncertainParents = new Set<string>();
	private uncertainIds = new Set<string>();
	private links = new Map<string, { id: string; parent: string | null }>();
	private unknownRelations = false;
	private history: ArrangeHistory;
	claimConfigNotice(fingerprint: string): boolean {
		if (this.notifiedConfig === fingerprint) return false;
		this.notifiedConfig = fingerprint;
		try { this.storage?.setItem(this.recoveryKey + ':notice', fingerprint); } catch { /* optional */ }
		return true;
	}
	private loadedFields: Record<string, unknown> | null = null;
	private loadedState = copyState(this.state);
	private lastGood: ArrangeState | null = null;
	private readonly recoveryKey: string;
	private readonly storage: Storage | null;
	constructor(private app: App, readonly trace?: ArrangeTrace) {
		this.history = new ArrangeHistory(app);
		this.recoveryKey = 'gvkit:arrange:last-valid:v1:' + (app.vault.getName?.() ?? '');
		let storage: Storage | null = null;
		try { storage = typeof window !== 'undefined' ? window.localStorage : null; } catch { /* optional local recovery */ }
		this.storage = storage;
		this.v2 = new ArrangeV2Store(app, storage, trace);
		if (this.v2.projection) this.state = clone(this.v2.projection.state);
		try { this.links = new Map(JSON.parse(storage?.getItem(this.recoveryKey + ':links') ?? '[]')); } catch { /* optional */ }
		try { this.notifiedConfig = storage?.getItem(this.recoveryKey + ':notice') ?? null; } catch { /* optional */ }
		try {
			const saved = JSON.parse(storage?.getItem(this.recoveryKey) ?? 'null');
			if (saved) { validateConfig({ ...saved, gvkit_arrange_state: 1 }); this.lastGood = saved; }
		} catch { /* never restore an invalid local snapshot */ }
	}

	async load(trigger = 'direct', presentation = false): Promise<void> {
		const run = this.trace?.nextRun() ?? 0;
		const context = { run, stage: 'start', trigger, presentation };
		this.trace?.record('load.start', { run, trigger });
		ArrangeStore.pendingOperations++;
		try {
			await this.loadInner(context);
			this.trace?.record('load.ok', { run });
		} catch (error) {
			this.trace?.failure('load.fail', error, { run, trigger, stage: context.stage });
			throw error;
		} finally { ArrangeStore.pendingOperations--; }
	}

	private async loadInner(context: { run: number; stage: string; trigger: string; presentation: boolean }): Promise<void> {
		let state = defaultArrangeState();
		this.configIssue = null;
		this.goalIssue = null;
		const projection = await this.v2.load();
		if (projection) state = clone(projection.state);
		else {
		let source = '';
		const file = this.app.vault.getAbstractFileByPath(ARRANGE_STATE_PATH);
		if (file instanceof TFile) {
			try {
			context.stage = 'read_config';
			this.trace?.record('config.read.start', { run: context.run, mtime: file.stat?.mtime, size: file.stat?.size });
			source = await this.app.vault.read(file);
			this.trace?.record('config.read.ok', { run: context.run, trigger: context.trigger, mtime: file.stat?.mtime,
				size: file.stat?.size, ...configFingerprint(source) });
			context.stage = 'parse_config';
			this.trace?.record('config.parse.start', { run: context.run });
			const { fields } = documentParts(source);
			validateConfig(fields);
			this.loadedFields = JSON.parse(JSON.stringify(fields));
			this.trace?.record('config.parse.ok', { run: context.run });
			context.stage = 'validate_config';
			if (fields.gvkit_arrange_state !== 1) throw Error('安排配置版本不兼容');
			const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(x => typeof x === 'string');
			if (!strings(fields.order) || !strings(fields.achievedDays)) throw Error('安排顺序格式不正确');
			state.order = fields.order;
			if (typeof fields.rewardsEnabledAt === 'string' && Number.isFinite(Date.parse(fields.rewardsEnabledAt))) state.rewardsEnabledAt = fields.rewardsEnabledAt;
			state.achievedDays = fields.achievedDays;
			if (typeof fields.specialReminderDay === 'string') state.specialReminderDay = fields.specialReminderDay;
			const goal = fields.dailyGoal as ArrangeState['dailyGoal'];
			if (goal && typeof goal.day === 'string' && (typeof goal.id === 'string' || goal.id === null)) {
				state.dailyGoal = { day: goal.day, id: goal.id };
				if (unconfirmedReturnedId(goal)) {
					this.goalIssue = new ArrangeGoalIssue(configFingerprint(JSON.stringify(goal)).fingerprint!);
					this.trace?.failure('config.invalid', this.goalIssue, { run: context.run, trigger: context.trigger,
						stage: 'unconfirmed_returned_id', ...configFingerprint(source) });
				} else if (typeof goal.returnedId === 'string') state.dailyGoal.returnedId = goal.returnedId;
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
			for (const key of Object.keys(ARRANGE_BREATHE_SETTINGS) as (keyof typeof ARRANGE_BREATHE_SETTINGS)[]) {
				const value = fields[key], [min, max] = ARRANGE_BREATHE_SETTINGS[key];
				if (typeof value === 'number' && Number.isFinite(value)) state[key] = Math.max(min, Math.min(max, value));
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
			} catch (error) {
				if (context.stage !== 'parse_config' && context.stage !== 'validate_config') throw error;
				this.loadedFields = null;
				this.configIssue = new ArrangeConfigError(configFingerprint(source).fingerprint!, error);
				this.trace?.failure('config.invalid', error, { run: context.run, trigger: context.trigger, stage: context.stage, ...configFingerprint(source) });
			}
		} else {
			this.loadedFields = null;
			this.configIssue = new ArrangeConfigError('missing', Error('配置尚未到达'));
			this.trace?.record('config.invalid', { run: context.run, trigger: context.trigger, stage: 'config_missing', fingerprint: 'missing' });
		}
		if (this.configIssue) {
			state = copyState(this.lastGood ?? defaultArrangeState());
			// Cached presentation must never guess today's goal or enable/award rewards.
			state.dailyGoal = null;
			state.rewardsEnabledAt = null;
		}
		// Legacy bytes are presentation/recovery only; never reactivated as authority.
		this.configIssue = new ArrangeConfigError('v2_pending', Error('等待 v2 激活同步'));
		}
		context.stage = 'scan_items';
		const items: ArrangeItem[] = [], archivedCompletions: { path: string; completedAt: string }[] = [];
		const identities = new Map<string, string>();
		const seenIds = new Set<string>();
		let linksChanged = false;
		this.isolatedItems.clear(); this.uncertainIds.clear(); this.uncertainParents.clear(); this.unknownRelations = false;
		const claimIdentity = (fields: Record<string, unknown>, path: string): void => {
			const id = fields.gvid as string;
			seenIds.add(id);
			const duplicate = identities.get(id);
			if (duplicate && duplicate !== path) {
				this.isolatedItems.set(duplicate, '重复身份'); this.uncertainIds.add(id);
				const prior = this.links.get(duplicate); if (prior?.parent) this.uncertainParents.add(prior.parent);
				throw Error('重复身份');
			}
			identities.set(id, path);
			const link = { id, parent: typeof fields.parent === 'string' ? fields.parent : null };
			if (!sameValue(this.links.get(path), link)) { this.links.set(path, link); linksChanged = true; }
		};
		const rewards: (RewardRecord & { path: string })[] = [];
		let archivedDailyGoal: { path: string; completedAt: string } | null = null;
		const today = dayKey(new Date(), state.timezone);
		// A refresh that can roll over yesterday's goal still reads business facts live.
		const cached = context.presentation && (!state.dailyGoal || state.dailyGoal.day >= today);
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (![TODO, DONE, HISTORY].some(folder => file.path.startsWith(folder + '/'))) continue;
			const startItems = items.length, startRewards = rewards.length, startArchived = archivedCompletions.length;
			let raw = '', parsed: Record<string, unknown> | undefined;
			try {
			if (file.path.startsWith(`${HISTORY}/`)) {
				// The index may lag a just-completed/undone note. Today's modified
				// files need their real fields; mtime selects reads, never counts completions.
				let fields = this.app.metadataCache?.getFileCache(file)?.frontmatter;
				const changedToday = file.stat && dayKey(new Date(file.stat.mtime), state.timezone) === today;
				// A missing index must not hide completion facts in an older folder.
				if (changedToday || !fields) {
					const source = raw = await this.readItemSource(file, cached);
					fields = getFrontMatterInfo(source).frontmatter.includes('gvkit_arrange') ? documentParts(source).fields : undefined;
				}
				if (fields?.gvkit_arrange === true) { parsed = fields; this.validateItem(fields); claimIdentity(fields, file.path); }
				const history = fields?.repeat_history as RepeatCompletion[] | undefined;
				for (const occurrence of history ?? []) {
					rewards.push({path:file.path, id:occurrence.id, completedAt:occurrence.completed_at, points:occurrence.reward_awarded ?? 0});
					if (dayKey(new Date(occurrence.completed_at), state.timezone) === today) {
						archivedCompletions.push({path:file.path, completedAt:occurrence.completed_at});
						if(state.dailyGoal?.day===today && (fields?.gvid===state.dailyGoal.id || occurrence.id===state.dailyGoal.id)) archivedDailyGoal={path:file.path, completedAt:occurrence.completed_at};
					}
				}
				const record = fields && rewardRecord(fields);
				if (record) rewards.push({...record, path:file.path});
				const completed = Array.isArray(fields?.repeat_history) ? null : fields?.completed_at;
				if (fields?.gvkit_arrange === true && typeof completed === 'string' && Number.isFinite(Date.parse(completed))
					&& dayKey(new Date(completed), state.timezone) === today) {
					archivedCompletions.push({path:file.path, completedAt:completed});
					if (state.dailyGoal?.day === today && fields.gvid === state.dailyGoal.id) archivedDailyGoal = {path:file.path, completedAt:completed};
				}
				continue;
			}
			if (!file.path.startsWith(`${TODO}/`) && !file.path.startsWith(`${DONE}/`)) continue;
			const source = raw = await this.readItemSource(file, cached);
			if (!getFrontMatterInfo(source).frontmatter.includes('gvkit_arrange')) continue;
			const { fields, body } = documentParts(source);
			if (fields.gvkit_arrange !== true) continue;
			parsed = fields;
			this.validateItem(fields);
			const record = rewardRecord(fields);
			if (record) rewards.push({...record, path:file.path});
			if (typeof fields.gvid !== 'string') throw Error(`事项缺少 GVID：${file.basename}`);
			seenIds.add(fields.gvid);
			claimIdentity(fields, file.path);
			const history = (fields.repeat_history ?? []) as RepeatCompletion[];
			const rule = repeatRule(fields.repeat);
			const closed = fields.repeat_closed === true;
			const visible = history.filter(value => !value.archived);
			const last = closed ? visible[visible.length-1] : undefined;
			for (const occurrence of history) {
				rewards.push({path:file.path, id:occurrence.id, completedAt:occurrence.completed_at, points:occurrence.reward_awarded ?? 0});
				if (occurrence.archived) { archivedCompletions.push({path:file.path, completedAt:occurrence.completed_at}); continue; }
				items.push({id:occurrence === last ? fields.gvid : occurrence.id, path:file.path,
					title:occurrence.title, body:occurrence.body, parent:occurrence.parent, date:occurrence.date,
					completedAt:occurrence.completed_at, rewardPoints:occurrence.reward_points, pinned:false,
					occurrenceOf:fields.gvid, occurrenceId:occurrence.id});
			}
			if (closed) continue;
			items.push({ id: fields.gvid, path: file.path, repeat: rule,
				repeatInstance:typeof fields.repeat_instance === 'string' ? fields.repeat_instance : undefined,
				reopened:Array.isArray(fields.repeat_reopened) && fields.repeat_reopened.length > 0,
				title: typeof fields.title === 'string' ? fields.title : file.basename, body,
				parent: typeof fields.parent === 'string' ? fields.parent : null,
				date: typeof fields.date === 'string' ? fields.date : null,
				completedAt: typeof fields.completed_at === 'string' ? fields.completed_at : null,
				rewardPoints: rewardValue(fields.reward_points),
				specialReminderAt: typeof fields.special_reminder_at === 'string' && Number.isFinite(Date.parse(fields.special_reminder_at)) ? fields.special_reminder_at : null,
				pinned: fields.pinned === true, developmentCompleted: fields.development_completed === true,
				developmentProject: fields.development_project === true });
			} catch (error) {
				items.splice(startItems); rewards.splice(startRewards); archivedCompletions.splice(startArchived);
				this.isolatedItems.set(file.path, '事项属性待确认');
				const cached = this.links.get(file.path);
				const scalar = (key: string): string | undefined => {
					const line = raw.split('\n').find(line => line.startsWith(key + ':'));
					const value = line?.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
					return value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
				};
				const id = typeof parsed?.gvid === 'string' ? parsed.gvid : cached?.id ?? scalar('gvid');
				const parent = typeof parsed?.parent === 'string' ? parsed.parent : cached?.parent ?? scalar('parent');
				if (id) this.uncertainIds.add(id);
				if (parent) this.uncertainParents.add(parent);
				if (!cached && !parsed && !parent) this.unknownRelations = true;
				this.trace?.failure('v2.item.invalid', error, { stage: 'scan_item' });
			}
		}
		const healthy = items.filter(item => !this.isolatedItems.has(item.path) && !this.uncertainIds.has(item.id));
		items.splice(0, items.length, ...healthy);
		const byId = new Map(items.map(item => [item.id, item]));
		for (const id of this.uncertainParents) { const parent = byId.get(id)?.parent; if (parent) this.uncertainParents.add(parent); }
		// A missing goal may still be in transit; absence is never completion/deletion.
		if (state.dailyGoal?.id && (!seenIds.has(state.dailyGoal.id) || this.uncertainIds.has(state.dailyGoal.id) || this.uncertainParents.has(state.dailyGoal.id))) {
			this.goalIssue = new ArrangeGoalIssue('dependency'); this.goalIssue.message = '目标相关事项待确认；其他事项可正常使用。';
		}
		try { if (linksChanged) this.storage?.setItem(this.recoveryKey + ':links', JSON.stringify([...this.links])); } catch { /* optional */ }
		this.rewards = rewards.filter(reward => !this.isolatedItems.has(reward.path) && !this.uncertainIds.has(reward.id))
			.map(({path, ...reward}) => reward);
		state.order = pendingOrder(items, state.order);
		this.items = items;
		this.parentIds.clear();
		for (const item of items) if (item.parent) this.parentIds.add(item.parent);
		this.state = state;
		this.loadedState = copyState(state);
		if (this.hasConfigConflict('dailyGoal', 'timezone') || (state.dailyGoal && state.dailyGoal.day < today && this.hasConfigConflict('order'))) {
			this.goalIssue = new ArrangeGoalIssue('conflict'); this.goalIssue.message = '目标相关设置待确认，请点击“设置待确认”选择保留值';
		}
		if (!this.configIssue && !this.goalIssue) {
			this.notifiedConfig = null;
			try { this.storage?.removeItem(this.recoveryKey + ':notice'); } catch { /* optional */ }

		}
		this.archivedCompletions = archivedCompletions.filter(value => !this.isolatedItems.has(value.path)).map(value => value.completedAt);
		this.archivedDailyGoalCompletedAt = archivedDailyGoal && !this.isolatedItems.has(archivedDailyGoal.path) ? archivedDailyGoal.completedAt : null;
		if (!this.configIssue && !this.goalIssue && state.dailyGoal && state.dailyGoal.day < today) {
			context.stage = 'day_rollover';
			this.trace?.record('day_rollover.start', { run: context.run, trigger: 'dailyGoal_day_changed' });
			const previous = items.find(item => item.occurrenceOf === state.dailyGoal!.id && item.completedAt && dayKey(new Date(item.completedAt),state.timezone)===state.dailyGoal!.day) ?? items.find(item => item.id === state.dailyGoal!.id);
			if (previous && !previous.completedAt) {
				// This explicit daily return is an insertion at the very front, not
				// ordinary top. All other items keep their relative order and pins;
				// subsequent ordinary moves protect their resulting global slots.
				state.order = [previous.id, ...state.order.filter(id => id !== previous.id)];
				state.dailyGoal = { day: today, id: null, returnedId: previous.id };
			} else state.dailyGoal = null;
			await this.saveState('day_rollover', previous && !previous.completedAt ? { kind: 'front', ids: [previous.id], pins: [] } : undefined);
			this.trace?.record('day_rollover.ok', { run: context.run });
		}
		context.stage = 'done';
	}
	/** Only already-queued local configuration writes, not remote requests or UI idleness. */
	whenIdle(): Promise<void> { return this.queue.then(() => undefined); }
	refresh(trigger = 'view_reload'): Promise<void> { return this.serial(trigger, async () => {}, true); }
	hasConfigConflict(...fields: string[]): boolean { return fields.some(field => this.v2.projection?.pending.has(field)); }
	private requireConfigFields(...fields: string[]): void {
		if (this.hasConfigConflict(...fields)) throw Error('相关设置待确认，请先点击“设置待确认”选择保留值');
	}
	resolveConfigConflict(field: string, ids: string[], choice?: string): Promise<void> {
		return this.serial('resolve_config', async () => { await this.v2.resolve(field, ids, choice); await this.load(); });
	}
	facts() { return todayFacts(this.items, this.state, new Date(), this.archivedCompletions); }

	private serial<T>(trigger: string, action: () => Promise<T>, presentation = false): Promise<T> {
		ArrangeStore.pendingOperations++;
		const next = this.queue.then(async () => {
			await this.load('before_' + trigger, presentation);
			if (this.goalIssue && trigger === 'setDailyGoal') throw this.goalIssue;
			return await action();
		}).finally(() => { ArrangeStore.pendingOperations--; });
		this.queue = next.catch(() => {});
		return next;
	}
	private async requireFolder(path: string): Promise<void> {
		if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder))
			throw Error(`请先确认信息库已有目录「${path}」；插件不会改变一级、二级目录`);
	}
	private pins(): string[] { return this.items.filter(item => item.pinned && !item.completedAt).map(item => item.id); }
	private async saveState(trigger = 'internal', order?: OrderIntent): Promise<void> {
		const changes: Record<string, unknown> = {};
		for (const key of Object.keys(this.state) as (keyof ArrangeState)[]) {
			if (key === 'order' || key === 'achievedDays' || sameValue(this.state[key], this.loadedState[key])) continue;
			changes[key] = this.state[key];
		}
		for (const day of new Set([...this.state.achievedDays, ...this.loadedState.achievedDays])) {
			if (this.state.achievedDays.includes(day) !== this.loadedState.achievedDays.includes(day)) changes['achieved:' + day] = this.state.achievedDays.includes(day);
		}
		if (this.goalIssue && 'dailyGoal' in changes) throw this.goalIssue;
		// Reconcile only newly observed/restored or now-completed IDs; never a global order snapshot.
		const shared = this.v2.projection?.state.order ?? [], known = new Set(shared);
		const added = this.loadedState.order.flatMap((id, index) => known.has(id) ? [] : [{ id, before: this.loadedState.order[index + 1] }]).reverse();
		const active = new Map(this.items.map(item => [item.id, item]));
		const removed = shared.filter(id => active.get(id)?.completedAt);
		if (!order && (added.length || removed.length) && ['toggle_pin', 'batch_pin_slots'].includes(trigger)) order = {kind:'remove',ids:[],pins:[]};
		if (order) order = { ...order, ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) };
		if (!Object.keys(changes).length && !order) return;
		const automatic = trigger === 'day_rollover' || trigger === 'special_reminders'
			? { kind: trigger === 'day_rollover' ? 'rollover' as const : 'reminder' as const, day: dayKey(new Date(), this.state.timezone) } : undefined;
		let projected;
		try { projected = await this.v2.commit(changes, order, automatic); }
		catch (error) { this.state = copyState(this.loadedState); throw error; }
		this.state = clone(projected.state);
		this.state.order = pendingOrder(this.items, this.state.order);
		this.loadedState = copyState(this.state);
	}

	private async readItemSource(file: TFile, cached = false): Promise<string> {
		const raw = cached && typeof this.app.vault.cachedRead === 'function'
			? await this.app.vault.cachedRead(file) : await this.app.vault.read(file);
		if (!getFrontMatterInfo(raw).frontmatter.includes('gvkit_arrange')) return raw;
		try {
			const { fields } = documentParts(raw);
			if (fields.gvkit_arrange !== true) return raw;
			this.validateItem(fields);
			this.history.forget(file.path);
			return raw;
		} catch { /* only damaged items may read history */ }
		// Confirm damaged cached bytes from disk before attempting any repair.
		if (cached) return this.readItemSource(file);
		const repairIdentity = (id: string): string | null => {
			// Identity is stable; title, body, parent, dates and rewards are not.
			if (file.basename !== id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
			const info = getFrontMatterInfo(raw);
			const ids = info.frontmatter.split('\n').filter(line => line.startsWith('gvid:'));
			if (ids.length !== 1) return null;
			const line = ids[0]!;
			const damagedId = line.slice(5).trim().replace(/^['"]|['"]$/g, '');
			if (damagedId.length < 9 || damagedId.length >= id.length || !id.startsWith(damagedId)) return null;
			const start = raw.indexOf(line);
			const candidate = raw.slice(0, start) + 'gvid: ' + id + raw.slice(start + line.length);
			try {
				const { fields } = documentParts(candidate);
				if (fields.gvkit_arrange !== true || fields.gvid !== id) return null;
				this.validateItem(fields);
			} catch { return null; }
			return candidate;
		};
		const known = this.links.get(file.path);
		const candidate = known && repairIdentity(known.id);
		if (candidate) return repairOriginal(this.app, file, raw, candidate);
		return this.history.recover(file, raw, sources => {
			const ids = new Set<string>();
			for (const source of sources) {
				try {
					const { fields } = documentParts(source);
					if (fields.gvkit_arrange !== true) continue;
					this.validateItem(fields); ids.add(fields.gvid as string);
				} catch { /* an invalid snapshot cannot prove identity */ }
			}
			return ids.size === 1 ? repairIdentity([...ids][0]!) : null;
		});
	}

	private validateItem(fields: Record<string, unknown>): void {
		if (typeof fields.gvid !== 'string' || !fields.gvid) throw Error('事项身份缺失');
		if (/^[0-9a-f]{8}-/i.test(fields.gvid) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.gvid)) throw Error('事项身份不完整');
		for (const key of ['parent', 'completed_at', 'date'] as const) if (fields[key] != null && typeof fields[key] !== 'string') throw Error('事项属性类型错误');
		if (fields.completed_at && !Number.isFinite(Date.parse(String(fields.completed_at)))) throw Error('完成时间无效');
		if (fields.date && !validDate(fields.date)) throw Error('事项日期无效');
		for (const key of ['repeat_history', 'repeat_reopened'] as const) {
			const records = fields[key]; if (records === undefined) continue;
			if (!Array.isArray(records)) throw Error('重复记录无效');
			const ids = new Set<string>();
			for (const value of records) {
				if (!value || typeof value !== 'object' || typeof value.id !== 'string' || ids.has(value.id)
					|| typeof value.completed_at !== 'string' || !Number.isFinite(Date.parse(value.completed_at))
					|| typeof value.title !== 'string' || typeof value.body !== 'string'
					|| (value.parent !== null && typeof value.parent !== 'string')
					|| (value.date !== null && !validDate(value.date))
					|| (value.reward_awarded !== undefined && (typeof value.reward_awarded !== 'number' || !Number.isFinite(value.reward_awarded)))) throw Error('重复记录不完整');
				ids.add(value.id);
			}
		}
		repeatRule(fields.repeat);
	}
	private requireDependencies(id: string): void {
		if (this.uncertainIds.has(id) || this.uncertainParents.has(id)
			|| (this.unknownRelations && this.items.some(item => item.parent === id))) throw Error('相关事项待确认，请先修正异常事项后重试');
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
			const item = this.items.find(value => value.id === id);
			if (item?.occurrenceId) {
				const history = current.fields.repeat_history as RepeatCompletion[];
				const occurrence = history.find(value => value.id === item.occurrenceId);
				if (!occurrence) throw Error('这次完成已被撤销，请刷新');
				Object.assign(occurrence, changes, body !== undefined ? {body} : {});
				return markdown(current.fields, current.body);
			}
			const reopened = (current.fields.repeat_reopened as RepeatCompletion[] | undefined)?.find(value => value.id === current.fields.repeat_instance);
			if (reopened) {
				for (const key of ['title', 'parent'] as const) if (key in changes) Object.assign(reopened, {[key]:changes[key]});
				if (body !== undefined) reopened.body = body;
			}
			return markdown({ ...current.fields, ...changes }, body ?? current.body);
		});
	}

	create(title: string, parent: string | null, date: string | null = null, onParentRestored?: () => void, repeat: RepeatRule | null = null): Promise<string> {
		return this.serial('create', async () => {
			if (!title.trim()) throw Error('请填写事项');
			const chosenParent = this.items.find(value => value.id === parent);
			if (chosenParent?.occurrenceOf) parent = chosenParent.occurrenceOf;
			await this.requireFolder(TODO);
			await this.requireFolder('settings/gvkit');
			repeat=repeatRule(repeat);
			if (repeat) {if(!validDate(date)) throw Error('请选择重复日期');nextRepeatDate(date,repeat);}
			const id = createGvid();
			if (!validParent(this.items, id, parent)) throw Error('上级事项已不存在');
			const completedParent = chosenParent?.completedAt ? chosenParent : this.items.find(item => item.id === parent && item.completedAt);
			// Only the direct parent follows the existing manual undo contract.
			const parentFile = completedParent ? this.file(completedParent.id) : null;
			let parentUndo: { before: string; after: string } | undefined;
			const oldOrder = [...this.state.order];
			const path = `${TODO}/${id}.md`;
			try {
				if (completedParent) await this.changeCompletion(completedParent.id, false, undefined, (before, after) => { parentUndo = {before, after}; });
				this.state.order = moveInOrder(this.state.order, this.items, id);
				await this.saveState('create', { kind: 'move', ids: [id], pins: this.pins() });
				// Commit the child last: preceding failures cannot leave an extra child.
				await this.app.vault.create(path, markdown({ gvid: id, gvkit_arrange: true,
					title: title.trim(), parent, date, completed_at: null, pinned: false, ...(repeat ? {repeat,repeat_instance:createGvid()} : {}) }, ''));
				await this.load();
			} catch (error) {
				if (!completedParent) throw error;
				if (this.app.vault.getAbstractFileByPath(path) instanceof TFile)
					throw new ArrangeCreateError('下级已保存，上级已恢复未完成；刷新失败，请刷新查看，勿重复提交', id);
				// Roll back only this undo, never later content or a newer completion.
				try {
					if (parentFile && parentUndo) {
						const undo = parentUndo, before = documentParts(undo.before), after = documentParts(undo.after);
						const keys = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])]
							.filter(key => !sameValue(before.fields[key], after.fields[key]));
						if (parentFile.path !== completedParent.path && this.app.vault.getAbstractFileByPath(completedParent.path)) throw Error('原路径已占用');
						await this.app.vault.process(parentFile, source => {
							if (source === undo.after) return undo.before;
							const current = documentParts(source);
							if (current.fields.gvid !== after.fields.gvid || current.fields.gvkit_arrange !== true
								|| keys.some(key => !sameValue(current.fields[key], after.fields[key]))) throw Error('上级状态已有后续变更');
							for (const key of keys) {
								if (key in before.fields) current.fields[key] = before.fields[key];
								else delete current.fields[key];
							}
							return markdown(current.fields, current.body);
						});
						if (parentFile.path !== completedParent.path) await this.app.fileManager.renameFile(parentFile, completedParent.path);
					}
					this.state.order = oldOrder;
					await this.saveState('create_restore', { kind: 'remove', ids: [id], pins: [] });
					await this.load();
				} catch {
					throw Error('新增失败，未创建下级；上级状态恢复失败，请刷新检查；输入已保留');
				}
				throw error;
			}
			if (completedParent) onParentRestored?.();
			return id;
		});
	}
	edit(id: string, title: string, body: string, parent: string | null): Promise<void> {
		return this.serial('edit', async () => {
			if (!title.trim()) throw Error('标题不能为空');
			parent=this.items.find(value=>value.id===parent)?.occurrenceOf ?? parent;
			if (!validParent(this.items, id, parent)) throw Error('不能将自己或自己的下级设为上级');
			await this.patch(id, { title: title.trim(), parent }, body);
			await this.load();
		});
	}
	setParent(id: string, parent: string | null): Promise<void> {
		return this.serial('setParent', async () => {
			parent=this.items.find(value=>value.id===parent)?.occurrenceOf ?? parent;
			if (!validParent(this.items, id, parent)) throw Error('不能将自己或自己的下级设为上级');
			await this.patch(id, { parent });
			await this.load();
		});
	}
	complete(id: string, done: boolean): Promise<boolean> {
		const expected = this.items.find(item => item.id === id);
		return this.serial('complete', () => this.changeCompletion(id, done, expected));
	}
	private async changeCompletion(id: string, done: boolean, expected?: ArrangeItem, onWrite?: (before: string, after: string) => void): Promise<boolean> {
		this.requireConfigFields('timezone', 'rewardsEnabledAt');
		const folder = done ? DONE : TODO;
		await this.requireFolder(folder);
		const item = this.items.find(item => item.id === id);
		if (!item || Boolean(item.completedAt) === done) return false;
		if (expected && (expected.date !== item.date || expected.occurrenceId !== item.occurrenceId || expected.repeatInstance !== item.repeatInstance)) return false;
		if (done) {
			this.requireDependencies(id);
			const parents = [id], visited = new Set(parents);
			for (const parent of parents) {
				for (const child of this.items.filter(value => value.parent === parent)) {
					if (visited.has(child.id)) continue;
					if (!child.completedAt) throw Error('需先完成所有下级事项');
					visited.add(child.id); parents.push(child.id);
				}
			}
		}
		const sourceFields = documentParts(await this.app.vault.read(this.file(id))).fields;
		if (item.repeat || item.occurrenceId || Array.isArray(sourceFields.repeat_history)) {
			return this.changeRepeatCompletion(item, done, onWrite);
		}
		const destination = `${folder}/${this.file(id).name}`;
		if (destination !== item.path && this.app.vault.getAbstractFileByPath(destination)) throw Error('目标目录已有同名文件，事项未改动');
		if (done && !this.state.rewardsEnabledAt && !this.configIssue) {
			this.state.rewardsEnabledAt = new Date().toISOString();
			await this.saveState('complete_enable_rewards');
		}
		const completedAt = done ? new Date().toISOString() : null;
		let changed = false;
		await this.app.vault.process(this.file(id), source => {
			const {fields, body} = documentParts(source);
			this.validateItem(fields);
			if (fields.gvkit_arrange !== true || fields.gvid !== item.id || (fields.date ?? null) !== item.date
				|| (fields.completed_at ?? null) !== item.completedAt || fields.repeat || Array.isArray(fields.repeat_history)) return source;
			const next = markdown({...fields, completed_at:completedAt, pinned:false,
				reward_completed_at:completedAt, reward_awarded:done ? rewardValue(fields.reward_points) : null}, body);
			onWrite?.(source, next);
			changed = true;
			return next;
		});
		if (!changed) { await this.load(); return false; }
		const file = this.file(id);
		await this.app.fileManager.renameFile(file, `${folder}/${file.name}`);
		await this.load();
		if (!this.configIssue && !this.hasConfigConflict('order')) await this.saveState('complete', { kind: done ? 'remove' : 'move', ids: [id], pins: this.pins() });
		return true;
	}

	/** One atomic Markdown process commits both the completion and its successor. */
	private async changeRepeatCompletion(item: ArrangeItem, done: boolean, onWrite?: (before: string, after: string) => void): Promise<boolean> {
		if (done && !this.state.rewardsEnabledAt && !this.configIssue) {
			this.state.rewardsEnabledAt = new Date().toISOString();
			await this.saveState('complete_enable_rewards');
		}
		let changed = false;
		await this.app.vault.process(this.file(item.id), source => {
			const {fields, body} = documentParts(source);
			this.validateItem(fields);
			if (fields.gvkit_arrange !== true || fields.gvid !== (item.occurrenceOf ?? item.id)) return source;
			const history = (fields.repeat_history ?? []) as RepeatCompletion[];
			const reopened = (fields.repeat_reopened ?? []) as RepeatCompletion[];
			if (!done) {
				const index = history.findIndex(value => value.id === item.occurrenceId);
				if (index < 0) return source;
				if (!reopened.length && fields.repeat_closed !== true) {
					fields.repeat_resume = fields.date ?? null;
					fields.repeat_resume_instance=fields.repeat_instance ?? createGvid();
				}
				reopened.push(history.splice(index,1)[0]!);
				reopened.sort((a,b)=>(a.date ?? '').localeCompare(b.date ?? ''));
				fields.date = reopened[0]!.date;
				fields.repeat_instance=reopened[0]!.id;
				fields.repeat_closed = false;
			} else {
				if (fields.repeat_closed || fields.date !== item.date || fields.repeat_instance !== item.repeatInstance) return source;
				const rule = repeatRule(fields.repeat);
				const prior = reopened.shift();
				const completedAt = new Date().toISOString();
				const occurrence: RepeatCompletion = {id:prior?.id ?? (typeof fields.repeat_instance === 'string' ? fields.repeat_instance : createGvid()), date:item.date,
					title:prior?.title ?? String(fields.title ?? item.title), body:prior?.body ?? body, parent:prior ? prior.parent : (typeof fields.parent === 'string' ? fields.parent : null), completed_at:completedAt,
					reward_points:prior?.reward_points ?? rewardValue(fields.reward_points), reward_awarded:prior?.reward_awarded ?? rewardValue(fields.reward_points)};
				if (history.some(value => value.id === occurrence.id)) throw Error('这次完成已存在，请刷新后检查完成记录');
				history.push(occurrence);
				if (prior) {
					if (reopened.length) {fields.date = reopened[0]!.date;fields.repeat_instance=reopened[0]!.id;}
					else if (Object.prototype.hasOwnProperty.call(fields,'repeat_resume')) {
						fields.date=fields.repeat_resume;
						fields.repeat_instance=fields.repeat_resume_instance ?? createGvid();
						delete fields.repeat_resume; delete fields.repeat_resume_instance;
					} else fields.repeat_closed=true;
				} else if (rule && validDate(item.date)) {fields.date=nextRepeatDate(item.date,rule);fields.repeat_instance=createGvid();}
				else fields.repeat_closed=true;
			}
			fields.repeat_history=history;
			fields.repeat_reopened=reopened;
			fields.completed_at=fields.repeat_closed ? history[history.length-1]?.completed_at ?? null : null;
			if(fields.repeat_closed) {fields.date=history[history.length-1]?.date ?? null;fields.pinned=false;delete fields.repeat_instance;}
			fields.reward_completed_at=null; fields.reward_awarded=null;
			const file=this.file(item.id), destination=`${fields.repeat_closed ? DONE : TODO}/${file.name}`;
			if(destination!==file.path && this.app.vault.getAbstractFileByPath(destination)) throw Error('目标目录已有同名文件，事项未改动');
			const next = markdown(fields,body);
			onWrite?.(source, next);
			changed=true;
			return next;
		});
		if(changed) {
			const file=this.file(item.id);
			const fields=documentParts(await this.app.vault.read(file)).fields;
			const destination=`${fields.repeat_closed ? DONE : TODO}/${file.name}`;
			if(file.path!==destination) await this.app.fileManager.renameFile(file,destination);
		}
		await this.load();
		return changed;
	}
	/** Explicit edits replace future cadence, while real undone occurrences remain to be corrected. */
	private reschedule(fields: Record<string, unknown>, date: string | null, rule: RepeatRule | null): boolean {
		const previous=repeatRule(fields.repeat);
		if (fields.date===date && sameRepeatCadence(previous,rule)) return false;
		fields.date=date;
		if (rule || previous || 'repeat' in fields) fields.repeat=rule ? {...rule,anchor:date!} : null;
		const reopened=(fields.repeat_reopened ?? []) as RepeatCompletion[];
		if (reopened.length) {
			reopened[0]!.date=date;
			if (rule && validDate(date)) {
				fields.repeat_resume=nextRepeatDate(date,fields.repeat as RepeatRule);
				fields.repeat_resume_instance ??=createGvid();
			} else {delete fields.repeat_resume;delete fields.repeat_resume_instance;}
		}
		if (rule) fields.repeat_instance ??=createGvid();
		return true;
	}
	setRepeat(id: string, value: RepeatRule | null, date: string | null): Promise<void> {
		return this.serial('setRepeat', async () => {
			const rule=repeatRule(value);
			if (rule && !validDate(date)) throw Error('请先选择日期');
			if (rule) nextRepeatDate(date!,rule);
			const item=this.items.find(item=>item.id===id);
			if (!item || item.completedAt) throw Error('请在待执行事项上设置重复');
			await this.app.vault.process(this.file(id),source=>{
				const {fields,body}=documentParts(source);
				return this.reschedule(fields,date,rule) ? markdown(fields,body) : source;
			});
			await this.load();
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
    const item=this.items.find(value=>value.id===id);
    if (item?.occurrenceId) {
     const occurrence=(fields.repeat_history as RepeatCompletion[]).find(value=>value.id===item.occurrenceId);
     if (!occurrence) throw Error('这次完成已被撤销，请刷新');
     occurrence.reward_points=points; occurrence.reward_awarded=points;
     return markdown(fields,body);
    }
    const reopened=(fields.repeat_reopened as RepeatCompletion[] | undefined)?.find(value=>value.id===fields.repeat_instance);
    if (reopened) { reopened.reward_points=points; reopened.reward_awarded=points; }
    // Correct only this explicit award. Old completed notes are never backfilled.
    const changes = rewardRecord(fields) ? { reward_awarded: points } : {};
    return markdown({ ...fields, reward_points: points, ...changes }, body);
   });
   await this.load();
  });
 }

	private async writeDate(id: string, date: string | null): Promise<void> {
		if (date!==null && !validDate(date)) throw Error('请选择有效日期');
		const item=this.items.find(value=>value.id===id);
		if (item?.occurrenceId) await this.patch(id,{date});
		else await this.app.vault.process(this.file(id),source=>{
			const {fields,body}=documentParts(source);
			const rule=date ? repeatRule(fields.repeat) : null;
			return this.reschedule(fields,date,rule) ? markdown(fields,body) : source;
		});
	}
	private async changeDate(id: string, date: string | null): Promise<void> {
		await this.writeDate(id, date);
		await this.load();
	}
	setDate(id: string, date: string | null): Promise<void> {
		return this.serial('setDate',()=>this.changeDate(id,date));
	}
	setDailyGoal(id: string): Promise<void> {
		return this.serial('setDailyGoal', async () => {
			this.requireDependencies(id);
			const item = this.items.find(item => item.id === id);
			const day = dayKey(new Date(), this.state.timezone);
			if (!item || (item.completedAt && dayKey(new Date(item.completedAt), this.state.timezone) !== day))
				throw Error('请选择未完成或今天完成的事项');
			const completedOccurrence=item.occurrenceId ? item : this.items.find(value=>value.occurrenceOf===id && value.completedAt && dayKey(new Date(value.completedAt),this.state.timezone)===day);
			if (!completedOccurrence) await this.changeDate(id,day);
			this.state.dailyGoal = { ...this.state.dailyGoal, day, id:item.occurrenceOf ?? id };
			await this.saveState('set_daily_goal');
			await this.load();
		});
	}
	archive(id: string): Promise<void> {
		return this.serial('archive', async () => {
			const item=this.items.find(value=>value.id===id);
			if (item?.occurrenceId) { await this.patch(id,{archived:true}); await this.load(); return; }
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
			if (!this.configIssue && !this.hasConfigConflict('order')) await this.saveState('archive', { kind: 'remove', ids: [id], pins: [] });
		});
	}
	/** Called only on actual presentation, never on background load/refresh. */
	enter(trigger = 'enter'): Promise<void> {
		return this.serial(trigger, async () => {
			if (this.configIssue) return;
			if (!this.state.rewardsEnabledAt && !this.hasConfigConflict('rewardsEnabledAt')) { this.state.rewardsEnabledAt = new Date().toISOString(); await this.saveState('enable_rewards'); }
			if (this.hasConfigConflict('specialReminderDay', 'order', 'dailyGoal', 'timezone')) return;
			const day = dayKey(new Date(), this.state.timezone);
			if (this.state.specialReminderDay === day) return;
			const previous = this.state;
			this.trace?.record('special_reminders.start', { trigger });
			this.state = { ...previous, order: reminderTopInOrder(previous.order, this.items), specialReminderDay: day };
			try {
				await this.saveState('special_reminders', sameValue(previous.order, this.state.order) ? undefined : { kind: 'top', ids: this.state.order.filter(id => this.items.some(item => item.id === id && item.specialReminderAt && !item.completedAt)), pins: this.pins() });
				this.trace?.record('special_reminders.ok', { trigger });
			}
			catch {
				this.state = previous;
				throw Error('特别提醒置顶未保存，请重新进入自御重试');
			}
		});
	}
	toggleSpecialReminder(id: string): Promise<void> {
		return this.serial('toggleSpecialReminder', async () => {
			const item = this.items.find(item => item.id === id);
			if (!item || item.completedAt || item.occurrenceId) return;
			await this.patch(id, { special_reminder_at: item.specialReminderAt ? null : new Date().toISOString() });
			await this.load();
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
			await this.saveState('move', { kind: 'move', ids: [id], before, after, pins: this.pins() });
		});
	}
	/** Top releases only the target pin slot; all other pinned ranks stay fixed. */
	top(id: string): Promise<void> {
		return this.serial('top', async () => {
			if (!this.state.order.includes(id) || this.state.order[0] === id) return;
			const previous = this.state.order;
			const next = topInOrder(previous, this.items, [id]);
			if (next.every((value, index) => value === previous[index])) return;
			this.state.order = next;
			try { await this.saveState('top', { kind: 'top', ids: [id], pins: this.pins() }); }
			catch (error) { this.state.order = previous; throw error; }
		});
	}
	private async batchSaved(item: ArrangeItem, action: ArrangeBatchAction, order?: string[]): Promise<boolean> {
		if(action.kind==='top'){
			const projection = await this.v2.load();
			return !!projection && sameValue(pendingOrder(this.items, projection.state.order), order);
		}
		const fields=documentParts(await this.app.vault.read(this.file(item.id))).fields;
		if(fields.gvid!==(item.occurrenceOf??item.id))return false;
		const record=item.occurrenceId?(fields.repeat_history as RepeatCompletion[]).find(value=>value.id===item.occurrenceId):fields;
		if(!record)return false;
		const key=action.kind==='pin'?'pinned':action.kind==='developmentCompleted'?'development_completed':action.kind;
		const value=(record as Record<string,unknown>)[key];
		return action.kind==='pin'||action.kind==='developmentCompleted'?(value===true)===action.value:(value??null)===action.value;
	}
	/** One user-selected batch, on the same serial queue and Markdown truth as single actions. */
	applyBatch(targets: readonly ArrangeBatchTarget[], action: ArrangeBatchAction,
		progress?: (done: number, total: number) => void): Promise<ArrangeBatchResult> {
		return this.serial('batch_' + action.kind, async () => {
			const unique = [...new Map(targets.map(item => [item.id, item])).values()];
			const current = unique.map(expected => {
				const item = this.items.find(item => item.id === expected.id);
				if (!item || item.occurrenceId !== expected.occurrenceId || item.repeatInstance !== expected.repeatInstance)
					throw Error('事项已变化，请重新选择');
				return item;
			});
			if (!current.length) throw Error('请先选择事项');
			if (['top', 'pin', 'developmentCompleted'].includes(action.kind) && current.some(item => item.completedAt))
				throw Error('含已完成事项，请先取消选择');
			if (action.kind === 'top' && this.state.dailyGoal?.day === this.facts().day) {
				const goal=this.items.find(item=>item.occurrenceOf===this.state.dailyGoal!.id&&item.completedAt
					&&dayKey(new Date(item.completedAt),this.state.timezone)===this.state.dailyGoal!.day)
					??this.items.find(item=>item.id===this.state.dailyGoal!.id);
				if(current.some(item=>item.id===goal?.id))throw Error('今天特产事项固定显示，不能置顶');
			}
			if (action.kind === 'date') {
				if (action.value !== null && !validDate(action.value)) throw Error('请选择有效日期');
				if (action.value === null && current.some(item => !item.occurrenceId && item.repeat))
					throw Error('重复事项需单独清除日期');
			}
			if (action.kind === 'parent') {
				const value=action.value;
				const parent = this.items.find(item => item.id === value)?.occurrenceOf ?? value;
				action = { kind: 'parent', value: parent };
				if (current.some(item => !validParent(this.items, item.id, parent)))
					throw Error('不能将自己或自己的下级设为上级');
			}
			const result: ArrangeBatchResult = { applied: [], failed: [] };
			let expectedOrder:string[]|undefined;
			if (action.kind === 'top') {
				const previous = this.state.order, next = topInOrder(previous, this.items, current.map(item => item.id));
				expectedOrder=next;
				try {
					if (next.some((id, index) => id !== previous[index])) {
						this.state.order = next; await this.saveState('batch_top', { kind: 'top', ids: next.filter(id => current.some(item => item.id === id)), pins: this.pins() });
					}
					result.applied = current.map(item => item.id);
				} catch (error) {
					this.state.order = previous;
					let saved = false, uncertain = false;
					try {
						saved = await this.batchSaved(current[0]!,action,next);
					} catch { uncertain = true; }
					if (saved) { this.state.order = next; result.applied = current.map(item => item.id); }
					else result.failed = current.map(item => ({ id: item.id, title: item.title,
						message: error instanceof Error ? error.message : '保存失败', uncertain }));
				}
			} else {
				// Persist effective slots before newly pinning notes, including externally added IDs.
				if (action.kind === 'pin' && action.value && current.some(item => !item.pinned)) await this.saveState('batch_pin_slots');
				const wanted=action.value;
				const field = action.kind === 'pin' ? 'pinned' : action.kind === 'developmentCompleted' ? 'development_completed' : action.kind;
				for (const item of current) {
					const matches = (value: unknown) => action.kind === 'pin' || action.kind === 'developmentCompleted'
						? (value === true) === wanted : (value ?? null) === wanted;
					const value = action.kind === 'developmentCompleted' ? item.developmentCompleted : action.kind === 'pin' ? item.pinned : action.kind === 'date' ? item.date : item.parent;
					try {
						if (!matches(value)) {
							if (action.kind === 'date') await this.writeDate(item.id, action.value);
							else await this.patch(item.id, { [field]: action.value });
						}
						result.applied.push(item.id);
					} catch (error) {
						let saved = false, uncertain = false;
						try {
							saved = await this.batchSaved(item,action);
						} catch { uncertain = true; }
						if (saved) result.applied.push(item.id);
						else result.failed.push({ id: item.id, title: item.title, message: error instanceof Error ? error.message : '保存失败', uncertain });
					}
					progress?.(result.applied.length + result.failed.length, current.length);
				}
			}
			try { await this.load(); } catch (error) {
				result.refreshError = error instanceof Error ? error.message : '刷新失败';
				const committed=result.applied;result.applied=[];
				for(const id of committed){
					const item=current.find(item=>item.id===id)!;let saved=false,uncertain=false;
					try{saved=await this.batchSaved(item,action,expectedOrder);}catch{uncertain=true;}
					if(saved)result.applied.push(id);
					else result.failed.push({id,title:item.title,message:uncertain?'结果待确认，请重试读回':'目标值尚未保存',uncertain});
				}
			}
			return result;
		});
	}
	configure(changes: Partial<Omit<ArrangeState, 'order' | 'achievedDays'>>): Promise<void> {
		return this.serial('configure', async () => {
			if ('order' in changes) throw Error('请通过移动事项调整顺序');
			this.requireConfigFields(...Object.keys(changes));
			Object.assign(this.state, changes); await this.saveState('configure');
		});
	}
	setAchieved(day: string, achieved: boolean): Promise<void> {
		return this.serial('setAchieved', async () => {
			this.requireConfigFields('dailyGoal', 'timezone', 'achieved:' + day);
			if (achieved && this.isolatedItems.size) throw Error('部分事项待确认，暂不能确认全部达成');
			this.state.achievedDays = this.state.achievedDays.filter(value => value !== day);
			if (achieved) this.state.achievedDays.push(day);
			await this.saveState('set_achieved');
		});
	}
}