import test from 'node:test';
import assert from 'node:assert/strict';
import { bundle, fixture, md, fields } from './helpers/arrangeV2Fixture.ts';

// Obsidian cachedRead uses the same TFile cache that read/process populate and
// external modification notifications invalidate. The fixture keeps disk bytes
// and that cache separate so tests can also exercise a stale cached observation.
function cachedVault(x: any) {
 const cache = new Map<any, string>();
 let reads = 0;
 const read = x.vault.read, process = x.vault.process;
 x.vault.read = async (file: any) => {
  reads++;
  const source = await read(file); cache.set(file, source); return source;
 };
 x.vault.cachedRead = async (file: any) => cache.has(file) ? cache.get(file) : x.vault.read(file);
 x.vault.process = async (file: any, action: any) => {
  cache.delete(file);
  const source = await process(file, action); cache.set(file, source); return source;
 };
 return { cache, count: () => reads, reset: () => { reads = 0; }, external: (path: string, source: string) => {
  const file = x.put(path, source); cache.delete(file); return file;
 } };
}

const m = await bundle();
test.after(async () => { await m.close(); delete (globalThis as any).window; });

test('uncached old history contributes today facts across all folders and retains healthy-source isolation', async () => {
 const today = m.dayKey(new Date(), 'Asia/Shanghai'), at = new Date().toISOString();
 const x = fixture(m, { rewardsEnabledAt: null });
 const path = '安排/历史/2020/01/archived.md';
 const file = x.put(path, md({ gvid: 'archived', gvkit_arrange: true, title: 'archived', parent: null, date: today, completed_at: at,
  reward_completed_at: at, reward_awarded: 3 }));
 file.stat.mtime = Date.parse('2020-01-01T00:00:00Z');
 const store = x.store(); await store.refresh();
 assert.equal(store.facts().x, 1); assert.equal(store.rewards[0].points, 3);
 x.app.metadataCache = { getFileCache: (candidate: any) => candidate === file ? { frontmatter: fields(x.data.get(path)!) } : null };
 await store.refresh(); assert.equal(store.facts().x, 1, 'later metadata does not double count the same file');
 x.item('independent', { date: today });
 x.put('安排/历史/duplicate.md', x.data.get(path)!);
 await store.refresh(); assert.equal(store.facts().x, 0); assert.equal(store.facts().remaining, 1);
 assert.equal(store.rewards.length, 0, '0.7.6 excludes both duplicate sources from reward facts');
});

test('warm presentation refresh reads only activation at 200 and 1000 active items', async t => {
 for (const count of [200, 1000]) await t.test(String(count), async () => {
  const x = fixture(m, { rewardsEnabledAt: null });
  for (let i = 0; i < count; i++) x.item('item-' + i);
  const host = cachedVault(x), store = x.store();
  await store.load(); assert.equal(host.count(), count + 1);
  host.reset(); await store.refresh(); assert.equal(host.count(), 1);
  host.reset(); await store.refresh(); assert.equal(host.count(), 1);
  let comparisons = 0, lookups = 0;
  for (const item of store.items) for (let slot = 0; slot < 2; slot++) {
   const before = store.items.some((child: any) => { comparisons++; return child.parent === item.id; });
   lookups++;
   assert.equal(store.parentIds.has(item.id), before);
  }
  t.diagnostic(`${count} root rows: old child comparisons=${comparisons}; indexed lookups=${lookups}; warm disk reads=1`);
  const path = '安排/待执行/item-0.md';
  host.external(path, x.data.get(path)!.replace('title: item-0', 'title: edited'));
  host.reset(); await store.refresh(); assert.equal(host.count(), 2); assert.equal(store.items.find((item: any) => item.id === 'item-0').title, 'edited');
  assert.equal(store.items.length, count);
 });
});

test('create, remove and rename are reflected while the parent index follows healthy projection', async () => {
 const x = fixture(m); x.item('parent'); x.item('child', { parent: 'parent' });
 const host = cachedVault(x), store = x.store(); await store.refresh();
 assert.equal(store.parentIds.has('parent'), true);
 host.external('安排/待执行/child.md', x.data.get('安排/待执行/child.md')!.replace('parent: parent', 'parent: null'));
 await store.refresh(); assert.equal(store.parentIds.has('parent'), false);
 x.item('another', { parent: 'parent' }); await store.refresh(); assert.equal(store.parentIds.has('parent'), true);
 const file = x.entries.get('安排/待执行/another.md');
 await x.app.fileManager.renameFile(file, '安排/待执行/renamed.md'); await store.refresh();
 assert.equal(store.items.find((item: any) => item.id === 'another').path, '安排/待执行/renamed.md');
 x.entries.delete(file.path); x.data.delete(file.path); await store.refresh();
 assert.equal(store.parentIds.has('parent'), false); assert.equal(store.items.some((item: any) => item.id === 'another'), false);
});

test('business mutations read current bytes even when a presentation cache is stale', async () => {
 const today = m.dayKey(new Date(), 'Asia/Shanghai');
 const x = fixture(m); x.item('item', { date: today, reward_points: 3 });
 cachedVault(x); const store = x.store(); await store.refresh();
 const path = '安排/待执行/item.md';
 x.data.set(path, x.data.get(path)!.replace('reward_points: 3', 'reward_points: 8'));
 assert.equal(await store.complete('item', true), true);
 assert.equal(fields(x.data.get('安排/已完成/item.md')!).reward_awarded, 8);
 assert.equal(store.rewards[0].points, 8);
});

test('cached damage is confirmed live before repair, which preserves subsequent valid body', async () => {
 const id = '01a11111-2222-7333-8444-555555555555';
 const x = fixture(m); x.item(id); const host = cachedVault(x), store = x.store(); await store.refresh();
 const path = `安排/待执行/${id}.md`, file = x.entries.get(path);
 const valid = x.data.get(path)! + 'later valid body\n';
 host.cache.set(file, x.data.get(path)!.replace(id, id.slice(0, 25)));
 x.data.set(path, valid); const before = x.writes.length;
 await store.refresh(); assert.equal(x.data.get(path), valid); assert.equal(x.writes.length, before);
 assert.equal(store.items.find((item: any) => item.id === id).body, 'later valid body\n');
 host.external(path, valid.replace(id, id.slice(0, 25)));
 await store.refresh(); assert.equal(x.data.get(path), valid);
 assert.equal(store.items.find((item: any) => item.id === id).body, 'later valid body\n');
 assert.equal(store.isolatedItems.size, 0);
});

test('a presentation refresh with a previous-day goal reads live completion before rollover', async () => {
 const today = m.dayKey(new Date(), 'Asia/Shanghai');
 const x = fixture(m, { dailyGoal: { day: m.offsetDay(today, -1), id: 'goal' }, order: ['goal'] });
 const file = x.item('goal'); const host = cachedVault(x);
 await x.vault.read(file);
 x.data.set(file.path, md({ ...fields(x.data.get(file.path)!), completed_at: new Date().toISOString() }));
 host.reset(); const store = x.store(); await store.refresh();
 assert.equal(store.state.dailyGoal, null);
 assert.equal(x.ops().some((op: any) => op.order?.kind === 'front'), false);
 assert.ok(host.count() > 1, 'rollover bypasses the old presentation cache');
});
