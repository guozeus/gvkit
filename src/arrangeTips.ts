import type { ArrangeState } from './arrangeCore';
import type { ArrangeStore } from './arrangeStore';

/** One view-local playback; content and preferences remain in ArrangeStore. */
export class ArrangeTips {
	readonly el: HTMLElement;
	private button: HTMLButtonElement;
	private viewport: HTMLElement;
	private text: HTMLElement;
	private all: HTMLElement;
	private lines: string[] = [];
	private animations: Animation[] = [];
	private playing = false;
	private closed = false;
	private speed = 45;
	private interval = 3;
	constructor(parent: HTMLElement) {
		const doc = parent.ownerDocument;
		this.el = doc.createElement('div'); this.el.className = 'gvkit-arrange-tips'; parent.append(this.el);
		this.button = doc.createElement('button'); this.button.type = 'button';
		this.button.className = 'gvkit-arrange-tips-toggle'; this.button.setAttribute('aria-expanded', 'false');
		this.button.setAttribute('aria-label', '展开或收起置顶提醒');
		this.viewport = doc.createElement('span'); this.viewport.className = 'gvkit-arrange-tips-viewport';
		this.text = doc.createElement('span'); this.text.className = 'gvkit-arrange-tips-text'; this.viewport.append(this.text);
		this.button.append(this.viewport); this.el.append(this.button);
		this.all = doc.createElement('div'); this.all.className = 'gvkit-arrange-tips-all'; this.all.hidden = true; this.el.append(this.all);
		this.button.onclick = () => {
			this.all.hidden = !this.all.hidden;
			this.button.setAttribute('aria-expanded', String(!this.all.hidden));
		};
	}
	update(state: ArrangeState): void {
		this.speed = state.tipsScrollSpeed; this.interval = state.tipsInterval;
		this.el.style.setProperty('--gvkit-tips-text', state.tipsTextColor);
		this.el.style.setProperty('--gvkit-tips-background', state.tipsBackgroundColor);
		const lines = state.tips.split('\n').map(line => line.trim()).filter(Boolean);
		if (JSON.stringify(lines) === JSON.stringify(this.lines) && this.all.childNodes.length) return;
		this.lines = lines;
		if (!lines.length) for (const animation of this.animations) animation.cancel();
		this.all.replaceChildren();
		for (const line of lines) {
			const p = this.el.ownerDocument.createElement('p'); p.textContent = line; this.all.append(p);
		}
		if (!lines.length) this.all.textContent = '在快捷设置中添加提醒，每行一条。';
		// An active round keeps its snapshot. Ordinary Vault reloads never restart it.
		if (!this.playing) this.idle();
	}
	private idle(): void {
		this.text.textContent = '';
		this.button.title = '点击展开或收起全部置顶提醒';
		delete this.el.dataset.playing;
	}
	start(): void {
		if (this.closed || this.playing || !this.lines.length || !this.viewport.clientWidth) return;
		this.playing = true;
		const mode = Math.random() < .5 ? 'horizontal' : 'vertical';
		this.el.dataset.playing = mode;
		void this.play([...this.lines], mode, this.speed, this.interval);
	}
	private async animate(frames: Keyframe[], duration: number): Promise<void> {
		const animation = this.text.animate(frames, { duration, fill: 'forwards', easing: 'linear' });
		this.animations.push(animation);
		await animation.finished;
		animation.cancel();
		this.animations = this.animations.filter(value => value !== animation);
	}
	private async play(lines: string[], mode: string, speed: number, interval: number): Promise<void> {
		try {
			for (let i = 0; i < lines.length; i++) {
				if (this.closed) return;
				this.text.textContent = lines[i]!;
				const width = this.viewport.clientWidth, length = this.text.scrollWidth;
				if (mode === 'horizontal') {
					await this.animate([{ transform: `translateX(${width}px)` }, { transform: `translateX(${-length}px)` }], (width + length) / speed * 1000);
				} else {
					await this.animate([{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], 220);
					const overflow = Math.max(0, length - width);
					// Long tips remain one line but travel fully into view before switching.
					const duration = interval * 1000 + overflow / speed * 1000;
					const hold = interval * 500 / duration;
					await this.animate([
						{ transform: 'translateX(0)', offset: 0 }, { transform: 'translateX(0)', offset: hold },
						{ transform: `translateX(${-overflow}px)`, offset: 1 - hold }, { transform: `translateX(${-overflow}px)`, offset: 1 },
					], duration);
					await this.animate([{ transform: `translate(${-overflow}px, 0)`, opacity: 1 }, { transform: `translate(${-overflow}px, -100%)`, opacity: 0 }], 220);
				}
			}
		} catch { /* Closing the view cancels its animations. */ }
		finally { this.playing = false; if (!this.closed) this.idle(); }
	}
	destroy(): void { this.closed = true; for (const animation of this.animations) animation.cancel(); this.animations = []; }
}

/** Shared by the existing quick modal and Arrange settings; no second store format. */
export function renderArrangeTipsSettings(root: HTMLElement, store: ArrangeStore, changed: () => void = () => {}): void {
	const doc = root.ownerDocument;
	const section = doc.createElement('section'); section.className = 'gvkit-tips-settings'; root.append(section);
	const heading = doc.createElement('h3'); heading.textContent = '置顶提醒 Tips'; section.append(heading);
	const caption = doc.createElement('p'); caption.textContent = '每行一条，自动保存并随 Vault 同步；点击广播可展开全部。'; section.append(caption);
	const content = doc.createElement('textarea'); content.rows = 4; content.value = store.state.tips;
	content.placeholder = '在这里写下想反复看到的重要提醒…'; content.setAttribute('aria-label', '置顶提醒内容'); section.append(content);
	const status = doc.createElement('p'); status.setAttribute('role', 'status');
	let revision = 0;
	const save = (patch: Partial<ArrangeState>) => {
		const current = ++revision; status.textContent = '正在保存…';
		void store.configure(patch).then(() => { changed(); if (current === revision) status.textContent = '已保存'; })
			.catch(() => { if (current === revision) status.textContent = '保存失败，内容已保留，请修改后重试。'; });
	};
	content.addEventListener('change', () => save({ tips: content.value }));
	for (const [key, title, unit] of [['tipsScrollSpeed', '横向速度', '像素/秒'], ['tipsInterval', '上浮间隔', '秒']] as const) {
		const label = doc.createElement('label'); label.textContent = `${title}（${unit}）`;
		const input = doc.createElement('input'); input.type = 'number'; input.min = '0.1'; input.step = 'any';
		input.value = String(store.state[key]); input.setAttribute('aria-label', title); label.append(input); section.append(label);
		input.addEventListener('change', () => {
			const value = Number(input.value);
			if (!input.value.trim() || !Number.isFinite(value) || value <= 0) { status.textContent = '请输入大于0的数值。'; return; }
			save({ [key]: value });
		});
	}
	for (const [key, title] of [['tipsTextColor', '提醒文字颜色'], ['tipsBackgroundColor', '提醒底板颜色']] as const) {
		const label = doc.createElement('label'); label.textContent = title;
		const input = doc.createElement('input'); input.type = 'color'; input.value = store.state[key];
		input.setAttribute('aria-label', title); label.append(input); section.append(label);
		input.addEventListener('change', () => save({ [key]: input.value }));
	}
	section.append(status);
}
