export type StyleAction =
	| 'text-blue'
	| 'text-purple'
	| 'bg-blue'
	| 'bg-purple'
	| 'clear';

export type GvkitColor = 'blue' | 'purple';

interface Wrapper {
	open: string;
	close: string;
	kind: 'text' | 'bg';
	color: GvkitColor;
}

/**
 * Text color uses gvkit's lightweight source syntax.
 * Background color intentionally follows Obsidian 1.14's native colored-highlight syntax.
 */
export const WRAPPERS: Record<Exclude<StyleAction, 'clear'>, Wrapper> = {
	'text-blue': {
		open: '~={gv-blue}',
		close: '=~',
		kind: 'text',
		color: 'blue',
	},
	'text-purple': {
		open: '~={gv-purple}',
		close: '=~',
		kind: 'text',
		color: 'purple',
	},
	'bg-blue': {
		open: '==🔵',
		close: '==',
		kind: 'bg',
		color: 'blue',
	},
	'bg-purple': {
		open: '==🟣',
		close: '==',
		kind: 'bg',
		color: 'purple',
	},
};

const TEXT_WRAPPER_RE = /^~=\{gv-(blue|purple)\}([\s\S]*)=~$/u;
const BG_WRAPPER_RE = /^==([🔵🟣])([\s\S]*)==$/u;
const STANDARD_HIGHLIGHT_RE = /^==([\s\S]*)==$/u;

// Legacy 0.1.0 HTML markup remains removable so test notes are not stranded.
const LEGACY_TEXT_WRAPPER_RE = /^<span class="gvkit-text-(blue|purple)">([\s\S]*)<\/span>$/u;
const LEGACY_BG_WRAPPER_RE = /^<mark class="gvkit-bg-(blue|purple)">([\s\S]*)<\/mark>$/u;
const COMPLETE_LEGACY_TEXT_RE = /<span class="gvkit-text-(?:blue|purple)">([\s\S]*?)<\/span>/gu;
const COMPLETE_LEGACY_BG_RE = /<mark class="gvkit-bg-(?:blue|purple)">([\s\S]*?)<\/mark>/gu;
const COMPLETE_TEXT_RE = /~=\{gv-(?:blue|purple)\}([\s\S]*?)=~/gu;
const COMPLETE_BG_RE = /==[🔵🟣]([\s\S]*?)==/gu;

function backgroundColorFromMarker(marker: string): GvkitColor {
	return marker === '🔵' ? 'blue' : 'purple';
}

/** Removes only gvkit color layers; unrelated Markdown/HTML remains untouched. */
export function removeGvkitStyleMarkup(text: string): string {
	let previous = '';
	let next = text;

	while (next !== previous) {
		previous = next;
		next = next
			.replace(COMPLETE_TEXT_RE, '$1')
			.replace(COMPLETE_BG_RE, '$1')
			.replace(COMPLETE_LEGACY_TEXT_RE, '$1')
			.replace(COMPLETE_LEGACY_BG_RE, '$1');
	}

	return next;
}

function unwrapSameKind(line: string, kind: 'text' | 'bg'): { color: GvkitColor; inner: string } | null {
	if (kind === 'text') {
		const modern = line.match(TEXT_WRAPPER_RE);
		if (modern) return { color: modern[1] as GvkitColor, inner: modern[2] ?? '' };

		const legacy = line.match(LEGACY_TEXT_WRAPPER_RE);
		if (legacy) return { color: legacy[1] as GvkitColor, inner: legacy[2] ?? '' };
		return null;
	}

	const modern = line.match(BG_WRAPPER_RE);
	if (modern) return { color: backgroundColorFromMarker(modern[1] ?? ''), inner: modern[2] ?? '' };

	const legacy = line.match(LEGACY_BG_WRAPPER_RE);
	if (legacy) return { color: legacy[1] as GvkitColor, inner: legacy[2] ?? '' };
	return null;
}

function styleSingleLine(line: string, action: Exclude<StyleAction, 'clear'>): string {
	if (line.length === 0) return line;

	const wrapper = WRAPPERS[action];
	const existing = unwrapSameKind(line, wrapper.kind);
	if (existing) {
		if (existing.color === wrapper.color) return existing.inner;
		return `${wrapper.open}${existing.inner}${wrapper.close}`;
	}

	// Convert a normal Obsidian highlight into a colored highlight instead of nesting highlights.
	if (wrapper.kind === 'bg') {
		const standardHighlight = line.match(STANDARD_HIGHLIGHT_RE);
		if (standardHighlight) {
			return `${wrapper.open}${standardHighlight[1] ?? ''}${wrapper.close}`;
		}
	}

	return `${wrapper.open}${line}${wrapper.close}`;
}

/**
 * Applies one independent color layer to the selected source text.
 * Lines are handled independently so inline formatting never spans Markdown blocks.
 */
export function applyGvkitStyleMarkup(text: string, action: StyleAction): string {
	if (action === 'clear') return removeGvkitStyleMarkup(text);
	if (text.length === 0) return text;

	return text
		.split('\n')
		.map((line) => styleSingleLine(line, action))
		.join('\n');
}
