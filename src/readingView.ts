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
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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
	if (!(sibling instanceof Text)) return;

	if (before && sibling.data.endsWith(marker)) {
		sibling.deleteData(sibling.length - marker.length, marker.length);
	} else if (!before && sibling.data.startsWith(marker)) {
		sibling.deleteData(0, marker.length);
	}
}

function renderMarkerPair(pair: MarkerPair, spec: MarkerSpec): void {
	if (!pair.open.color) return;

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

function renderMarkerLayer(root: HTMLElement, spec: MarkerSpec): void {
	const pairs = collectMarkerPairs(root, spec);
	for (let index = pairs.length - 1; index >= 0; index -= 1) {
		const pair = pairs[index];
		if (pair) renderMarkerPair(pair, spec);
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
	// Text and background are independent layers. Each layer scans this rendered
	// section once, then applies collected ranges from back to front so earlier
	// offsets remain valid while the DOM is rewritten.
	renderMarkerLayer(root, TEXT_SPEC);
	renderMarkerLayer(root, BG_SPEC);
	renderLegacyBackgroundColors(root);
}
