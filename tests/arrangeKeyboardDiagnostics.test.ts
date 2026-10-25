import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { ArrangeKeyboardDiagnostics } from '../src/arrangeKeyboardDiagnostics.ts';

test('device diagnosis preserves timed A/B geometry, excludes content, and leaves no timers or storage', async () => {
	const win = new Window();
	win.document.body.innerHTML = '<div id="private-vault-path"><main><div class="gvkit-arrange-header">PRIVATE TITLE</div><div class="gvkit-arrange-area">PRIVATE BODY</div><div class="gvkit-arrange-composer"><textarea></textarea><button>PRIVATE BUTTON</button></div></main></div>';
	const root = win.document.querySelector('main')!;
	const input = root.querySelector('textarea')!;
	input.value = 'PRIVATE DRAFT'; root.dataset.secret = 'PRIVATE TOKEN';
	root.style.setProperty('--safe-area-inset-bottom', '34px');
	const viewport = { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0 };
	Object.defineProperty(win, 'visualViewport', { value: viewport });
	let now = 0, nextId = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	Object.defineProperty(win.performance, 'now', { value: () => now });
	win.setTimeout = ((run: () => void, delay: number) => { const id = ++nextId; timers.set(id, { at: now + delay, run }); return id; }) as any;
	win.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
	const advance = (to: number) => {
		for (;;) {
			const entry = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
			if (!entry) break;
			now = entry[1].at; timers.delete(entry[0]); entry[1].run();
		}
		now = to;
	};
	const diagnostic = new ArrangeKeyboardDiagnostics(root as unknown as HTMLElement, () => {
		root.style.paddingBottom = diagnostic.compensationOff ? '' : '300px';
	});
	try {
		input.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
		assert.equal(timers.size, 0, 'no sampling before opt-in');
		diagnostic.select('current');
		input.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
		input.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
		advance(300);
		viewport.height = 500; root.style.paddingBottom = '344px';
		diagnostic.recordFit('viewport-resize', '300px');
		advance(1500);
		let data = JSON.parse(diagnostic.serialize());
		assert.equal(data.build, '0.6.5-keyboard-spacing-1');
		const focus = data.samples.current.checkpoints.filter((x: any) => x.reason.startsWith('focusin'));
		assert.deepEqual(focus.map((x: any) => x.ms), [0, 100, 300, 600, 1000, 1500]);
		assert.equal(focus[2].inlinePadding, 300);
		assert.equal(focus[3].inlinePadding, 344);
		assert.equal(focus[3].viewport[1], 500);
		assert.equal(focus[3].safeArea[3], 34);
		// Layout events cannot erase the first correct position during animation.
		for (let i = 0; i < 50; i++) diagnostic.recordFit('host-resize', '0px');
		data = JSON.parse(diagnostic.serialize());
		assert.equal(data.samples.current.events.length, 12);
		assert.deepEqual(data.samples.current.checkpoints.filter((x: any) => x.reason.startsWith('focusin')), focus);
		diagnostic.select('off');
		assert.equal(root.style.paddingBottom, '');
		input.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true })); advance(3000);
		data = JSON.parse(diagnostic.serialize());
		assert.ok(data.samples.current.checkpoints.length > 0 && data.samples.off.checkpoints.length > 0);
		assert.equal(data.samples.off.checkpoints.at(-1).inlinePadding, 0);
		assert.ok(!diagnostic.serialize().includes('PRIVATE'));
		assert.ok(!diagnostic.serialize().includes('private-vault-path'));
		assert.equal(win.localStorage.length, 0); assert.equal(win.sessionStorage.length, 0);
		input.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
		assert.ok(timers.size > 0);
		diagnostic.stop();
		assert.equal(timers.size, 0); assert.equal(root.children.length, 3);
		assert.equal(root.style.paddingBottom, '300px');
		assert.equal(diagnostic.active, false);
		input.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
		assert.equal(timers.size, 0);
		data = JSON.parse(diagnostic.serialize());
		assert.equal(data.samples.current.checkpoints.length + data.samples.off.checkpoints.length, 0);
	} finally { diagnostic.dispose(); await win.happyDOM.close(); }
});
