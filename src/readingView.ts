type GvkitColor = 'blue' | 'purple';

interface MarkerEvent {
	type: 'open' | 'close';
	node: Text;
	index: number;
	length: number;
	color?: GvkitColor;
}

interface MarkerPair {
	open: MarkerEvent;
	close: MarkerEvent;
}

interface MarkerSpec {
	openRe: RegExp;
	close: string;
	openText: (color: GvkitColor) => string;
	className: (color: GvkitColor) => string;
}

const TEXT_SPEC: MarkerSpec = {
	openRe: /~=\{gv-(blue|purple)\}/gu,
	close: '=~',
	openText: (color) => `~={gv-${color}}`,
	className: (color) => color === 'blue' ? 'gvkit-text-blue' : 'gvkit-text-purple',
};

const BG_SPEC: MarkerSpec = {
	openRe: /~=\{gv-bg-(blue|purple)\}/gu,
	close: '=bg~',
	openText: (color) => `~={gv-bg-${color}}`,
	className: (color) => color === 'blue' ? 'gvkit-bg-blue' : 'gvkit-bg-purple',
};

function isInsideCode(node: Text): boolean {
	return node.parentElement?.closest('code, pre') != null;
}

function collectNodeEvents(node: Text, spec: MarkerSpec): MarkerEvent[] {
	const text = node.data;
	const events: MarkerEvent[] = [];

	spec.openRe.lastIndex = 0;
	for (let match = spec.openRe.exec(text); match; match = spec.openRe.exec(text)) {
		events.push({
			type: 'open',
			node,
			index: match.index,
			length: match[0].length,
			color: match[1] as GvkitColor,
		});
	}

	let closeIndex = text.indexOf(spec.close);
	while (closeIndex !== -1) {
		events.push({ type: 'close', node, index: closeIndex, length: spec.close.length });
		closeIndex = text.indexOf(spec.close, closeIndex + spec.close.length);
	}

	events.sort((a, b) => {
		if (a.index !== b.index) return a.index - b.index;
		if (a.type === b.type) return 0;
		return a.type === 'open' ? -1 : 1;
	});
	return events;
}

function collectMarkerPairs(root: HTMLElement, spec: MarkerSpec): MarkerPair[] {
	const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
	const pairs: MarkerPair[] = [];
	let open: MarkerEvent | null = null;

	for (let current = walker.nextNode(); current; current = walker.nextNode()) {
		const node = current as Text;
		if (isInsideCode(node)) continue;

		for (const event of collectNodeEvents(node, spec)) {
			if (event.type === 'open') {
				if (open === null) open = event;
				continue;
			}
			if (open !== null) {
				pairs.push({ open, close: event });
				open = null;
			}
		}
	}

	return pairs;
}

function stripAdjacentMarker(span: HTMLElement, marker: string, before: boolean): void {
	const sibling = before ? span.previousSibling : span.nextSibling;
	// Popout windows have their own Text constructor. Test the DOM node type,
	// not the plugin's main-window realm.
	if (!sibling || sibling.nodeType !== 3 /* TEXT_NODE */) return;
	const text = sibling as Text;

	if (before && text.data.endsWith(marker)) {
		text.deleteData(text.length - marker.length, marker.length);
	} else if (!before && text.data.startsWith(marker)) {
		text.deleteData(0, marker.length);
	}
}

function renderCrossingPair(pair: MarkerPair, spec: MarkerSpec): void {
	if (!pair.open.color) return;
	const { open, close } = pair;
	const doc = open.node.ownerDocument;
	// Remove from right to left, keeping earlier pairs' node offsets valid.
	close.node.deleteData(close.index, close.length);
	open.node.deleteData(open.index, open.length);
	const end = close.index - (open.node === close.node ? open.length : 0);
	const range = doc.createRange();
	range.setStart(open.node, open.index);
	range.setEnd(close.node, end);
	const ancestor = range.commonAncestorContainer;
	const nodes: Text[] = [];
	if (ancestor.nodeType === 3) nodes.push(ancestor as Text);
	else {
		const walker = doc.createTreeWalker(ancestor, 4 /* SHOW_TEXT */);
		for (let node = walker.nextNode(); node; node = walker.nextNode())
			if (range.intersectsNode(node) && !isInsideCode(node as Text)) nodes.push(node as Text);
	}
	// Wrap text in place rather than extracting/cloning a partial strong/link.
	// Splitting preserves original prefix nodes used by earlier adjacent pairs.
	for (const node of nodes) {
		const from = node === open.node ? open.index : 0;
		const to = node === close.node ? end : node.length;
		if (to <= from) continue;
		if (to < node.length) node.splitText(to);
		const text = from ? node.splitText(from) : node;
		const span = doc.createElement('span');
		span.className = spec.className(pair.open.color);
		text.replaceWith(span); span.appendChild(text);
	}
}

function renderMarkerPair(pair: MarkerPair, spec: MarkerSpec): void {
	if (pair.open.node.parentElement !== pair.close.node.parentElement) {
		renderCrossingPair(pair, spec); return;
	}
	if (!pair.open.color) return;

	const doc = pair.open.node.ownerDocument;
	const range = doc.createRange();
	range.setStart(pair.open.node, pair.open.index + pair.open.length);
	range.setEnd(pair.close.node, pair.close.index);

	const span = doc.createElement('span');
	span.className = spec.className(pair.open.color);
	span.appendChild(range.extractContents());
	range.insertNode(span);

	stripAdjacentMarker(span, spec.openText(pair.open.color), true);
	stripAdjacentMarker(span, spec.close, false);
}

function renderMarkerLayer(root: HTMLElement, spec: MarkerSpec): void {
	const pairs = collectMarkerPairs(root, spec);
	for (let index = pairs.length - 1; index >= 0; index -= 1) {
		const pair = pairs[index];
		if (pair) renderMarkerPair(pair, spec);
	}
}

function firstTextNode(root: Element): Text | null {
	const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
	return walker.nextNode() as Text | null;
}

function renderLegacyBackgroundColors(root: HTMLElement): void {
	for (const mark of Array.from(root.querySelectorAll('mark'))) {
		const first = firstTextNode(mark);
		if (!first) continue;

		if (first.data.startsWith('🔵')) {
			first.deleteData(0, '🔵'.length);
			mark.classList.add('gvkit-bg-blue');
		} else if (first.data.startsWith('🟣')) {
			first.deleteData(0, '🟣'.length);
			mark.classList.add('gvkit-bg-purple');
		}
	}
}

export function renderGvkitStyles(root: HTMLElement): void {
	// Markdown's strike parser can consume the two touching tildes between
	// adjacent color layers. Restore only that exact delimiter collision.
	for (const strike of Array.from(root.querySelectorAll('s, del'))) {
		const before = strike.previousSibling, after = strike.nextSibling;
		if (before?.nodeType !== 3 || after?.nodeType !== 3) continue;
		const label = strike.textContent ?? '';
		if (!(before as Text).data.endsWith('=') || !label.endsWith('=')) continue;
		if (!['={gv-blue}', '={gv-purple}'].some(open => label.startsWith(open) && (after as Text).data.startsWith('={gv-'))) continue;
		const parent = strike.parentNode!;
		strike.replaceWith(root.ownerDocument.createTextNode('~~'), ...Array.from(strike.childNodes), root.ownerDocument.createTextNode('~~'));
		parent.normalize();
	}
	// Text and background are independent layers. Each layer scans this rendered
	// section once, then applies collected ranges from back to front so earlier
	// offsets remain valid while the DOM is rewritten.
	renderMarkerLayer(root, TEXT_SPEC);
	renderMarkerLayer(root, BG_SPEC);
	renderLegacyBackgroundColors(root);
}
