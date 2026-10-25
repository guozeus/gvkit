// Temporary, opt-in device diagnosis. No Vault writes, text values, identifiers,
// network requests or persistent settings. Remove after the iPhone cause is known.
type Mode = 'current' | 'off';
const number = (value: number) => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
const pixels = (value: string) => number(parseFloat(value));

export class ArrangeKeyboardDiagnostics {
	mode: Mode | null = null;
	private samples: Record<Mode, { checkpoints: object[]; events: object[] }> = {
		current: { checkpoints: [], events: [] }, off: { checkpoints: [], events: [] },
	};
	private timers: number[] = [];
	private started = 0;
	private lastEvent = -Infinity;
	private probe: HTMLDivElement | null = null;
	private root: HTMLElement;
	private apply: () => void;
	private win: Window;

	constructor(root: HTMLElement, apply: () => void) {
		this.root = root; this.apply = apply; this.win = root.ownerDocument.defaultView!;
	}
	get compensationOff(): boolean { return this.mode === 'off'; }
	get active(): boolean { return this.mode !== null; }
	select(mode: Mode): void {
		if (!this.active) {
			this.started = this.win.performance.now();
			this.probe = this.root.ownerDocument.createElement('div');
			this.probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:0;height:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
			this.root.append(this.probe);
			for (const name of ['pointerdown', 'focusin', 'focusout']) this.root.addEventListener(name, this.onFocus, true);
		}
		this.cancelTimers();
		this.capture('mode-leave');
		this.mode = mode;
		this.lastEvent = -Infinity;
		this.capture('mode-before');
		this.apply();
		this.schedule('mode-after');
	}
	private onFocus = (event: Event): void => {
		if (!(event.target as HTMLElement | null)?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
		if (event.type === 'pointerdown') this.capture('before-focus');
		else this.schedule(event.type);
	};
	private cancelTimers(): void { for (const id of this.timers) this.win.clearTimeout(id); this.timers = []; }
	private schedule(reason: string): void {
		this.cancelTimers();
		this.capture(reason);
		for (const delay of [100, 300, 600, 1000, 1500]) {
			this.timers.push(this.win.setTimeout(() => this.capture(`${reason}+${delay}ms`), delay));
		}
	}
	// Called AFTER the existing fit calculation, retaining its previous padding.
	recordFit(reason: string, previousPadding: string): void {
		if (!this.active) return;
		const now = this.win.performance.now();
		if (previousPadding === this.root.style.paddingBottom && now - this.lastEvent < 100) return;
		this.lastEvent = now;
		this.capture(reason, pixels(previousPadding || '0'), true);
	}
	private box(el: Element | null): Array<number | null> | null {
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return [r.top, r.bottom, r.height, r.width].map(number);
	}
	private layer(el: HTMLElement): object {
		const css = this.win.getComputedStyle(el);
		return {
			box: this.box(el),
			// Fixed numeric schema: never serialize classes, IDs, text or CSS strings.
			layout: [el.clientHeight, el.offsetHeight, el.scrollHeight, el.scrollTop, el.offsetTop,
				pixels(css.paddingTop), pixels(css.paddingBottom), pixels(css.marginTop), pixels(css.marginBottom)],
			sizing: [pixels(css.height), pixels(css.minHeight), pixels(css.maxHeight), pixels(css.flexBasis),
				pixels(css.flexGrow), pixels(css.flexShrink), css.transform && css.transform !== 'none' ? 1 : 0],
		};
	}
	private capture(reason: string, previousPadding: number | null = null, event = false): void {
		if (!this.mode) return;
		const root = this.root, doc = root.ownerDocument, viewport = this.win.visualViewport;
		const composer = root.querySelector<HTMLElement>('.gvkit-arrange-composer');
		const active = doc.activeElement;
		const ancestors = [];
		let parent = root.parentElement;
		for (let i = 0; parent && i < 5; i++, parent = parent.parentElement) ancestors.push(this.layer(parent));
		const css = this.win.getComputedStyle(root);
		const env = this.probe ? this.win.getComputedStyle(this.probe) : null;
		const samples = this.samples[this.mode][event ? 'events' : 'checkpoints'];
		samples.push({
			ms: number(this.win.performance.now() - this.started), reason,
			focus: composer?.contains(active) ? 1 : root.contains(active) ? 2 : 0,
			viewport: viewport ? [viewport.width, viewport.height, viewport.offsetLeft, viewport.offsetTop, viewport.scale, viewport.pageTop].map(number) : null,
			window: [this.win.innerWidth, this.win.innerHeight, this.win.scrollY, doc.documentElement.clientHeight].map(number),
			previousPadding, inlinePadding: pixels(root.style.paddingBottom || '0'),
			safeArea: [env ? pixels(env.paddingTop) : null, env ? pixels(env.paddingBottom) : null,
				pixels(css.getPropertyValue('--safe-area-inset-top')), pixels(css.getPropertyValue('--safe-area-inset-bottom')),
				pixels(css.getPropertyValue('--keyboard-height'))],
			body: this.layer(doc.body), ancestors, root: this.layer(root),
			header: this.box(root.querySelector('.gvkit-arrange-header')), area: this.box(root.querySelector('.gvkit-arrange-area')),
			composer: composer ? this.layer(composer) : null,
			input: this.box(composer?.querySelector('textarea') ?? null), button: this.box(composer?.querySelector('button') ?? null),
		});
		// Retain both sides of the A/B comparison, including post-animation readings.
		// Event bursts must not evict the timed focus/animation checkpoints.
		if (samples.length > (event ? 12 : 20)) samples.shift();
	}
	serialize(): string {
		return JSON.stringify({
			build: '0.6.5-keyboard-spacing-1', mode: this.mode,
			legend: {
				box: 'top,bottom,height,width', layout: 'clientHeight,offsetHeight,scrollHeight,scrollTop,offsetTop,paddingTop,paddingBottom,marginTop,marginBottom',
				sizing: 'height,minHeight,maxHeight,flexBasis,flexGrow,flexShrink,hasTransform',
				viewport: 'width,height,offsetLeft,offsetTop,scale,pageTop', window: 'innerWidth,innerHeight,scrollY,documentClientHeight',
				safeArea: 'envTop,envBottom,hostSafeTop,hostSafeBottom,hostKeyboardHeight', focus: '0=outside,1=composer,2=otherArrange',
				ancestors: 'parent first, up to five levels', missing: 'null means unavailable or nonnumeric',
			},
			samples: this.samples,
		});
	}
	stop(): void { this.dispose(); this.apply(); }
	dispose(): void {
		this.cancelTimers();
		for (const name of ['pointerdown', 'focusin', 'focusout']) this.root.removeEventListener(name, this.onFocus, true);
		this.probe?.remove(); this.probe = null;
		this.mode = null;
		this.samples = { current: { checkpoints: [], events: [] }, off: { checkpoints: [], events: [] } };
	}
}
