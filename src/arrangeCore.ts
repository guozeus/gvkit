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

export type RowAction = 'parent' | 'date' | 'top' | 'pin';
export const SUBMIT_BLUE_COLORS = { classic: '#2463b4', console: '#2563eb', navy: '#1e3a8a' } as const;
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
}

export function defaultArrangeState(): ArrangeState {
	return { order: [], achievedDays: [], timezone: 'Asia/Shanghai', fullscreenThreshold: 80, keyboardGap: 7,
		submitArrowSize: 24, submitColor: 'classic',
		detailShadow: 24, bodyPlaceholder: '记录正文、链接、思路…', completedStyle: 'background',
		rowActions: ['parent', 'date', 'top'] };
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

export function todayFacts(items: ArrangeItem[], state: ArrangeState, now = new Date()) {
	const day = dayKey(now, state.timezone);
	const due = items.filter(item => item.date === day);
	const x = items.filter(item => item.completedAt && dayKey(new Date(item.completedAt), state.timezone) === day).length;
	const remaining = due.filter(item => !item.completedAt).length;
	const achieved = state.achievedDays.includes(day);
	return { day, x, y: due.length, remaining, achieved,
		color: remaining > 0 ? 'red' : achieved ? 'gold' : 'blue' };
}
