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

export interface SourceSelectionResult {
	source: string;
	selectionFrom: number;
	selectionTo: number;
}

interface SourceStyleRange {
	kind: 'text' | 'bg';
	color: GvkitColor;
	open: string;
	close: string;
	fullFrom: number;
	contentFrom: number;
	contentTo: number;
	fullTo: number;
}

function collectSourceStyleRanges(source: string): SourceStyleRange[] {
	const ranges: SourceStyleRange[] = [];

	for (const match of source.matchAll(/~=\{gv-(blue|purple)\}([^\n]*?)=~/gu)) {
		const fullFrom = match.index ?? 0;
		const color = match[1] as GvkitColor;
		const open = `~={gv-${color}}`;
		const close = '=~';
		ranges.push({
			kind: 'text',
			color,
			open,
			close,
			fullFrom,
			contentFrom: fullFrom + open.length,
			contentTo: fullFrom + match[0].length - close.length,
			fullTo: fullFrom + match[0].length,
		});
	}

	for (const match of source.matchAll(/==([🔵🟣])([^\n]*?)==/gu)) {
		const fullFrom = match.index ?? 0;
		const marker = match[1] ?? '';
		const color = backgroundColorFromMarker(marker);
		const open = `==${marker}`;
		const close = '==';
		ranges.push({
			kind: 'bg',
			color,
			open,
			close,
			fullFrom,
			contentFrom: fullFrom + open.length,
			contentTo: fullFrom + match[0].length - close.length,
			fullTo: fullFrom + match[0].length,
		});
	}

	return ranges;
}

function findEnclosingRange(
	source: string,
	selectionFrom: number,
	selectionTo: number,
	kind: 'text' | 'bg',
): SourceStyleRange | null {
	const candidates = collectSourceStyleRanges(source)
		.filter((range) => range.kind === kind)
		.filter((range) =>
			(range.contentFrom <= selectionFrom && range.contentTo >= selectionTo) ||
			(range.fullFrom === selectionFrom && range.fullTo === selectionTo),
		)
		.sort((a, b) => (a.contentTo - a.contentFrom) - (b.contentTo - b.contentFrom));
	return candidates[0] ?? null;
}

function replaceSourceRange(source: string, from: number, to: number, replacement: string): string {
	return source.slice(0, from) + replacement + source.slice(to);
}

function removeStyleRange(
	source: string,
	selectionFrom: number,
	selectionTo: number,
	range: SourceStyleRange,
): SourceSelectionResult {
	const selectedFullWrapper = selectionFrom === range.fullFrom && selectionTo === range.fullTo;
	const withoutClose = replaceSourceRange(source, range.contentTo, range.fullTo, '');
	const nextSource = replaceSourceRange(withoutClose, range.fullFrom, range.contentFrom, '');

	if (selectedFullWrapper) {
		return {
			source: nextSource,
			selectionFrom: range.fullFrom,
			selectionTo: range.fullFrom + (range.contentTo - range.contentFrom),
		};
	}

	return {
		source: nextSource,
		selectionFrom: selectionFrom - range.open.length,
		selectionTo: selectionTo - range.open.length,
	};
}

/**
 * Applies/toggles a style using the whole source so a user can select only the
 * visible text while gvkit markers remain hidden outside the selection.
 */
export function applyStyleToSourceSelection(
	source: string,
	selectionFrom: number,
	selectionTo: number,
	action: StyleAction,
): SourceSelectionResult {
	if (selectionFrom === selectionTo) return { source, selectionFrom, selectionTo };
	if (selectionFrom > selectionTo) [selectionFrom, selectionTo] = [selectionTo, selectionFrom];

	const rawSelection = source.slice(selectionFrom, selectionTo);
	if (rawSelection.includes('\n')) {
		const replacement = applyGvkitStyleMarkup(rawSelection, action);
		return {
			source: replaceSourceRange(source, selectionFrom, selectionTo, replacement),
			selectionFrom,
			selectionTo: selectionFrom + replacement.length,
		};
	}

	if (action === 'clear') {
		let result: SourceSelectionResult = { source, selectionFrom, selectionTo };
		for (const kind of ['text', 'bg'] as const) {
			const range = findEnclosingRange(result.source, result.selectionFrom, result.selectionTo, kind);
			if (range) {
				result = removeStyleRange(
					result.source,
					result.selectionFrom,
					result.selectionTo,
					range,
				);
			}
		}
		if (result.source !== source) return result;

		const selected = source.slice(selectionFrom, selectionTo);
		const replacement = removeGvkitStyleMarkup(selected);
		return {
			source: replaceSourceRange(source, selectionFrom, selectionTo, replacement),
			selectionFrom,
			selectionTo: selectionFrom + replacement.length,
		};
	}

	const wrapper = WRAPPERS[action];
	const existing = findEnclosingRange(source, selectionFrom, selectionTo, wrapper.kind);
	if (existing) {
		if (existing.color === wrapper.color) {
			return removeStyleRange(source, selectionFrom, selectionTo, existing);
		}

		const nextSource = replaceSourceRange(source, existing.fullFrom, existing.contentFrom, wrapper.open);
		const delta = wrapper.open.length - existing.open.length;
		const selectedFullWrapper = selectionFrom === existing.fullFrom && selectionTo === existing.fullTo;
		return {
			source: nextSource,
			selectionFrom: selectedFullWrapper ? existing.fullFrom : selectionFrom + delta,
			selectionTo: selectedFullWrapper ? selectionTo + delta : selectionTo + delta,
		};
	}

	// If the visible selection is already inside a normal Obsidian highlight,
	// upgrade that highlight to the requested colored highlight instead of nesting.
	if (wrapper.kind === 'bg') {
		const before = source.slice(Math.max(0, selectionFrom - 2), selectionFrom);
		const after = source.slice(selectionTo, selectionTo + 2);
		if (before === '==' && after === '==') {
			const marker = wrapper.open.slice(2);
			const nextSource = source.slice(0, selectionFrom) + marker + source.slice(selectionFrom);
			return {
				source: nextSource,
				selectionFrom: selectionFrom + marker.length,
				selectionTo: selectionTo + marker.length,
			};
		}
	}

	const selected = source.slice(selectionFrom, selectionTo);
	const replacement = `${wrapper.open}${selected}${wrapper.close}`;
	return {
		source: replaceSourceRange(source, selectionFrom, selectionTo, replacement),
		selectionFrom: selectionFrom + wrapper.open.length,
		selectionTo: selectionTo + wrapper.open.length,
	};
}
