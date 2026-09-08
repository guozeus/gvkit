export type BlockLinkKind = 'link' | 'embed';

export interface BlockSearchInsertion {
	text: string;
	cursorOffset: number;
}

export function createBlockSearchInsertion(kind: BlockLinkKind): BlockSearchInsertion {
	if (kind === 'embed') {
		return { text: '![[^^]]', cursorOffset: 5 };
	}

	return { text: '[[^^]]', cursorOffset: 4 };
}
