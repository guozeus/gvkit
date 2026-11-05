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
		assert.equal(root.querySelector('button')!.textContent, '', 'idle banner has no fixed label or icon');
		assert.equal(root.querySelector('button')!.getAttribute('aria-label'), '展开或收起置顶提醒');
		state.tips = '第一条\n\n 第二条 '; state.tipsScrollSpeed = 50; tips.update(state);
		assert.equal(root.querySelector('button')!.textContent, '', 'saved tips do not appear until a user operation');
		assert.equal(tips.el.style.getPropertyValue('--gvkit-tips-text'), '#ffd76a');
		assert.equal(tips.el.style.getPropertyValue('--gvkit-tips-background'), '#6b3a91');
		Math.random = () => 0; tips.start(); assert.equal(tips.el.dataset.playing, 'horizontal');
		assert.equal(jobs[0].options.duration, 12000);
		tips.start(); tips.update({ ...state, rowHeight: 60 });
		root.querySelector('button')!.click(); assert.equal(root.querySelector('button')!.getAttribute('aria-expanded'), 'true');
		assert.equal(root.querySelectorAll('.gvkit-arrange-tips-all p').length, 2);
		root.querySelector('button')!.click(); assert.equal(root.querySelector('button')!.getAttribute('aria-expanded'), 'false');
		assert.equal(jobs.length, 1, 'no restart or overlap');
		tips.update({ ...state, tipsTextColor: '#ffffff', tipsBackgroundColor: '#442266' });
		assert.equal(tips.el.style.getPropertyValue('--gvkit-tips-text'), '#ffffff');
		assert.equal(tips.el.style.getPropertyValue('--gvkit-tips-background'), '#442266');
		assert.equal(jobs.length, 1, 'palette changes keep the playing round');
		jobs[0].finish(); await settle(); assert.equal(jobs[1].el.textContent, '第二条');
		jobs[1].finish(); await settle(); assert.equal(tips.el.dataset.playing, undefined);
		assert.equal(root.querySelector('.gvkit-arrange-tips-text')!.textContent, '', 'finished round returns to blank');
		Math.random = () => .9; tips.start(); assert.equal(tips.el.dataset.playing, 'vertical');
		assert.match(jobs[2].frames[0].transform, /100%/, 'first tip also floats in');
		jobs[2].finish(); await settle();
		assert.equal(jobs[3].options.duration, 7000, '3s hold plus readable long-line traversal');
		jobs[3].finish(); await settle(); assert.match(jobs[4].frames[1].transform, /-100%/);
		jobs[4].finish(); await settle(); assert.equal(jobs[5].el.textContent, '第二条');
		assert.match(jobs[5].frames[0].transform, /100%/);
		tips.destroy(); await settle(); tips.start(); assert.equal(jobs.length, 6, 'close cancels and cannot restart');
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
		const color = root.querySelector('[aria-label="提醒文字颜色"]') as any;
		color.value = '#ffe099'; color.dispatchEvent(new win.Event('change')); await settle();
		assert.deepEqual(changes[2], { tipsTextColor: '#ffe099' });
		const background = root.querySelector('[aria-label="提醒底板颜色"]') as any;
		background.value = '#552288'; background.dispatchEvent(new win.Event('change')); await settle();
		assert.deepEqual(changes[3], { tipsBackgroundColor: '#552288' });
		fail = true; content.value = '保留输入'; content.dispatchEvent(new win.Event('change')); await settle();
		assert.equal(content.value, '保留输入'); assert.match(root.textContent, /保存失败/);
	} finally { await win.happyDOM.abort(); }
});

test('a single vertical tip visibly enters and leaves; each idle round samples again', async () => {
	const win = new Window(), root = win.document.createElement('div'); win.document.body.append(root);
	const jobs: any[] = [];
	(win.HTMLElement.prototype as any).animate = function (frames: any, options: any) {
		let finish!: () => void;
		const finished = new Promise<void>(resolve => { finish = resolve; });
		const job = { frames, options, finished, finish, cancel() {} }; jobs.push(job); return job;
	};
	const original = Math.random;
	let samples = 0;
	try {
		const tips = new ArrangeTips(root as any), state = defaultArrangeState(); state.tips = '一条提醒';
		Object.defineProperty(root.querySelector('.gvkit-arrange-tips-viewport'), 'clientWidth', { value: 200 });
		Object.defineProperty(root.querySelector('.gvkit-arrange-tips-text'), 'scrollWidth', { value: 80 });
		tips.update(state); Math.random = () => { samples++; return .9; }; tips.start();
		assert.match(jobs[0].frames[0].transform, /translateY\(100%\)/);
		for (let n = 0; n < 3; n++) {
			tips.start(); tips.update({ ...state, rowHeight: 60 });
			assert.equal(samples, 1, 'active input and reload do not reroll or restart');
			if (n === 1) assert.equal(jobs[n].options.duration, 3000, 'default readable interval unchanged');
			if (n === 2) assert.match(jobs[n].frames[1].transform, /-100%/);
			jobs[n].finish(); await settle();
		}
		assert.equal(tips.el.dataset.playing, undefined);
		tips.start(); assert.equal(samples, 2); assert.equal(tips.el.dataset.playing, 'vertical', 'consecutive same modes remain possible');
		for (let n = 3; n < 6; n++) { jobs[n].finish(); await settle(); }
		Math.random = () => { samples++; return .1; }; tips.start();
		assert.equal(tips.el.dataset.playing, 'horizontal'); assert.equal(samples, 3);
		jobs[6].finish(); await settle(); tips.destroy();
	} finally { Math.random = original; await win.happyDOM.abort(); }
});
