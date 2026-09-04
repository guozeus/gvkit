import type { Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

const TEXT_COLOR_RE = /~=\{gv-(blue|purple)\}([\s\S]*?)=~/gu;
const BG_COLOR_RE = /==([🔵🟣])([\s\S]*?)==/gu;

function isLivePreview(view: EditorView): boolean {
	return view.dom.closest('.is-live-preview') !== null;
}

function buildDecorations(view: EditorView): DecorationSet {
	if (!isLivePreview(view)) return Decoration.none;

	const ranges: Range<Decoration>[] = [];
	const seenLines = new Set<number>();

	for (const visible of view.visibleRanges) {
		let line = view.state.doc.lineAt(visible.from);
		const lastLine = view.state.doc.lineAt(visible.to);

		while (line.number <= lastLine.number) {
			if (!seenLines.has(line.from)) {
				seenLines.add(line.from);
				const text = line.text;

				for (const match of text.matchAll(TEXT_COLOR_RE)) {
					const color = match[1];
					const full = match[0];
					const start = line.from + (match.index ?? 0);
					const openLength = `~={gv-${color}}`.length;
					const contentFrom = start + openLength;
					const contentTo = start + full.length - 2;
					const className = color === 'blue' ? 'gvkit-text-blue' : 'gvkit-text-purple';

					ranges.push(Decoration.replace({}).range(start, contentFrom));
					if (contentTo > contentFrom) {
						ranges.push(Decoration.mark({ class: className }).range(contentFrom, contentTo));
					}
					ranges.push(Decoration.replace({}).range(contentTo, start + full.length));
				}

				for (const match of text.matchAll(BG_COLOR_RE)) {
					const marker = match[1] ?? '';
					const full = match[0];
					const start = line.from + (match.index ?? 0);
					const emojiFrom = start + 2;
					const emojiTo = emojiFrom + marker.length;
					const contentFrom = emojiTo;
					const contentTo = start + full.length - 2;
					const className = marker === '🔵' ? 'gvkit-bg-blue' : 'gvkit-bg-purple';

					// Obsidian handles the == delimiters. gvkit only hides the color marker
					// on older versions and supplies the correct color decoration.
					ranges.push(Decoration.replace({}).range(emojiFrom, emojiTo));
					if (contentTo > contentFrom) {
						ranges.push(Decoration.mark({ class: className }).range(contentFrom, contentTo));
					}
				}
			}

			if (line.number === lastLine.number) break;
			line = view.state.doc.line(line.number + 1);
		}
	}

	return Decoration.set(ranges, true);
}

class GvkitDecorationView {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.viewportChanged || update.focusChanged || update.selectionSet) {
			this.decorations = buildDecorations(update.view);
		}
	}
}

export const gvkitEditorDecorations = ViewPlugin.fromClass(GvkitDecorationView, {
	decorations: (value) => value.decorations,
});
