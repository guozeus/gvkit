import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { bundle, fixture } from './helpers/arrangeV2Fixture.ts';

// Production picker and Store, with the existing v2 Vault fixture and modal DOM.
test('inline date calendar closes only after a successful date write and retains repeat editing', async t => {
 const m = await bundle();
 const win = new Window();
 const saved = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
 Object.assign(globalThis, { window: win, document: win.document });
 const proto = win.HTMLElement.prototype as any;
 proto.empty = function () { this.replaceChildren(); };
 proto.addClass = function (...names: string[]) { this.classList.add(...names); };
 proto.removeClass = function (...names: string[]) { this.classList.remove(...names); };
 proto.toggleClass = function (name: string, on: boolean) { this.classList.toggle(name, on); };
 proto.createEl = function (tag: string, options: any = {}) {
  if (typeof options === 'string') options = { cls: options };
  const element = win.document.createElement(tag);
  element.className = options.cls ?? '';
  if (options.text) element.textContent = options.text;
  if (options.value !== undefined) (element as any).value = options.value;
  if (options.type) (element as any).type = options.type;
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  this.append(element); return element;
 };
 proto.createDiv = function (options: any) { return this.createEl('div', options); };
 proto.createSpan = function (options: any) { return this.createEl('span', options); };
 const output = await build({ entryPoints: ['src/arrangeDatePicker.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'modal', setup(b) {
   b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'modal' }));
   b.onLoad({ filter: /.*/, namespace: 'modal' }, () => ({ contents: `
export class Modal {constructor(app){this.app=app;this.modalEl=document.createElement('section');this.contentEl=this.modalEl.createDiv();}open(){document.body.append(this.modalEl)}close(){this.modalEl.remove();this.onClose?.()}}
export class Notice {} export const setIcon=(el,icon)=>{el.dataset.icon=icon};`, loader: 'js' }));
  } }] });
 const mod: any = { exports: {} };
 new Function('module', 'exports', 'require', output.outputFiles[0]!.text)(mod, mod.exports, createRequire(import.meta.url));
 const Picker = mod.exports.ArrangeDatePicker;
 const wait = async (check: () => boolean) => {
  for (let n = 0; n < 150 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'date operation settles');
 };
 const click = (picker: any, label: string) => {
  const button = picker.contentEl.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
  assert.ok(button, label); button.click();
 };
 try {
  await t.test('shortcut, offsets, concrete day, unchanged date and clear use the real Store', async () => {
   const x = fixture(m); x.item('date', { date: '2026-11-24' });
   const store = x.store(); await store.load();
   const item = () => store.items.find((value: any) => value.id === 'date');
   const open = () => {
    const picker = new Picker(x.app, item().date, '2026-11-24', async (date: string | null) => { await store.setDate('date', date); return true; });
    picker.open(); return picker;
   };
   for (const [label, expected] of [['明天', '2026-11-25'], ['推一月', '2026-12-25'], ['2026-12-31', '2026-12-31'], ['2026-12-31', '2026-12-31']]) {
    const picker = open();
    assert.ok(picker.contentEl.querySelector('.gvkit-arrange-calendar-days'));
    assert.equal(picker.contentEl.querySelector('[aria-label="选择日期"]'), null);
    click(picker, label!);
    assert.equal(picker.contentEl.textContent.includes('正在保存'), false);
    await wait(() => !picker.contentEl.isConnected);
    assert.equal(item().date, expected);
   }
   const picker = open(); click(picker, '清除日期');
   await wait(() => item().date === null);
   assert.equal(picker.contentEl.isConnected, true);
   assert.equal(picker.contentEl.querySelector('.gvkit-arrange-calendar-days [aria-pressed="true"]'), null);
   assert.equal(picker.contentEl.querySelector('[aria-label="清除日期"]').hidden, true);
   picker.close(); await wait(() => !picker.contentEl.isConnected);
  });
  await t.test('slow writes coalesce final selection, failed date retries and closes only on success', async () => {
   let release!: () => void;
   let block = true, fail = false;
   const writes: (string | null)[] = [];
   const picker = new Picker({}, '2026-11-24', '2026-11-24', async (date: string | null) => {
    if (block) await new Promise<void>(resolve => { release = resolve; });
    if (fail) return false;
    writes.push(date); return true;
   });
   picker.open(); click(picker, '明天'); await wait(() => Boolean(release));
   click(picker, '2026-11-30');
   assert.equal(picker.contentEl.isConnected, true);
   assert.equal(picker.contentEl.querySelector('.gvkit-arrange-date-feedback').hidden, true);
   block = false; fail = true; release();
   await wait(() => picker.failed);
   assert.equal(picker.contentEl.querySelector('[aria-label="2026-11-30"]').getAttribute('aria-pressed'), 'true');
   picker.close(); assert.equal(picker.contentEl.isConnected, true);
   fail = false; click(picker, '重试'); await wait(() => !picker.contentEl.isConnected);
   assert.deepEqual(writes, ['2026-11-30']);
  });
  await t.test('closing while a date write is pending invokes the batch close once', async () => {
   let release!: () => void;
   let closes = 0;
   const picker = new Picker({}, '2026-11-24', '2026-11-24', async () => {
    await new Promise<void>(resolve => { release = resolve; }); return true;
   }, undefined, undefined, { count: 2, mixed: false, anyDate: true, failureMessage: () => '', failureDetails: () => [], onClose: () => { closes++; } });
   picker.open(); click(picker, '明天'); await wait(() => Boolean(release));
   picker.close(); release(); await wait(() => !picker.contentEl.isConnected);
   assert.equal(closes, 1);
  });
  await t.test('repeat weekday multiselect and multi-digit interval stay open and preserve legacy month-end', async () => {
   const x = fixture(m); x.item('repeat', { date: '2026-11-24' });
   const store = x.store(); await store.load();
   const item = () => store.items.find((value: any) => value.id === 'repeat');
   const picker = new Picker(x.app, item().date, '2026-11-24', async () => true, { rule: null, save: async (rule: any, date: string | null) => { await store.setRepeat('repeat', rule, date); return true; } });
   picker.open(); click(picker, '重复'); click(picker, '每周');
   await wait(() => item().repeat?.unit === 'week');
   const unit = picker.contentEl.querySelector('[aria-label="间隔单位"]') as HTMLSelectElement;
   unit.value = 'week'; unit.dispatchEvent(new win.Event('change'));
   click(picker, '周一'); click(picker, '周三');
   await wait(() => item().repeat?.weekdays?.length === 3);
   assert.equal(picker.contentEl.isConnected, true);
   const interval = picker.contentEl.querySelector('[aria-label="重复间隔"]') as HTMLInputElement;
   interval.value = '12'; interval.dispatchEvent(new win.Event('input'));
   picker.close(); await wait(() => !picker.contentEl.isConnected);
   assert.equal(item().repeat.interval, 12);
   const legacy = { unit: 'month', interval: 1, anchor: '2027-01-31' };
   let count = 0;
   const unchanged = new Picker({}, '2027-02-28', '2026-11-24', async () => true, { rule: legacy, save: async () => { count++; return true; } });
   unchanged.open(); click(unchanged, '重复'); unchanged.close();
   await wait(() => !unchanged.contentEl.isConnected); assert.equal(count, 0);
  });
  await t.test('batch partial failure retains details and selecting the original date restores both', async () => {
   let partial = true, closes = 0;
   const dates: (string | null)[] = ['2026-11-24', '2026-11-24'];
   const picker = new Picker({}, '2026-11-24', '2026-11-24', async (date: string | null) => {
    dates[0] = date; if (partial) return false; dates[1] = date; return true;
   }, undefined, undefined, { count: 2, mixed: false, anyDate: true, failureMessage: () => '已保存1/2', failureDetails: () => ['第二项未保存'], onClose: () => { closes++; } });
   picker.open(); click(picker, '2026-11-30'); await wait(() => picker.failed);
   assert.deepEqual(dates, ['2026-11-30', '2026-11-24']);
   assert.match(picker.contentEl.querySelector('.gvkit-arrange-batch-failures').textContent, /第二项未保存/);
   partial = false; click(picker, '2026-11-24'); await wait(() => !picker.contentEl.isConnected);
   assert.deepEqual(dates, ['2026-11-24', '2026-11-24']); assert.equal(closes, 1);
  });
 } finally {
  await m.close(); await win.happyDOM.close();
  for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; }
 }
});
