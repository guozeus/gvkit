import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { ArrangeTips, renderArrangeTipsSettings } from '../src/arrangeTips.ts';
import { defaultArrangeState } from '../src/arrangeCore.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
test('one complete round survives clicks, expansion and state refresh; cancellation releases animations', async () => {
	const win = new Window(), root = win.document.createElement('div'); win.document.body.append(root);
	const jobs: any[] = [];
	(win.HTMLElement.prototype as any).animate = function (frames: any, options: any) {
		let finish: () => void, reject: () => void;
		const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
		const job = { frames, options, finished, finish: () => finish(), cancel: () => reject(), el: this };
		jobs.push(job); return job;
	};
	const oldRandom = Math.random;
	try {
		const tips = new ArrangeTips(root as any), state = defaultArrangeState();
		const viewport = root.querySelector('.gvkit-arrange-tips-viewport')!;
		Object.defineProperty(viewport, 'clientWidth', { value: 200 });
		Object.defineProperty(root.querySelector('.gvkit-arrange-tips-text'), 'scrollWidth', { value: 400 });
		tips.update(state); tips.start(); assert.equal(jobs.length, 0, 'empty content never plays');
		state.tips = '第一条\n\n 第二条 '; state.tipsScrollSpeed = 50; tips.update(state);
		Math.random = () => 0; tips.start(); assert.equal(tips.el.dataset.playing, 'horizontal');
		assert.equal(jobs[0].options.duration, 12000);
		tips.start(); tips.update({ ...state, rowHeight: 60 });
		root.querySelector('button')!.click(); assert.equal(root.querySelector('button')!.getAttribute('aria-expanded'), 'true');
		assert.equal(root.querySelectorAll('.gvkit-arrange-tips-all p').length, 2);
		root.querySelector('button')!.click(); assert.equal(root.querySelector('button')!.getAttribute('aria-expanded'), 'false');
		assert.equal(jobs.length, 1, 'no restart or overlap');
		jobs[0].finish(); await settle(); assert.equal(jobs[1].el.textContent, '第二条');
		jobs[1].finish(); await settle(); assert.equal(tips.el.dataset.playing, undefined);
		assert.equal(root.querySelector('.gvkit-arrange-tips-text')!.textContent, '第一条');
		Math.random = () => .9; tips.start(); assert.equal(tips.el.dataset.playing, 'vertical');
		assert.equal(jobs[2].options.duration, 7000, '3s hold plus readable long-line traversal');
		jobs[2].finish(); await settle(); assert.match(jobs[3].frames[1].transform, /-100%/);
		jobs[3].finish(); await settle(); assert.equal(jobs[4].el.textContent, '第二条');
		assert.match(jobs[4].frames[0].transform, /100%/);
		tips.destroy(); await settle(); tips.start(); assert.equal(jobs.length, 5, 'close cancels and cannot restart');
	} finally { Math.random = oldRandom; await win.happyDOM.abort(); }
});

test('shared settings retain text after failure, validate positive timing and save only the edited preference', async () => {
	const win = new Window(), root = win.document.createElement('div');
	const changes: any[] = []; let fail = false, refreshed = 0;
	const store = { state: defaultArrangeState(), configure: async (patch: any) => {
		if (fail) throw Error('disk'); changes.push(patch); Object.assign(store.state, patch);
	} };
	try {
		renderArrangeTipsSettings(root as any, store as any, () => refreshed++);
		const content = root.querySelector('textarea')!; content.value = '提醒甲\n提醒乙'; content.dispatchEvent(new win.Event('change')); await settle();
		assert.deepEqual(changes, [{ tips: '提醒甲\n提醒乙' }]); assert.equal(refreshed, 1);
		const interval = root.querySelector('[aria-label="上浮间隔"]') as any;
		interval.value = '0'; interval.dispatchEvent(new win.Event('change')); await settle(); assert.equal(changes.length, 1);
		interval.value = '5'; interval.dispatchEvent(new win.Event('change')); await settle(); assert.deepEqual(changes[1], { tipsInterval: 5 });
		fail = true; content.value = '保留输入'; content.dispatchEvent(new win.Event('change')); await settle();
		assert.equal(content.value, '保留输入'); assert.match(root.textContent, /保存失败/);
	} finally { await win.happyDOM.abort(); }
});
