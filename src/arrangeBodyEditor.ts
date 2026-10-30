import { EditorState, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { parser, GFM } from '@lezer/markdown';
import { MarkdownRenderer, sanitizeHTMLToDom, type App, type Component } from 'obsidian';
import { buildDecorations as buildColorDecorations } from './editorDecorations';

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

function arrangeColors(view: EditorView): DecorationSet {
	const code: { from: number; to: number }[] = [];
	markdown.parse(view.state.doc.toString()).iterate({ enter(node) {
		if (['InlineCode', 'FencedCode', 'IndentedCode'].includes(node.name)) { code.push({ from: node.from, to: node.to }); return false; }
		return true;
	} });
	return buildColorDecorations(view).update({ filter: (from, to) => !code.some(range => from < range.to && to > range.from) });
}
const colors = ViewPlugin.fromClass(class {
	decorations: DecorationSet;
	constructor(view: EditorView) { this.decorations = arrangeColors(view); }
	update(update: ViewUpdate): void {
		if (update.docChanged || update.viewportChanged || update.focusChanged || update.selectionSet) this.decorations = arrangeColors(update.view);
	}
}, { decorations: value => value.decorations });

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

function parsedDocument(state: EditorState, app: App, path: string, component: Component): DecorationSet {
	const source = state.doc.toString(), ranges: Range<Decoration>[] = [];
	const tags: { tag: HTMLElement; from: number }[] = [];
	const hide = (from: number, to: number) => { if (to > from) ranges.push(Decoration.replace({}).range(from, to)); };
	const mark = (from: number, to: number, tagName: string, attributes?: Record<string, string>) => {
		if (to > from) ranges.push(Decoration.mark({ tagName, attributes }).range(from, to));
	};
	const rendered = (from: number, to: number) => ranges.push(Decoration.replace({ widget: new Rendered(source.slice(from, to), app, path, component) }).range(from, to));
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
		if (name === 'HTMLTag') {
			const raw = source.slice(from, to);
			if (raw.startsWith('</')) {
				const open = tags.pop();
				if (open) mark(open.from, from, open.tag.tagName.toLowerCase(), Object.fromEntries(Array.from(open.tag.attributes).map(a => [a.name, a.value])));
			} else {
				const tag = sanitizeHTMLToDom(raw).firstElementChild as HTMLElement | null;
				if (tag && !raw.endsWith('/>') && tag.tagName !== 'BR' && tag.tagName !== 'IMG') tags.push({ tag, from: to });
				else { rendered(from, to); return false; }
			}
			hide(from, to); return false;
		}
		if (name === 'TableCell') mark(from, to, 'span', { class: 'gvkit-arrange-table-cell' });
		if (name === 'TableHeader') mark(from, to, 'strong');
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
		if (name === 'ListMark' && node.parent?.parent?.name === 'BulletList') {
			// A bullet is a parsed list marker, not editable Markdown punctuation.
			class Bullet extends WidgetType { toDOM() { const el = document.createElement('span'); el.textContent = '•'; return el; } }
			ranges.push(Decoration.replace({ widget: new Bullet() }).range(from, to));
		}
		if (name === 'TaskMarker') {
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
	return Decoration.set(ranges, true);
}

export class ArrangeBodyEditor {
	readonly editor: EditorView;
	readonly dom: HTMLElement;
	private hint: string;
	constructor(parent: HTMLElement, value: string, hint: string, app: App, path: string, component: Component, changed: () => void) {
		this.hint = hint;
		const parsed = StateField.define<DecorationSet>({
			create: state => parsedDocument(state, app, path, component),
			update: (value, tr) => tr.docChanged ? parsedDocument(tr.state, app, path, component) : value,
			provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field).update({
				filter: (_from, _to, value) => !value.spec.tagName && !value.spec.class,
			}))],
		});
		this.editor = new EditorView({ parent, state: EditorState.create({ doc: value, extensions: [
			parsed, history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping, colors,
			EditorView.atomicRanges.of(view => view.plugin(colors)?.decorations.update({ filter: (_from, _to, value) => !value.spec.class }) ?? Decoration.none),
			EditorView.editorAttributes.of({ class: 'gvkit-arrange-inline-body is-live-preview' }),
			placeholder(() => { const el = document.createElement('span'); el.textContent = this.hint; return el; }), EditorView.contentAttributes.of({ 'aria-label': '事项正文', 'aria-multiline': 'true' }),
			EditorView.updateListener.of(update => { if (update.docChanged) changed(); }),
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
		// Reuse the existing color extension once the editor's scoped class is set.
		this.editor.dispatch({ selection: this.editor.state.selection });
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
