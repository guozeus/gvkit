export type StyleAction =
	| 'text-blue'
	| 'text-purple'
	| 'bg-blue'
	| 'bg-purple'
	| 'clear';

interface Wrapper {
	open: string;
	close: string;
	kind: 'text' | 'bg';
	color: 'blue' | 'purple';
}

const WRAPPERS: Record<Exclude<StyleAction, 'clear'>, Wrapper> = {
	'text-blue': {
		open: '<span class="gvkit-text-blue">',
		close: '</span>',
		kind: 'text',
		color: 'blue',
	},
	'text-purple': {
		open: '<span class="gvkit-text-purple">',
		close: '</span>',
		kind: 'text',
		color: 'purple',
	},
	'bg-blue': {
		open: '<mark class="gvkit-bg-blue">',
		close: '</mark>',
		kind: 'bg',
		color: 'blue',
	},
	'bg-purple': {
		open: '<mark class="gvkit-bg-purple">',
		close: '</mark>',
		kind: 'bg',
		color: 'purple',
	},
};

const TEXT_WRAPPER_RE = /^<span class="gvkit-text-(blue|purple)">([\s\S]*)<\/span>$/u;
const BG_WRAPPER_RE = /^<mark class="gvkit-bg-(blue|purple)">([\s\S]*)<\/mark>$/u;

const COMPLETE_TEXT_WRAPPER_RE = /<span class="gvkit-text-(?:blue|purple)">([\s\S]*?)<\/span>/gu;
const COMPLETE_BG_WRAPPER_RE = /<mark class="gvkit-bg-(?:blue|purple)">([\s\S]*?)<\/mark>/gu;

/**
 * Removes only markup created by this plugin. Other HTML remains untouched.
 */
export function removeGvkitStyleMarkup(text: string): string {
	let previous = '';
	let next = text;

	// Repeat so nested gvkit wrappers are removed as well.
	while (next !== previous) {
		previous = next;
		next = next
			.replace(COMPLETE_TEXT_WRAPPER_RE, '$1')
			.replace(COMPLETE_BG_WRAPPER_RE, '$1');
	}

	return next;
}

function styleSingleLine(line: string, action: Exclude<StyleAction, 'clear'>): string {
	if (line.length === 0) return line;

	const wrapper = WRAPPERS[action];
	const sameKindMatch = wrapper.kind === 'text' ? line.match(TEXT_WRAPPER_RE) : line.match(BG_WRAPPER_RE);

	if (sameKindMatch) {
		const currentColor = sameKindMatch[1];
		const inner = sameKindMatch[2] ?? '';

		// Applying the same style twice toggles that layer off.
		if (currentColor === wrapper.color) return inner;

		// Switching blue <-> purple replaces the existing wrapper instead of nesting it.
		return `${wrapper.open}${inner}${wrapper.close}`;
	}

	return `${wrapper.open}${line}${wrapper.close}`;
}

/**
 * Applies one semantic style wrapper to the selected source text.
 * Multi-line selections are styled line-by-line so inline HTML does not span blocks.
 */
export function applyGvkitStyleMarkup(text: string, action: StyleAction): string {
	if (action === 'clear') return removeGvkitStyleMarkup(text);
	if (text.length === 0) return text;

	return text
		.split('\n')
		.map((line) => styleSingleLine(line, action))
		.join('\n');
}
