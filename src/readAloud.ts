import type { MarkdownView, WorkspaceLeaf } from 'obsidian';
import type { ReadAloudPreferences } from './publishSettings';
import { parser } from '@lezer/markdown';
import { removeGvkitStyleMarkup } from './formatting';

/** Convert only a spoken copy; the note and editor are never modified. */
export function spokenMarkdown(source: string): string {
	let text = removeGvkitStyleMarkup(source).replace(/\r\n?/g, '\n');
	const lines = text.split('\n');
	if (lines[0]?.trim() === '---') {
		const end = lines.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'));
		if (end > 0) text = lines.slice(end + 1).join('\n');
	}
	text = text.replace(/!?\[\[([^\]\n]+)\]\]/g, (_match, target: string) => {
		const parts = target.split('|');
		return parts[parts.length - 1] ?? '';
	}).replace(/%%[^]*?%%/g, '').replace(/\[([ xX])\](?=\s)/g, '');
	const removed: Array<{ from: number; to: number; replacement?: string }> = [];
	const silent = new Set(['HeaderMark', 'QuoteMark', 'ListMark', 'LinkMark', 'EmphasisMark',
		'CodeMark', 'CodeInfo', 'URL', 'LinkTitle', 'HTMLTag', 'HTMLBlock', 'Comment', 'CommentBlock', 'LinkReference', 'HorizontalRule']);
	parser.parse(text).iterate({ enter(node) {
		if (!silent.has(node.name)) return;
		const replacement = node.name === 'HTMLBlock'
			? text.slice(node.from, node.to).replace(/<!--[^]*?-->/g, '').replace(/<\/?[A-Za-z][^>]*>/g, '') : '';
		removed.push({ from: node.from, to: node.to, replacement });
		return false;
	} });
	let result = '', cursor = 0;
	for (const range of removed) {
		result += text.slice(cursor, range.from) + (range.replacement ?? '');
		cursor = range.to;
	}
	return (result + text.slice(cursor)).replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/** Short utterances avoid handing an entire long note to the iOS synthesizer. */
export function speechChunks(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 240) {
		let end = 240;
		for (let index = 239; index >= 80; index--) {
			if ('。！？.!?；;\n '.includes(remaining[index] ?? '')) { end = index + 1; break; }
		}
		// Do not split a UTF-16 surrogate pair.
		const previous = remaining.charCodeAt(end - 1);
		if (previous >= 0xd800 && previous <= 0xdbff) end--;
		chunks.push(remaining.slice(0, end));
		remaining = remaining.slice(end);
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

export interface ReadAloudHost {
	getPreferences?(): ReadAloudPreferences;
	getLeaves(): WorkspaceLeaf[];
	getActiveView(): MarkdownView | null;
	setIcon(button: HTMLElement, icon: string): void;
	notify(message: string): void;
}

interface Entry { leaf: WorkspaceLeaf; view: MarkdownView; button: HTMLElement }
interface Playback {
	entry: Entry;
	file: MarkdownView['file'];
	synth: SpeechSynthesis;
	utterance: SpeechSynthesisUtterance | null;
	timer: ReturnType<typeof setTimeout> | null;
}

export class DocumentReadAloud {
	private entries = new Map<WorkspaceLeaf, Entry>();
	private playback: Playback | null = null;
	private disposed = false;
	private host: ReadAloudHost;

	constructor(host: ReadAloudHost) { this.host = host; }

	refresh(): void {
		if (this.disposed) return;
		const leaves = this.host.getLeaves();
		for (const [leaf, entry] of this.entries) {
			if (!leaves.includes(leaf) || leaf.view !== entry.view || !entry.view.file || entry.view.file.extension !== 'md') {
				if (this.playback?.entry === entry) this.stop();
				entry.button.remove();
				this.entries.delete(leaf);
			}
		}
		if (this.playback && (this.playback.entry.view.file !== this.playback.file ||
			this.host.getActiveView() !== this.playback.entry.view)) this.stop();
		for (const leaf of leaves) {
			const view = leaf.view as MarkdownView;
			if (view.getViewType() !== 'markdown' || view.file?.extension !== 'md' || this.entries.has(leaf)) continue;
			const button = view.addAction('volume-2', '朗读当前文档', () => this.toggle(leaf));
			button.classList.add('gvkit-read-aloud');
			button.setAttribute('aria-pressed', 'false');
			this.entries.set(leaf, { leaf, view, button });
		}
	}

	/** Deliberately synchronous: iOS must receive speak() inside the user's tap. */
	toggle(leaf: WorkspaceLeaf): void {
		if (this.disposed) return;
		if (this.playback) { this.stop(); return; }
		const entry = this.entries.get(leaf);
		if (!entry || leaf.view !== entry.view || !entry.view.file || entry.view.file.extension !== 'md') return;
		const win = entry.view.containerEl.ownerDocument.defaultView;
		const Utterance = (win as (Window & typeof globalThis) | null)?.SpeechSynthesisUtterance;
		const synth = win?.speechSynthesis;
		if (!synth || !Utterance) { this.host.notify('当前设备未提供朗读能力。'); return; }
		try {
			// getViewData includes current editor changes and works in reading mode.
			const text = spokenMarkdown(entry.view.getViewData());
			const chunks = speechChunks(text);
			if (!chunks.length) { this.host.notify('当前文档没有可朗读的正文。'); return; }
			const preferences = this.host.getPreferences?.() ?? { voiceURI: '', rate: 1 };
			const voice = preferences.voiceURI ? synth.getVoices().find(value => value.voiceURI === preferences.voiceURI) : undefined;
			const playback: Playback = { entry, file: entry.view.file, synth, utterance: null, timer: null };
			this.playback = playback;
			synth.cancel();
			this.label(entry, '正在启动朗读，点击停止', true);
			let index = 0;
			const next = () => {
				if (this.playback !== playback) return;
				const chunk = chunks[index++];
				if (chunk === undefined) { this.stop(); return; }
				const utterance = new Utterance(chunk);
				utterance.lang = /\p{Script=Han}/u.test(text) ? 'zh-CN' : 'en-US';
				if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
				utterance.rate = preferences.rate;
				playback.utterance = utterance;
				const clearTimer = () => {
					if (playback.timer !== null) clearTimeout(playback.timer);
					playback.timer = null;
				};
				utterance.onstart = () => {
					if (this.playback !== playback) return;
					clearTimer();
					this.label(entry, '正在朗读，点击停止', true);
				};
				utterance.onend = () => {
					if (this.playback !== playback) return;
					clearTimer();
					try { next(); } catch { this.fail(playback); }
				};
				utterance.onerror = () => this.fail(playback);
				playback.timer = setTimeout(() => this.fail(playback), 8000);
				synth.speak(utterance);
			};
			next();
		} catch {
			this.stop();
			this.host.notify('朗读未能启动，请检查系统语音后重试。');
		}
	}

	stop(): void {
		const playback = this.playback;
		if (!playback) return;
		this.playback = null; // Ignore cancellation events from the previous speech.
		if (playback.timer !== null) clearTimeout(playback.timer);
		if (playback.utterance) {
			playback.utterance.onstart = playback.utterance.onend = playback.utterance.onerror = null;
		}
		try { playback.synth.cancel(); } finally { this.label(playback.entry, '朗读当前文档', false); }
	}

	destroy(): void {
		this.disposed = true;
		this.stop();
		for (const entry of this.entries.values()) entry.button.remove();
		this.entries.clear();
	}

	private fail(playback: Playback): void {
		if (this.playback !== playback) return;
		this.stop();
		this.host.notify('朗读未能继续，请检查系统语音后点击重试。');
	}

	private label(entry: Entry, title: string, playing: boolean): void {
		entry.button.setAttribute('aria-label', title);
		entry.button.setAttribute('aria-pressed', String(playing));
		this.host.setIcon(entry.button, playing ? 'square' : 'volume-2');
	}
}
