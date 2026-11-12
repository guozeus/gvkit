import { EditorState, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder, WidgetType, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { parser, GFM } from '@lezer/markdown';
import { MarkdownRenderer, sanitizeHTMLToDom, setIcon, type App, type Component } from 'obsidian';

// This editor belongs only to Arrange. Its document is always the original
// Markdown, including syntax hidden by decorations; no HTML round-trip occurs.
const highlightDelimiter = { resolve: 'ArrangeHighlight', mark: 'ArrangeHighlightMark' };
const markdown = parser.configure([GFM, {
	defineNodes: ['ArrangeWikiLink', 'ArrangeEmbed', 'ArrangeHighlight', 'ArrangeHighlightMark'],
	parseInline: [{ name: 'ArrangeHighlight', before: 'Emphasis', parse(cx, next, pos) {
		if (next !== 61 || cx.char(pos + 1) !== 61) return -1;
		return cx.addDelimiter(highlightDelimiter, pos, pos + 2, true, true);
	} }, { name: 'ArrangeWiki', before: 'Link', parse(cx, next, pos) {
		const embed = next === 33 && cx.char(pos + 1) === 91;
		const start = pos + (embed ? 1 : 0);
		if (cx.char(start) !== 91 || cx.char(start + 1) !== 91) return -1;
		const end = cx.text.indexOf(']]', start + 2 - cx.offset);
		if (end < 0) return -1;
		const to = cx.offset + end + 2;
		return cx.addElement(cx.elt(embed ? 'ArrangeEmbed' : 'ArrangeWikiLink', pos, to));
	} }],
}]);

// HTML blocks treat Markdown punctuation as literal; reuse Lezer's HTML tokens.
const htmlInline = parser.configure({ remove: ['Emphasis', 'Link', 'Image', 'InlineCode', 'Escape', 'Entity', 'Autolink'] });

function linkTarget(raw: string, auto = false): string {
	if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
	const text = document.createElement('textarea'); text.innerHTML = raw;
	let target = text.value;
	if (auto && target.startsWith('www.')) target = `https://${target}`;
	if (auto && target.includes('@') && !target.includes(':')) target = `mailto:${target}`;
	// Match the renderer's handling of executable link destinations.
	if (/^(?:javascript|vbscript|data):/i.test(target)) return '';
	return target;
}

function arrangeColors(state: EditorState): DecorationSet {
	const source = state.doc.toString(), ranges: Range<Decoration>[] = [];
	const code: { from: number; to: number }[] = [];
	markdown.parse(source).iterate({ enter(node) {
		if (['InlineCode', 'FencedCode', 'IndentedCode'].includes(node.name)) { code.push({ from: node.from, to: node.to }); return false; }
		return true;
	} });
	// Reading mode and the formatter allow color spans across source lines.
	// Keep these document decorations independent of hidden-editor viewport/focus.
	for (const [pattern, background] of [[/~=\{gv-(blue|purple)\}|=~/gu, false], [/~=\{gv-bg-(blue|purple)\}|=bg~/gu, true]] as const) {
		let open: { from: number; to: number; color: string } | null = null;
		for (const token of source.matchAll(pattern)) {
			const from = token.index!, to = from + token[0].length;
			// Code is literal. Exclude its tokens before pairing, so an unmatched
			// example in code cannot consume the next real color span.
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
const colors = StateField.define<DecorationSet>({
	create: arrangeColors,
	update: (value, tr) => tr.docChanged ? arrangeColors(tr.state) : value,
	provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field).update({
		filter: (_from, _to, value) => !value.spec.class,
	}))],
});

class Rendered extends WidgetType {
	constructor(private source: string, private app: App, private path: string, private component: Component) { super(); }
	eq(other: Rendered): boolean { return this.source === other.source && this.path === other.path; }
	toDOM(): HTMLElement {
		const el = document.createElement('span');
		el.className = 'gvkit-arrange-rendered-fragment';
		void MarkdownRenderer.render(this.app, this.source, el, this.path, this.component);
		return el;
	}
	ignoreEvent(): boolean { return false; }
}

function parsedDocument(state: EditorState, app: App, path: string, component: Component, copy?: () => void): DecorationSet {
	const source = state.doc.toString(), ranges: Range<Decoration>[] = [];
	let copyAt = source.trimEnd().length;
	const tags: { tag: HTMLElement; from: number }[] = [];
	const hide = (from: number, to: number) => { if (to > from) ranges.push(Decoration.replace({}).range(from, to)); };
	const mark = (from: number, to: number, tagName: string, attributes?: Record<string, string>) => {
		if (to > from) ranges.push(Decoration.mark({ tagName, attributes }).range(from, to));
	};
	const rendered = (from: number, to: number) => ranges.push(Decoration.replace({ widget: new Rendered(source.slice(from, to), app, path, component) }).range(from, to));
	const htmlTag = (from: number, to: number, block = false) => {
		const raw = source.slice(from, to);
		if (raw.startsWith('</')) {
			const open = tags.pop();
			// An unstyled div is already represented by the source's block lines.
			if (open && (open.tag.tagName !== 'DIV' || open.tag.attributes.length))
				mark(open.from, from, open.tag.tagName.toLowerCase(), Object.fromEntries(Array.from(open.tag.attributes).map(a => [a.name, a.value])));
		} else {
			const tag = sanitizeHTMLToDom(raw).firstElementChild as HTMLElement | null;
			if (tag && !raw.endsWith('/>') && tag.tagName !== 'BR' && tag.tagName !== 'IMG') tags.push({ tag, from: to });
			else { rendered(from, to); return; }
		}
		const line = state.doc.lineAt(from);
		if (block && !source.slice(line.from, from).trim() && !source.slice(to, line.to).trim()) {
			if (raw.startsWith('</') && !source.slice(to).trim()) {
				// Hide structural-only closing lines without adding empty rendered rows.
				hide(Math.max(0, line.from - 1), source.length); copyAt = source.length;
			} else hide(line.from, Math.min(source.length, line.to + 1));
		} else hide(from, to);
	};
	markdown.parse(source).iterate({ enter(ref) {
		const { name, from, to, node } = ref;
		if (name === 'ArrangeEmbed' || name === 'Image' || name === 'Entity' || name === 'Escape' || name === 'HorizontalRule') {
			rendered(from, to); return false;
		}
		if (name === 'ArrangeWikiLink') {
			const inside = source.slice(from + 2, to - 2), pipe = inside.indexOf('|');
			const target = pipe < 0 ? inside : inside.slice(0, pipe);
			const label = pipe < 0 ? from + 2 : from + 3 + pipe;
			hide(from, label); hide(to - 2, to);
			mark(label, to - 2, 'a', { href: target, 'data-href': target, class: 'internal-link' });
			return false;
		}
		if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) {
			const level = name.at(-1)!;
			ranges.push(Decoration.line({ class: `gvkit-arrange-heading gvkit-arrange-h${level}` }).range(state.doc.lineAt(from).from));
		}
		if (name === 'Blockquote' || name === 'FencedCode' || name === 'IndentedCode') {
			for (let line = state.doc.lineAt(from); line.from <= to; ) {
				ranges.push(Decoration.line({ class: name === 'Blockquote' ? 'gvkit-arrange-quote' : 'gvkit-arrange-code-line' }).range(line.from));
				if (line.number === state.doc.lines || line.to >= to) break;
				line = state.doc.line(line.number + 1);
			}
		}
		if (name === 'StrongEmphasis') mark(from, to, 'strong');
		if (name === 'Emphasis') mark(from, to, 'em');
		if (name === 'Strikethrough') mark(from, to, 's');
		if (name === 'InlineCode') mark(from, to, 'code');
		if (name === 'ArrangeHighlight') {
			const first = source.slice(from + 2, from + 4);
			const color = first === '🔵' ? 'blue' : first === '🟣' ? 'purple' : null;
			mark(from + 2 + (color ? 2 : 0), to - 2, 'mark', color ? { class: `gvkit-bg-${color}` } : undefined);
			if (color) hide(from + 2, from + 4);
		}
		if (name === 'HTMLTag') { htmlTag(from, to); return false; }
		if (name === 'HTMLBlock') {
			// The same Markdown parser exposes HTML tokens inside a block. Preserve
			// editable source text and reuse the existing sanitized tag decorations.
			for (const element of htmlInline.parseInline(source.slice(from, to), from))
				if (htmlInline.nodeSet.types[element.type]?.name === 'HTMLTag') htmlTag(element.from, element.to, true);
			return false;
		}
		if (name === 'TableHeader' || name === 'TableRow')
			ranges.push(Decoration.line({ class: `gvkit-arrange-table-row${name === 'TableHeader' ? ' gvkit-arrange-table-header' : ''}` }).range(state.doc.lineAt(from).from));
		if (name === 'TableDelimiter' && node.parent?.name === 'Table')
			ranges.push(Decoration.line({ class: 'gvkit-arrange-table-separator' }).range(state.doc.lineAt(from).from));
		if (name === 'TableCell') mark(from, to, 'span', { class: 'gvkit-arrange-table-cell' });
		if (name === 'Link' || name === 'Autolink') {
			const children = node.getChildren('LinkMark'), url = node.getChild('URL');
			const labelFrom = children[0]?.to ?? from;
			const labelTo = name === 'Autolink' ? url?.to ?? to : children[1]?.from ?? to;
			let href = url ? source.slice(url.from, url.to) : '';
			const reference = node.getChild('LinkLabel');
			if (!href) {
				const key = reference ? source.slice(reference.from + 1, reference.to - 1) : source.slice(labelFrom, labelTo);
				markdown.parse(source).iterate({ enter(r) {
					if (r.name !== 'LinkReference') return;
					const id = r.node.getChild('LinkLabel'), destination = r.node.getChild('URL');
					if (id && destination && source.slice(id.from + 1, id.to - 1).toLowerCase() === key.toLowerCase()) href = source.slice(destination.from, destination.to);
				} });
			}
			href = linkTarget(href, name === 'Autolink');
			if (href) {
				hide(from, labelFrom); hide(labelTo, to);
				mark(labelFrom, labelTo, 'a', { href, 'data-href': href });
			}
		}
		if (name === 'URL' && !['Link', 'Autolink', 'Image', 'LinkReference'].includes(node.parent?.name ?? '')) {
			const href = linkTarget(source.slice(from, to), true);
			if (href) mark(from, to, 'a', { href, 'data-href': href });
		}
		if (name === 'LinkReference') { hide(from, to); return false; }
		if (name === 'HeaderMark' || name === 'QuoteMark' || name === 'CodeMark' || name === 'CodeInfo'
			|| name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'ArrangeHighlightMark' || name === 'TableDelimiter') {
			let end = to;
			if ((name === 'HeaderMark' || name === 'QuoteMark') && source[end] === ' ') end++;
			hide(from, end);
		}
		if (name === 'ListMark' && ['BulletList', 'OrderedList'].includes(node.parent?.parent?.name ?? '')) {
			const list = node.parent!.parent!;
			if (node.parent!.getChild('Task')) { hide(from, to + (source[to] === ' ' ? 1 : 0)); return false; }
			const items = list.getChildren('ListItem'), first = items[0]?.getChild('ListMark');
			const label = list.name === 'OrderedList' && first
				? `${Number.parseInt(source.slice(first.from, first.to), 10) + items.findIndex(item => item.from === node.parent!.from)}.` : '•';
			class ListMarker extends WidgetType { toDOM() { const el = document.createElement('span'); el.className = 'gvkit-arrange-list-marker'; el.textContent = label; return el; } }
			ranges.push(Decoration.replace({ widget: new ListMarker() }).range(from, to));
		}
		if (name === 'TaskMarker') {
			if (source[from + 1]?.toLowerCase() === 'x') mark(to, node.parent!.to, 'span', { class: 'gvkit-arrange-task-done' });
			class Checkbox extends WidgetType {
				toDOM(view: EditorView) {
					const el = document.createElement('input'); el.type = 'checkbox'; el.checked = source[from + 1]?.toLowerCase() === 'x';
					el.setAttribute('aria-label', '附注清单');
					el.onmousedown = event => event.preventDefault();
					el.onclick = () => view.dispatch({ changes: { from: from + 1, to: from + 2, insert: el.checked ? 'x' : ' ' } });
					return el;
				}
				ignoreEvent(): boolean { return false; }
			}
			ranges.push(Decoration.replace({ widget: new Checkbox() }).range(from, to)); return false;
		}
		return true;
	} });
	if (copy && source.trim()) {
		class Copy extends WidgetType {
			toDOM(): HTMLElement {
				const button = document.createElement('button');
				button.type = 'button'; button.className = 'gvkit-arrange-icon gvkit-arrange-body-copy';
				button.setAttribute('aria-label', '复制标题及附注'); button.title = '复制标题及附注';
				setIcon(button, 'copy');
				button.onmousedown = event => event.preventDefault();
				button.onclick = event => { event.preventDefault(); event.stopPropagation(); copy?.(); };
				return button;
			}
			ignoreEvent(): boolean { return true; }
		}
		// A point widget follows the last source character, outside link marks.
		ranges.push(Decoration.widget({ widget: new Copy(), side: 1 }).range(copyAt));
	}
	return Decoration.set(ranges, true);
}

export class ArrangeBodyEditor {
	readonly editor: EditorView;
	readonly dom: HTMLElement;
	private hint: string;
	constructor(parent: HTMLElement, value: string, hint: string, app: App, path: string, component: Component, changed: () => void, caretChanged: () => void = () => {}, copy?: () => void) {
		this.hint = hint;
		const parsed = StateField.define<DecorationSet>({
			create: state => parsedDocument(state, app, path, component, copy),
			update: (value, tr) => tr.docChanged ? parsedDocument(tr.state, app, path, component, copy) : value,
			provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field).update({
				filter: (_from, _to, value) => !value.spec.tagName && !value.spec.class,
			}))],
		});
		this.editor = new EditorView({ parent, state: EditorState.create({ doc: value, extensions: [
			parsed, history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping, colors,
			EditorView.editorAttributes.of({ class: 'gvkit-arrange-inline-body is-live-preview' }),
			placeholder(() => { const el = document.createElement('span'); el.textContent = this.hint; return el; }), EditorView.contentAttributes.of({ 'aria-label': '事项正文', 'aria-multiline': 'true' }),
			EditorView.updateListener.of(update => {
				if (update.docChanged) changed();
				if (update.docChanged || update.selectionSet || update.focusChanged || update.geometryChanged) caretChanged();
			}),
			EditorView.domEventHandlers({ click: (event, view) => {
				const link = (event.target as HTMLElement).closest('a');
				const href = link?.getAttribute('data-href') ?? link?.getAttribute('href');
				if (!href) return false;
				event.preventDefault();
				if (/^[a-z][a-z0-9+.-]*:/i.test(href)) window.open(href, '_blank');
				else void app.workspace.openLinkText(href, path, event.ctrlKey || event.metaKey);
				return true;
			} }),
		] }) });
		this.dom = this.editor.dom;
	}
	get value(): string { return this.editor.state.doc.toString(); }
	set value(value: string) { this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: value } }); }
	get hidden(): boolean { return this.dom.hidden; }
	set hidden(value: boolean) { this.dom.hidden = value; if (!value) this.editor.requestMeasure(); }
	get placeholder(): string { return this.hint; }
	set placeholder(value: string) {
		this.hint = value;
		const hint = this.dom.querySelector('.cm-placeholder');
		if (hint) hint.textContent = value;
	}
	get focused(): boolean { return this.editor.hasFocus; }
	syncRoot(): void { this.editor.setRoot(this.dom.getRootNode() as Document | ShadowRoot); }
	focus(offset = 0): void {
		let anchor = Math.max(0, Math.min(offset, this.editor.state.doc.length)), previous: number;
		// Programmatic opening must obey the same hidden syntax boundaries as
		// native arrow movement, including a heading at the start of the note.
		do {
			previous = anchor;
			for (const ranges of this.editor.state.facet(EditorView.atomicRanges)) ranges(this.editor).between(anchor, anchor, (from, to) => {
				if (from <= anchor && to > anchor) anchor = to;
			});
		} while (anchor !== previous);
		this.editor.dispatch({ selection: { anchor } });
		this.editor.focus();
	}
	destroy(): void { this.editor.destroy(); }
}
