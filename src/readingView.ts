interface TextMarkerEvent {
	type: 'open' | 'close';
	node: Text;
	index: number;
	length: number;
	color?: 'blue' | 'purple';
}

interface TextMarkerPair {
	open: TextMarkerEvent;
	close: TextMarkerEvent;
}

const OPEN_RE = /~=\{gv-(blue|purple)\}/gu;
const CLOSE = '=~';

function isInsideCode(node: Text): boolean {
	return node.parentElement?.closest('code, pre') != null;
}

function collectTextMarkerPairs(root: HTMLElement): TextMarkerPair[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const events: TextMarkerEvent[] = [];

	for (let current = walker.nextNode(); current; current = walker.nextNode()) {
		const node = current as Text;
		if (isInsideCode(node)) continue;
		const text = node.data;

		for (const match of text.matchAll(OPEN_RE)) {
			events.push({
				type: 'open',
				node,
				index: match.index ?? 0,
				length: match[0].length,
				color: match[1] as 'blue' | 'purple',
			});
		}

		let closeIndex = text.indexOf(CLOSE);
		while (closeIndex !== -1) {
			events.push({ type: 'close', node, index: closeIndex, length: CLOSE.length });
			closeIndex = text.indexOf(CLOSE, closeIndex + CLOSE.length);
		}
	}

	// TreeWalker order plus offset order gives document order.
	events.sort((a, b) => {
		if (a.node === b.node) return a.index - b.index;
		const position = a.node.compareDocumentPosition(b.node);
		return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
	});

	const pairs: TextMarkerPair[] = [];
	let open: TextMarkerEvent | null = null;
	for (const event of events) {
		if (event.type === 'open') {
			if (open === null) open = event;
			continue;
		}
		if (open !== null) {
			pairs.push({ open, close: event });
			open = null;
		}
	}
	return pairs;
}

function stripAdjacentMarker(span: HTMLElement, marker: string, before: boolean): void {
	const sibling = before ? span.previousSibling : span.nextSibling;
	if (!(sibling instanceof Text)) return;

	if (before && sibling.data.endsWith(marker)) {
		sibling.deleteData(sibling.length - marker.length, marker.length);
	} else if (!before && sibling.data.startsWith(marker)) {
		sibling.deleteData(0, marker.length);
	}
}

function renderTextColors(root: HTMLElement): void {
	// Re-scan after each rewrite. This keeps Text-node offsets valid even when
	// several colored ranges live in the same rendered paragraph.
	for (let guard = 0; guard < 1000; guard += 1) {
		const pair = collectTextMarkerPairs(root)[0];
		if (!pair || !pair.open.color) return;

		const range = document.createRange();
		range.setStart(pair.open.node, pair.open.index + pair.open.length);
		range.setEnd(pair.close.node, pair.close.index);

		const span = document.createElement('span');
		span.className = pair.open.color === 'blue' ? 'gvkit-text-blue' : 'gvkit-text-purple';
		span.appendChild(range.extractContents());
		range.insertNode(span);

		stripAdjacentMarker(span, `~={gv-${pair.open.color}}`, true);
		stripAdjacentMarker(span, CLOSE, false);
	}
}

function firstTextNode(root: Element): Text | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	return walker.nextNode() as Text | null;
}

function renderBackgroundColors(root: HTMLElement): void {
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
	renderTextColors(root);
	renderBackgroundColors(root);
}
