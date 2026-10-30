import { Modal, type App, type MarkdownView, type WorkspaceLeaf } from 'obsidian';
import type { ReadAloudPreferences } from './publishSettings';

export interface SpeechPreferencesStore {
	getReadAloudPreferences(): ReadAloudPreferences;
	setReadAloudPreferences(value: ReadAloudPreferences): Promise<void>;
}

/** Returns the listener cleanup used when the native modal closes. */
export function renderQuickSettings(root: HTMLElement, synth: SpeechSynthesis | undefined, store: SpeechPreferencesStore): () => void {
	const doc = root.ownerDocument;
	root.classList.add('gvkit-quick-settings');
	let choice = store.getReadAloudPreferences();
	let revision = 0, closed = false;
	const controls = doc.createElement('div'); controls.className = 'gvkit-quick-settings-controls'; root.append(controls);
	const row = (title: string) => {
		const label = doc.createElement('label');
		label.className = 'gvkit-quick-setting';
		const name = doc.createElement('span'); name.textContent = title;
		label.append(name); controls.append(label); return label;
	};
	const voice = doc.createElement('select');
	voice.setAttribute('aria-label', '朗读音色'); row('朗读音色').append(voice);
	const voiceStatus = doc.createElement('p'); voiceStatus.className = 'setting-item-description'; root.append(voiceStatus);
	const rate = doc.createElement('input');
	rate.type = 'range'; rate.min = '0.5'; rate.max = '2'; rate.step = '0.1'; rate.value = String(choice.rate);
	rate.setAttribute('aria-label', '朗读语速');
	const rateLabel = doc.createElement('span');
	row('朗读语速').append(rate, rateLabel);
	const updateRateLabel = () => { rateLabel.textContent = Number(rate.value).toFixed(1) + '×'; };
	updateRateLabel();
	rate.addEventListener('input', updateRateLabel);
	const status = doc.createElement('p'); status.setAttribute('role', 'status'); root.append(status);
	const refreshVoices = () => {
		voice.replaceChildren();
		const add = (value: string, title: string) => {
			const option = doc.createElement('option'); option.value = value; option.textContent = title; voice.append(option);
		};
		add('', '自动（沿用默认朗读）');
		const available = synth?.getVoices() ?? [];
		const voices = available.filter(item => /^zh(?:[-_]|$)/i.test(item.lang));
		for (const item of voices) add(item.voiceURI, item.name + ' · ' + item.lang);
		const selected = available.find(item => item.voiceURI === choice.voiceURI);
		const missing = choice.voiceURI && !selected;
		voice.value = voices.some(item => item.voiceURI === choice.voiceURI) ? choice.voiceURI : '';
		voiceStatus.textContent = !synth ? '当前设备未提供朗读能力。' : missing
			? '已保存的音色当前不可用，暂用自动音色；声库更新后会重新匹配。'
			: selected && !voices.includes(selected) ? '已保存的其他语言音色继续保留；可改选中文音色。'
			: !available.length ? '系统尚未返回音色列表，仍可用默认音色朗读。'
			: !voices.length ? '设备暂无中文音色，可使用自动朗读。' : '';
		voiceStatus.hidden = !voiceStatus.textContent;
	};
	const save = () => {
		const current = ++revision;
		status.textContent = '正在保存…';
		void store.setReadAloudPreferences({ ...choice }).then(() => {
			if (!closed && current === revision) status.textContent = '已保存，下次朗读生效。';
		}).catch(() => {
			if (closed || current !== revision) return;
			choice = store.getReadAloudPreferences(); rate.value = String(choice.rate);
			updateRateLabel(); refreshVoices(); status.textContent = '未能保存，请重新调整后重试。';
		});
	};
	voice.addEventListener('change', () => { choice.voiceURI = voice.value; refreshVoices(); save(); });
	rate.addEventListener('change', () => { choice.rate = Number(rate.value); save(); });
	synth?.addEventListener('voiceschanged', refreshVoices);
	refreshVoices();
	return () => { closed = true; synth?.removeEventListener('voiceschanged', refreshVoices); };
}

export class QuickSettingsModal extends Modal {
	private cleanup: (() => void) | null = null;
	constructor(app: App, private synth: SpeechSynthesis | undefined, private store: SpeechPreferencesStore) { super(app); }
	onOpen(): void {
		this.modalEl.classList.add('gvkit-quick-settings-modal');
		this.setTitle('GVKit 快捷设置');
		this.cleanup = renderQuickSettings(this.contentEl, this.synth, this.store);
	}
	onClose(): void { this.cleanup?.(); this.cleanup = null; this.contentEl.replaceChildren(); }
}

interface Entry { view: MarkdownView; button: HTMLElement; modeButton: HTMLElement | null }

export class DocumentQuickSettings {
	private entries = new Map<WorkspaceLeaf, Entry>();
	private disposed = false;
	constructor(private host: {
		getLeaves(): WorkspaceLeaf[];
		isMobile: boolean;
		openSettings(view: MarkdownView): void;
	}) {}

	refresh(): void {
		if (this.disposed) return;
		const leaves = this.host.getLeaves();
		for (const [leaf, entry] of this.entries) {
			if (!leaves.includes(leaf) || leaf.view !== entry.view || entry.view.file?.extension !== 'md') {
				entry.button.remove(); entry.modeButton?.classList.remove('gvkit-hide-mode-toggle'); this.entries.delete(leaf);
			}
		}
		for (const leaf of leaves) {
			const view = leaf.view as MarkdownView;
			if (view.getViewType() !== 'markdown' || view.file?.extension !== 'md') continue;
			let entry = this.entries.get(leaf);
			if (!entry) {
				const button = view.addAction('settings', 'GVKit 快捷设置', () => {
					if (!this.disposed && this.entries.get(leaf)?.view === view && leaf.view === view && view.file?.extension === 'md') this.host.openSettings(view);
				});
				button.classList.add('gvkit-quick-settings-action');
				entry = { view, button, modeButton: null }; this.entries.set(leaf, entry);
			}
			// Obsidian addAction prepends. Move this button itself to the actual right edge,
			// including after the native more-options button, without replacing any action.
			const actions = entry.button.parentElement;
			if (actions && actions.lastElementChild !== entry.button) actions.append(entry.button);
			// Native MarkdownView's dedicated switcher, verified against Obsidian 1.14.5.
			// No icon-name / translated-label matching and no other view actions touched.
			const modeButton = (view as MarkdownView & { modeButtonEl?: HTMLElement }).modeButtonEl;
			if (entry.modeButton !== modeButton) entry.modeButton?.classList.remove('gvkit-hide-mode-toggle');
			entry.modeButton = this.host.isMobile && modeButton && view.containerEl.contains(modeButton) ? modeButton : null;
			entry.modeButton?.classList.add('gvkit-hide-mode-toggle');
		}
	}

	destroy(): void {
		this.disposed = true;
		for (const entry of this.entries.values()) { entry.button.remove(); entry.modeButton?.classList.remove('gvkit-hide-mode-toggle'); }
		this.entries.clear();
	}
}
