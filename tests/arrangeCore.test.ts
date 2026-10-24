import assert from 'node:assert/strict';
import test from 'node:test';
import { dayKey, defaultArrangeState, moveInOrder, pendingOrder, todayFacts, validParent, type ArrangeItem } from '../src/arrangeCore.ts';

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
