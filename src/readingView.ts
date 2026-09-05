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

function collectMarkerPairs(root: HTMLElement, spec: MarkerSpec): MarkerPair[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const events: MarkerEvent[] = [];

	for (let current = walker.nextNode(); current; current = walker.nextNode()) {
		const node = current as Text;
		if (isInsideCode(node)) continue;
		const text = node.data;

		for (const match of text.matchAll(spec.openRe)) {
			events.push({
				type: 'open',
				node,
				index: match.index ?? 0,
				length: match[0].length,
				color: match[1] as GvkitColor,
			});
		}

		let closeIndex = text.indexOf(spec.close);
		while (closeIndex !== -1) {
			events.push({ type: 'close', node, index: closeIndex, length: spec.close.length });
			closeIndex = text.indexOf(spec.close, closeIndex + spec.close.length);
		}
	}

	events.sort((a, b) => {
		if (a.node === b.node) return a.index - b.index;
		const position = a.node.compareDocumentPosition(b.node);
		return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
	});

	const pairs: MarkerPair[] = [];
	let open: MarkerEvent | null = null;
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

function renderMarkerLayer(root: HTMLElement, spec: MarkerSpec): void {
	for (let guard = 0; guard < 1000; guard += 1) {
		const pair = collectMarkerPairs(root, spec)[0];
		if (!pair || !pair.open.color) return;

		const range = document.createRange();
		range.setStart(pair.open.node, pair.open.index + pair.open.length);
		range.setEnd(pair.close.node, pair.close.index);

		const span = document.createElement('span');
		span.className = spec.className(pair.open.color);
		span.appendChild(range.extractContents());
		range.insertNode(span);

		stripAdjacentMarker(span, spec.openText(pair.open.color), true);
		stripAdjacentMarker(span, spec.close, false);
	}
}

function firstTextNode(root: Element): Text | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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
	renderMarkerLayer(root, TEXT_SPEC);
	renderMarkerLayer(root, BG_SPEC);
	renderLegacyBackgroundColors(root);
}
