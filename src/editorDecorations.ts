import type { Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { parser, GFM } from '@lezer/markdown';
import { isColorDelimiterStrike } from './formatting';

const markdown = parser.configure(GFM);

export function buildDecorations(view: EditorView, livePreview = Boolean(view.dom.closest('.is-live-preview'))): DecorationSet {
	if (!livePreview) return Decoration.none;
	const source = view.state.doc.toString(), ranges: Range<Decoration>[] = [];
	const code: { from: number; to: number }[] = [];
	markdown.parse(source).iterate({ enter(node) {
		if (['InlineCode', 'FencedCode', 'IndentedCode'].includes(node.name)) {
			code.push({ from: node.from, to: node.to }); return false;
		}
		if (node.name === 'Strikethrough' && isColorDelimiterStrike(source, node.from, node.to))
			ranges.push(Decoration.mark({ class: 'gvkit-color-delimiter-strike' }).range(node.from, node.to));
		return true;
	} });
	// Pair across lines, while code remains literal. Only delimiter bytes are
	// replaced; source text, selection and native Markdown semantics remain intact.
	for (const [pattern, background] of [[/~=\{gv-(blue|purple)\}|=~/gu, false], [/~=\{gv-bg-(blue|purple)\}|=bg~/gu, true]] as const) {
		let open: { from: number; to: number; color: string } | null = null;
		for (const token of source.matchAll(pattern)) {
			const from = token.index!, to = from + token[0].length;
			if (code.some(range => from < range.to && to > range.from)) continue;
			if (token[1]) { open ??= { from, to, color: token[1] }; continue; }
			if (!open) continue;
			ranges.push(Decoration.replace({}).range(open.from, open.to));
			const mark = Decoration.mark({ class: `gvkit-${background ? 'bg' : 'text'}-${open.color}` });
			let start = open.to;
			for (const literal of code) {
				if (literal.to <= start || literal.from >= from) continue;
				if (literal.from > start) ranges.push(mark.range(start, literal.from));
				start = literal.to;
			}
			if (from > start) ranges.push(mark.range(start, from));
			ranges.push(Decoration.replace({}).range(from, to));
			open = null;
		}
	}
	return Decoration.set(ranges, true);
}

/** Use Obsidian's real mode field, including a switch with no selection change. */
export function gvkitEditorDecorations(livePreviewField: StateField<boolean>) {
	const isLive = (view: EditorView) => view.state.field(livePreviewField, false) ?? Boolean(view.dom.closest('.is-live-preview'));
	class GvkitDecorationView {
		decorations: DecorationSet;
		live: boolean;
		constructor(view: EditorView) { this.live = isLive(view); this.decorations = buildDecorations(view, this.live); }
		update(update: ViewUpdate): void {
			const live = isLive(update.view);
			if (live !== this.live || update.docChanged || update.viewportChanged || update.focusChanged || update.selectionSet)
				this.decorations = buildDecorations(update.view, live);
			this.live = live;
		}
	}
	return ViewPlugin.fromClass(GvkitDecorationView, {
		decorations: value => value.decorations,
		provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.decorations.update({
			filter: (_from, _to, value) => !value.spec.class,
		}) ?? Decoration.none),
	});
}
