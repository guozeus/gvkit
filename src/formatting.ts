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
 * Background color uses its own gvkit layer as well, avoiding Obsidian's default yellow highlight.
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
		open: '~={gv-bg-blue}',
		close: '=bg~',
		kind: 'bg',
		color: 'blue',
	},
	'bg-purple': {
		open: '~={gv-bg-purple}',
		close: '=bg~',
		kind: 'bg',
		color: 'purple',
	},
};

const TEXT_WRAPPER_RE = /^~=\{gv-(blue|purple)\}([\s\S]*)=~$/u;
const BG_WRAPPER_RE = /^~=\{gv-bg-(blue|purple)\}([\s\S]*)=bg~$/u;
const STANDARD_HIGHLIGHT_RE = /^==([\s\S]*)==$/u;

// Legacy 0.1.0 HTML markup remains removable so test notes are not stranded.
const LEGACY_TEXT_WRAPPER_RE = /^<span class="gvkit-text-(blue|purple)">([\s\S]*)<\/span>$/u;
const LEGACY_BG_WRAPPER_RE = /^<mark class="gvkit-bg-(blue|purple)">([\s\S]*)<\/mark>$/u;
const COMPLETE_LEGACY_TEXT_RE = /<span class="gvkit-text-(?:blue|purple)">([\s\S]*?)<\/span>/gu;
const COMPLETE_LEGACY_BG_RE = /<mark class="gvkit-bg-(?:blue|purple)">([\s\S]*?)<\/mark>/gu;
const COMPLETE_TEXT_RE = /~=\{gv-(?:blue|purple)\}([\s\S]*?)=~/gu;
const COMPLETE_BG_RE = /~=\{gv-bg-(?:blue|purple)\}([\s\S]*?)=bg~/gu;
const LEGACY_NATIVE_BG_WRAPPER_RE = /^==([🔵🟣])([\s\S]*)==$/u;
const COMPLETE_LEGACY_NATIVE_BG_RE = /==[🔵🟣]([\s\S]*?)==/gu;

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
			.replace(COMPLETE_LEGACY_NATIVE_BG_RE, '$1')
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
	if (modern) return { color: modern[1] as GvkitColor, inner: modern[2] ?? '' };

	const legacyNative = line.match(LEGACY_NATIVE_BG_WRAPPER_RE);
	if (legacyNative) {
		return { color: backgroundColorFromMarker(legacyNative[1] ?? ''), inner: legacyNative[2] ?? '' };
	}

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

	for (const match of source.matchAll(/~=\{gv-bg-(blue|purple)\}([^\n]*?)=bg~/gu)) {
		const fullFrom = match.index ?? 0;
		const color = match[1] as GvkitColor;
		const open = `~={gv-bg-${color}}`;
		const close = '=bg~';
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

/** Rebuild only the touched inline color layer, retaining every other source byte. */
function applyInlineColor(
	source: string, from: number, to: number, kind: 'text' | 'bg', color: GvkitColor | null,
): SourceSelectionResult {
	const lineFrom = source.lastIndexOf('\n', from - 1) + 1;
	const end = source.indexOf('\n', to), lineTo = end < 0 ? source.length : end;
	const line = source.slice(lineFrom, lineTo);
	const styles = collectSourceStyleRanges(line).map(range => ({ ...range,
		fullFrom: range.fullFrom + lineFrom, contentFrom: range.contentFrom + lineFrom,
		contentTo: range.contentTo + lineFrom, fullTo: range.fullTo + lineFrom }));
	const bold = collectBoldRanges(line).filter(range => !isEscapedDelimiter(line, range.fullFrom)).map(range => ({ ...range,
		fullFrom: range.fullFrom + lineFrom, contentFrom: range.contentFrom + lineFrom,
		contentTo: range.contentTo + lineFrom, fullTo: range.fullTo + lineFrom }));
	// Selecting all visible content includes its independent delimiters. This
	// keeps a complete bold/background layer together when the color is removed.
	let selectedFrom = from, selectedTo = to, expanded: boolean;
	do {
		expanded = false;
		for (const range of [...styles, ...bold]) {
			if (range.contentFrom === selectedFrom && range.contentTo === selectedTo) {
				selectedFrom = range.fullFrom; selectedTo = range.fullTo; expanded = true;
			}
		}
	} while (expanded);
	const layers = styles.filter(range => range.kind === kind);
	const touched = layers.filter(range => range.fullFrom < selectedTo && range.fullTo > selectedFrom);
	let start = Math.min(selectedFrom, ...touched.map(range => range.fullFrom));
	let stop = Math.max(selectedTo, ...touched.map(range => range.fullTo));
	// Adjacent same-color spans participate only in this edit, never in a file
	// normalization pass. Ordinary gaps (including whitespace) remain untouched.
	if (kind === 'text' && color) {
		do {
			expanded = false;
			for (const range of layers) if (range.color === color && (range.fullTo === start || range.fullFrom === stop)) {
				start = Math.min(start, range.fullFrom); stop = Math.max(stop, range.fullTo); expanded = true;
			}
		} while (expanded);
	}
	const relevant = layers.filter(range => range.fullFrom >= start && range.fullTo <= stop);
	const chars: { text: string; offset: number; color: GvkitColor | null }[] = [];
	for (let offset = start; offset < stop; offset++) {
		const layer = relevant.find(range => offset >= range.fullFrom && offset < range.fullTo);
		if (layer && (offset < layer.contentFrom || offset >= layer.contentTo)) continue;
		chars.push({ text: source[offset]!, offset, color: layer?.color ?? null });
	}
	const selected = chars.filter(char => char.offset >= from && char.offset < to);
	// Mixed same-color/plain selections fill in; only a fully colored selection toggles off.
	const target = color && selected.length && selected.every(char => char.color === color) ? null : color;
	for (const char of chars) if (char.offset >= selectedFrom && char.offset < selectedTo) char.color = target;
	let replacement = '', current: GvkitColor | null = null;
	let selectionFrom = -1, selectionTo = -1;
	for (const char of chars) {
		if (char.color !== current) {
			if (current) replacement += WRAPPERS[`${kind === 'text' ? 'text' : 'bg'}-${current}`].close;
			if (char.color) replacement += WRAPPERS[`${kind === 'text' ? 'text' : 'bg'}-${char.color}`].open;
			current = char.color;
		}
		if (char.offset >= from && char.offset < to) {
			if (selectionFrom < 0) selectionFrom = start + replacement.length;
			selectionTo = start + replacement.length + 1;
		}
		replacement += char.text;
	}
	if (current) replacement += WRAPPERS[`${kind === 'text' ? 'text' : 'bg'}-${current}`].close;
	return { source: replaceSourceRange(source, start, stop, replacement),
		selectionFrom: selectionFrom < 0 ? start : selectionFrom, selectionTo: selectionTo < 0 ? start : selectionTo };
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
		const text = applyInlineColor(source, selectionFrom, selectionTo, 'text', null);
		const result = applyInlineColor(text.source, text.selectionFrom, text.selectionTo, 'bg', null);
		const selected = result.source.slice(result.selectionFrom, result.selectionTo);
		const replacement = removeGvkitStyleMarkup(selected);
		return { source: replaceSourceRange(result.source, result.selectionFrom, result.selectionTo, replacement),
			selectionFrom: result.selectionFrom, selectionTo: result.selectionFrom + replacement.length };
	}
	if (action === 'text-blue' || action === 'text-purple') {
		return applyInlineColor(source, selectionFrom, selectionTo, 'text', WRAPPERS[action].color);
	}

	const wrapper = WRAPPERS[action];
	const existing = findEnclosingRange(source, selectionFrom, selectionTo, wrapper.kind);
	if (existing) {
		if (existing.color === wrapper.color) {
			return removeStyleRange(source, selectionFrom, selectionTo, existing);
		}

		const inner = source.slice(existing.contentFrom, existing.contentTo);
		const replacement = `${wrapper.open}${inner}${wrapper.close}`;
		const nextSource = replaceSourceRange(source, existing.fullFrom, existing.fullTo, replacement);
		const relativeFrom = Math.max(0, selectionFrom - existing.contentFrom);
		const relativeTo = Math.min(inner.length, selectionTo - existing.contentFrom);
		const contentStart = existing.fullFrom + wrapper.open.length;
		return {
			source: nextSource,
			selectionFrom: contentStart + relativeFrom,
			selectionTo: contentStart + relativeTo,
		};
	}

	// If the visible selection is already inside a normal Obsidian highlight,
	// replace the yellow-highlight layer with gvkit's independent background layer.
	if (wrapper.kind === 'bg') {
		const before = source.slice(Math.max(0, selectionFrom - 2), selectionFrom);
		const after = source.slice(selectionTo, selectionTo + 2);
		if (before === '==' && after === '==') {
			const selected = source.slice(selectionFrom, selectionTo);
			const fullFrom = selectionFrom - 2;
			const replacement = `${wrapper.open}${selected}${wrapper.close}`;
			const nextSource = replaceSourceRange(source, fullFrom, selectionTo + 2, replacement);
			const contentStart = fullFrom + wrapper.open.length;
			return {
				source: nextSource,
				selectionFrom: contentStart,
				selectionTo: contentStart + selected.length,
			};
		}
	}

	// A color marker starts/ends with punctuation. In continuous text,
	// **~={gv-blue}text=~** no longer satisfies Markdown's emphasis boundaries.
	// When the visible selection is exactly a bold span, put color outside its
	// existing delimiters. Keep the same text selected and never color extra text.
	let wrapFrom = selectionFrom;
	let wrapTo = selectionTo;
	const delimiter = source.slice(Math.max(0, selectionFrom - 2), selectionFrom);
	if (
		(delimiter === '**' || delimiter === '__') &&
		source.slice(selectionTo, selectionTo + 2) === delimiter &&
		source[selectionFrom - 3] !== delimiter[0] &&
		source[selectionTo + 2] !== delimiter[0] &&
		!isEscapedDelimiter(source, selectionFrom - 2) &&
		!isEscapedDelimiter(source, selectionTo)
	) {
		wrapFrom -= 2;
		wrapTo += 2;
	}

	const selected = source.slice(wrapFrom, wrapTo);
	const replacement = `${wrapper.open}${selected}${wrapper.close}`;
	return {
		source: replaceSourceRange(source, wrapFrom, wrapTo, replacement),
		selectionFrom: selectionFrom + wrapper.open.length,
		selectionTo: selectionTo + wrapper.open.length,
	};
}

function isEscapedDelimiter(source: string, offset: number): boolean {
	let backslashes = 0;
	for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) {
		backslashes += 1;
	}
	return backslashes % 2 === 1;
}


interface MarkdownDelimiterRange {
	open: string;
	close: string;
	fullFrom: number;
	contentFrom: number;
	contentTo: number;
	fullTo: number;
}

function collectBoldRanges(source: string): MarkdownDelimiterRange[] {
	const ranges: MarkdownDelimiterRange[] = [];
	for (const match of source.matchAll(/(\*\*|__)([^\n]*?)\1/gu)) {
		const fullFrom = match.index ?? 0;
		const delimiter = match[1] ?? '**';
		ranges.push({
			open: delimiter,
			close: delimiter,
			fullFrom,
			contentFrom: fullFrom + delimiter.length,
			contentTo: fullFrom + match[0].length - delimiter.length,
			fullTo: fullFrom + match[0].length,
		});
	}
	return ranges;
}

function findEnclosingBoldRange(
	source: string,
	selectionFrom: number,
	selectionTo: number,
): MarkdownDelimiterRange | null {
	const candidates = collectBoldRanges(source)
		.filter((range) =>
			(range.contentFrom <= selectionFrom && range.contentTo >= selectionTo) ||
			(range.fullFrom === selectionFrom && range.fullTo === selectionTo),
		)
		.sort((a, b) => (a.contentTo - a.contentFrom) - (b.contentTo - b.contentFrom));
	return candidates[0] ?? null;
}

/**
 * Toggles standard Markdown bold around the visible selection while preserving
 * gvkit color layers and keeping the visible text selected for another click.
 */
export function toggleBoldInSourceSelection(
	source: string,
	selectionFrom: number,
	selectionTo: number,
): SourceSelectionResult {
	if (selectionFrom === selectionTo) return { source, selectionFrom, selectionTo };
	if (selectionFrom > selectionTo) [selectionFrom, selectionTo] = [selectionTo, selectionFrom];

	const rawSelection = source.slice(selectionFrom, selectionTo);
	if (rawSelection.includes('\n')) {
		const replacement = rawSelection
			.split('\n')
			.map((line) => line.length === 0 ? line : `**${line}**`)
			.join('\n');
		return {
			source: replaceSourceRange(source, selectionFrom, selectionTo, replacement),
			selectionFrom,
			selectionTo: selectionFrom + replacement.length,
		};
	}

	const existing = findEnclosingBoldRange(source, selectionFrom, selectionTo);
	if (existing) {
		const selectedFullWrapper = selectionFrom === existing.fullFrom && selectionTo === existing.fullTo;
		const withoutClose = replaceSourceRange(source, existing.contentTo, existing.fullTo, '');
		const nextSource = replaceSourceRange(withoutClose, existing.fullFrom, existing.contentFrom, '');
		return {
			source: nextSource,
			selectionFrom: selectedFullWrapper ? existing.fullFrom : selectionFrom - existing.open.length,
			selectionTo: selectedFullWrapper
				? existing.fullFrom + (existing.contentTo - existing.contentFrom)
				: selectionTo - existing.open.length,
		};
	}

	const selected = source.slice(selectionFrom, selectionTo);
	const delimiter = '**';
	return {
		source: replaceSourceRange(source, selectionFrom, selectionTo, `${delimiter}${selected}${delimiter}`),
		selectionFrom: selectionFrom + delimiter.length,
		selectionTo: selectionTo + delimiter.length,
	};
}

/** Adjacent color delimiters can look like Markdown's two-tilde strike syntax. */
export function isColorDelimiterStrike(source: string, from: number, to: number): boolean {
	const opening = (at: number) => ['blue', 'purple'].some(color => source.startsWith(`={gv-${color}}`, at));
	return source[from - 1] === '=' && source[to - 3] === '=' && opening(from + 2) && opening(to);
}
