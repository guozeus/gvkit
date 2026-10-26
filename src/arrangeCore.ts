export interface ArrangeItem {
	id: string;
	path: string;
	title: string;
	body: string;
	parent: string | null;
	date: string | null;
	completedAt: string | null;
	pinned: boolean;
}

export const ARRANGE_ACTIONS = ['parent', 'date', 'top', 'pin', 'changeParent', 'markdown'] as const;
export type RowAction = typeof ARRANGE_ACTIONS[number];
export const SUBMIT_BLUE_COLORS = { classic: '#2463b4', console: '#2563eb', navy: '#1e3a8a' } as const;
export const DATE_HINT_COLORS = { vivid: '#0066ff', electric: '#008cff', cyan: '#00a6ff' } as const;
export interface ArrangeState {
	order: string[];
	achievedDays: string[];
	timezone: string;
	fullscreenThreshold: number;
	keyboardGap: number;
	submitArrowSize: number;
	submitColor: keyof typeof SUBMIT_BLUE_COLORS;
	detailShadow: number;
	bodyPlaceholder: string;
	completedStyle: 'background' | 'text';
	rowActions: RowAction[];
	detailActions: RowAction[];
	showCompletedChildren: boolean;
	listFontSize: number;
	rowHeight: number;
	rowDividers: boolean;
	gripHeight: number;
	gripWidth: number;
	toolbarHeight: number;
	parentFontSize: number;
	closeThreshold: number;
	selectionColor: 'blue' | 'purple' | 'gold';
	detailFontSize: number;
	bodyFontSize: number;
	dateFontSize: number;
	dateHintColor: keyof typeof DATE_HINT_COLORS;
	rowIconGap: number;
	detailIconGap: number;
}

export const ARRANGE_NUMBER_SETTINGS = {
	gripHeight: [24, 56, 32], gripWidth: [24, 96, 36], toolbarHeight: [40, 56, 44], closeThreshold: [10, 40, 25],
	rowIconGap: [0, 24, 4], detailIconGap: [0, 32, 8],
} as const;

/** CSS sizes accept nonnegative numbers; do not impose product typography limits. */
export const ARRANGE_FREE_SIZES = {
	listFontSize: 17, rowHeight: 44, detailFontSize: 18, bodyFontSize: 16, parentFontSize: 13, dateFontSize: 12,
} as const;

export function defaultArrangeState(): ArrangeState {
	return { order: [], achievedDays: [], timezone: 'Asia/Shanghai', fullscreenThreshold: 80, keyboardGap: 7,
		submitArrowSize: 24, submitColor: 'classic',
		detailShadow: 24, bodyPlaceholder: '记录正文、链接、思路…', completedStyle: 'background',
		rowActions: ['parent', 'date', 'top'], detailActions: [...ARRANGE_ACTIONS], showCompletedChildren: true,
		listFontSize: 17, rowHeight: 44, rowDividers: true, gripHeight: 32, gripWidth: 36,
		toolbarHeight: 44, parentFontSize: 13, closeThreshold: 25, selectionColor: 'blue',
		detailFontSize: 18, bodyFontSize: 16, dateFontSize: 12, dateHintColor: 'vivid', rowIconGap: 4, detailIconGap: 8 };
}

/** Missing IDs are new externally created items; stale/completed IDs are not slots. */
export function pendingOrder(items: ArrangeItem[], order: string[]): string[] {
	const pending = new Set(items.filter(item => !item.completedAt).map(item => item.id));
	const known = new Set(order);
	let result = order.filter((id, index) => pending.has(id) && order.indexOf(id) === index);
	for (const item of items.filter(item => pending.has(item.id) && !known.has(item.id))) {
		// A restored or externally created item occupies the first free slot too.
		// A new ID has no protected position until it enters the global sequence.
		result = moveInOrder(result, items.filter(other => other.id !== item.id), item.id);
	}
	return result;
}

/** Rearrange only unprotected slots. Pinned rows keep their current absolute position. */
export function moveInOrder(order: string[], items: ArrangeItem[], id: string, before?: string, after = false): string[] {
	const pinned = new Set(items.filter(item => item.pinned && !item.completedAt).map(item => item.id));
	if (pinned.has(id)) return [...order];
	const movable = order.filter(value => !pinned.has(value) && value !== id);
	const target = before ? order.indexOf(before) + (after ? 1 : 0) : 0;
	const index = before && target >= 0
		? order.slice(0, target).filter(value => !pinned.has(value) && value !== id).length : 0;
	movable.splice(index, 0, id);
	let cursor = 0;
	const length = order.includes(id) ? order.length : order.length + 1;
	return Array.from({ length }, (_, position) => {
		const old = order[position];
		return old && pinned.has(old) ? old : movable[cursor++]!;
	});
}

export function validParent(items: ArrangeItem[], id: string, parent: string | null): boolean {
	const seen = new Set([id]);
	let next = parent;
	while (next) {
		if (seen.has(next)) return false;
		seen.add(next);
		const item = items.find(value => value.id === next);
		if (!item) return false;
		next = item.parent;
	}
	return true;
}

export function dayKey(date: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
	const get = (type: string) => parts.find(part => part.type === type)?.value;
	return `${get('year')}-${get('month')}-${get('day')}`;
}

export function offsetDay(day: string, amount: number): string {
	const date = new Date(`${day}T12:00:00Z`);
	date.setUTCDate(date.getUTCDate() + amount);
	return date.toISOString().slice(0, 10);
}

export type DateGrain = 'day' | 'week' | 'month' | 'year';
export function dateRange(day: string, grain: DateGrain): { start: string; end: string } {
	if (grain === 'day') return { start: day, end: day };
	if (grain === 'week') {
		const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
		const start = offsetDay(day, -((weekday + 6) % 7));
		return { start, end: offsetDay(start, 6) };
	}
	const start = grain === 'month' ? `${day.slice(0, 7)}-01` : `${day.slice(0, 4)}-01-01`;
	const next = new Date(`${start}T12:00:00Z`);
	if (grain === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
	else next.setUTCFullYear(next.getUTCFullYear() + 1);
	return { start, end: offsetDay(next.toISOString().slice(0, 10), -1) };
}
export function shiftPeriod(day: string, grain: DateGrain, direction: number): string {
	if (grain === 'day' || grain === 'week') return offsetDay(day, direction * (grain === 'week' ? 7 : 1));
	const date = new Date(`${dateRange(day, grain).start}T12:00:00Z`);
	if (grain === 'month') date.setUTCMonth(date.getUTCMonth() + direction);
	else date.setUTCFullYear(date.getUTCFullYear() + direction);
	return date.toISOString().slice(0, 10);
}
export function matchesDateRange(item: ArrangeItem, range: { start: string; end: string }, timezone: string): boolean {
	const day = item.completedAt ? dayKey(new Date(item.completedAt), timezone) : item.date;
	return Boolean(day && day >= range.start && day <= range.end);
}
export function relativeDate(date: string, today: string, completed = false): string {
	const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
	const week = dateRange(today, 'week');
	const relative = date === today ? '今天' : date === offsetDay(today, 1) ? '明天'
		: date < today ? (completed ? '' : '已逾期') : date <= week.end ? `本周${'日一二三四五六'[weekday]}`
			: date <= offsetDay(week.end, 7) ? `下周${'日一二三四五六'[weekday]}` : '';
	const absolute = `${date.slice(0, 4) !== today.slice(0, 4) ? `${Number(date.slice(0, 4))}年` : ''}${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}号`;
	return relative ? `${relative}，${absolute}` : absolute;
}

/** A compact deadline hint, using the same calendar day as the detail and counts. */
export function rowDateLabel(item: ArrangeItem, today: string): string {
	const date = item.date;
	if (!date || date > today || (item.completedAt && date < today)) return '';
	if (date === today) return '今天';
	if (date === offsetDay(today, -1)) return '昨天';
	if (date === offsetDay(today, -2)) return '前天';
	const week = dateRange(today, 'week');
	const weekday = '日一二三四五六'[new Date(`${date}T12:00:00Z`).getUTCDay()];
	if (date >= week.start) return `本周${weekday}`;
	if (date >= offsetDay(week.start, -7)) return `上周${weekday}`;
	const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000);
	return `${days}天前`;
}

export function todayFacts(items: ArrangeItem[], state: ArrangeState, now = new Date()) {
	const day = dayKey(now, state.timezone);
	const due = items.filter(item => item.date === day);
	const x = items.filter(item => item.completedAt && dayKey(new Date(item.completedAt), state.timezone) === day).length;
	const remaining = due.filter(item => !item.completedAt).length;
	const achieved = state.achievedDays.includes(day);
	return { day, x, y: due.length, remaining, achieved,
		color: remaining > 0 ? 'red' : achieved ? 'gold' : 'blue' };
}
