import assert from 'node:assert/strict';
import test from 'node:test';
import { dateRange, dayKey, defaultArrangeState, matchesDateRange, moveInOrder, pendingOrder, relativeDate, rowDateLabel, shiftPeriod, todayFacts, validParent, type ArrangeItem } from '../src/arrangeCore.ts';

function item(id: string, changes: Partial<ArrangeItem> = {}): ArrangeItem {
	return { id, title: id, body: '', path: `${id}.md`, parent: null, date: null, completedAt: null, pinned: false, ...changes };
}
test('new child and top use the first free slot after five pinned rows', () => {
	const items = ['a','b','c','d','e','f','g'].map((id, index) => item(id, { pinned: index < 5 }));
	const order = items.map(x => x.id);
	assert.deepEqual(moveInOrder(order, items, 'child'), ['a','b','c','d','e','child','f','g']);
	assert.deepEqual(moveInOrder(order, items, 'g'), ['a','b','c','d','e','g','f']);
});
test('only third pinned stays third under inserts and reorder, completion closes gaps', () => {
	const items = ['a','b','c','d','e'].map(id => item(id, { pinned: id === 'c' }));
	const order = items.map(x => x.id);
	assert.deepEqual(moveInOrder(order, items, 'new'), ['new','a','c','b','d','e']);
	assert.deepEqual(moveInOrder(order, items, 'e', 'b'), ['a','e','c','b','d']);
	assert.deepEqual(moveInOrder(order, items, 'a', 'e', true), ['b','d','c','e','a']);
	items[0]!.completedAt = '2026-10-24T04:00:00Z';
	const after = pendingOrder(items, order);
	assert.deepEqual(after, ['b','c','d','e']);
	assert.deepEqual(moveInOrder(after, items, 'new'), ['new','c','b','d','e']);
});
test('parent relationships accept arbitrary depth but refuse ancestors and missing parents', () => {
	const items = [item('a'), item('b', { parent: 'a' }), item('c', { parent: 'b' })];
	assert.equal(validParent(items, 'new', 'c'), true);
	assert.equal(validParent(items, 'a', 'c'), false);
	assert.equal(validParent(items, 'a', 'a'), false);
	assert.equal(validParent(items, 'a', 'missing'), false);
	assert.equal(validParent(items, 'b', null), true);
});
test('restoring a completion after the order was saved does not displace a pinned item', () => {
	const items = ['new', 'pinned', 'other', 'restored'].map(id => item(id, { pinned: id === 'pinned' }));
	assert.deepEqual(pendingOrder(items, ['new', 'pinned', 'other']), ['restored', 'pinned', 'new', 'other']);
});
test('8/5 stays red with one required remaining; blue/gold are independent of x', () => {
	const state = defaultArrangeState();
	const now = new Date('2026-10-24T04:00:00Z');
	const items = Array.from({ length: 9 }, (_, index) => item(String(index), {
		date: index < 5 ? '2026-10-24' : null,
		completedAt: index === 0 ? null : now.toISOString(),
	}));
	assert.deepEqual(todayFacts(items, state, now), { day: '2026-10-24', x: 8, y: 5, remaining: 1, achieved: false, color: 'red' });
	items[0]!.completedAt = now.toISOString();
	assert.equal(todayFacts(items, state, now).color, 'blue');
	state.achievedDays.push('2026-10-24');
	assert.equal(todayFacts(items, state, now).color, 'gold');
	items[0]!.completedAt = null;
	assert.equal(todayFacts(items, state, now).color, 'red');
	items.forEach(x => { x.date = null; });
	assert.equal(todayFacts(items, state, now).y, 0);
	assert.equal(todayFacts(items, state, now).x, 8);
});
test('shared time zone uses the same day across UTC midnight and devices', () => {
	assert.equal(dayKey(new Date('2026-10-23T17:00:00Z'), 'Asia/Shanghai'), '2026-10-24');
});

test('search periods use Monday weeks and calendar months/years across boundaries', () => {
	assert.deepEqual(dateRange('2026-10-25', 'week'), { start: '2026-10-19', end: '2026-10-25' });
	assert.deepEqual(dateRange('2026-01-01', 'week'), { start: '2025-12-29', end: '2026-01-04' });
	assert.deepEqual(dateRange('2028-02-12', 'month'), { start: '2028-02-01', end: '2028-02-29' });
	assert.deepEqual(dateRange('2026-10-25', 'year'), { start: '2026-01-01', end: '2026-12-31' });
	assert.equal(shiftPeriod('2026-01-31', 'month', 1), '2026-02-01');
	assert.equal(shiftPeriod('2028-02-29', 'year', 1), '2029-01-01');
	assert.equal(shiftPeriod('2026-01-01', 'day', -1), '2025-12-31');
	assert.equal(shiftPeriod('2026-01-01', 'week', -1), '2025-12-25');
});
test('search dates use pending date or actual completion day in the shared timezone', () => {
	const range = dateRange('2026-10-25', 'day');
	assert.equal(matchesDateRange(item('undated'), range, 'Asia/Shanghai'), false);
	assert.equal(matchesDateRange(item('due', { date: range.start }), range, 'Asia/Shanghai'), true);
	const done = item('done', { date: '2027-01-01', completedAt: '2026-10-24T16:01:00Z' });
	assert.equal(matchesDateRange(done, range, 'Asia/Shanghai'), true);
	assert.equal(matchesDateRange(done, range, 'UTC'), false);
	assert.equal(matchesDateRange({ ...done, date: range.start, completedAt: '2026-10-23T00:00:00Z' }, range, 'Asia/Shanghai'), false);
});
test('date label uses the saved day boundary, relative weekdays and cross-year dates', () => {
	assert.equal(relativeDate('2026-10-26', '2026-10-25'), '明天，10月26号');
	assert.equal(relativeDate('2026-10-30', '2026-10-25'), '下周五，10月30号');
	assert.equal(relativeDate('2026-10-30', '2026-10-26'), '本周五，10月30号');
	assert.equal(relativeDate('2026-10-25', '2026-10-25'), '今天，10月25号');
	assert.equal(relativeDate('2026-10-24', '2026-10-25'), '已逾期，10月24号');
	assert.equal(relativeDate('2026-10-24', '2026-10-25', true), '10月24号');
	assert.equal(relativeDate('2027-06-01', '2026-10-25'), '2027年6月1号');
});

test('row deadline hints use the existing date, hide future/completed overdue dates and cross calendar boundaries', () => {
	const today = '2026-10-28';
	const hint = (date: string | null, completedAt: string | null = null) => rowDateLabel(item('a', { date, completedAt }), today);
	assert.equal(hint(null), ''); assert.equal(hint('2026-10-29'), '');
	assert.equal(hint(today), '今天'); assert.equal(hint('2026-10-27'), '昨天');
	assert.equal(hint('2026-10-26'), '前天'); assert.equal(hint('2026-10-25'), '上周日');
	assert.equal(hint('2026-10-20'), '上周二'); assert.equal(hint('2026-10-01'), '27天前');
	assert.equal(hint('2026-10-25', '2026-10-25T02:00:00Z'), '');
	assert.equal(hint(today, '2026-10-28T02:00:00Z'), '今天');
	assert.equal(rowDateLabel(item('year', { date: '2025-12-31' }), '2026-01-01'), '昨天');
	assert.equal(rowDateLabel(item('week', { date: '2026-10-26' }), '2026-10-30'), '本周一');
});
