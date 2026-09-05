import { validate as validateUuid, v7 as uuidv7, version as uuidVersion } from 'uuid';

export const GVID_FIELD = 'gvid';
export const LARGE_ID_BACKFILL_THRESHOLD = 10_000;
export const TEMPLATE_SOURCE_PREFIX = 'settings/模板/';

export function createGvid(): string {
	return uuidv7();
}

export function isUuidV7(value: unknown): value is string {
	return typeof value === 'string' && validateUuid(value) && uuidVersion(value) === 7;
}

export function hasOwnGvid(frontmatter: unknown): boolean {
	return (
		typeof frontmatter === 'object' &&
		frontmatter !== null &&
		Object.prototype.hasOwnProperty.call(frontmatter, GVID_FIELD)
	);
}

export function isTargetMarkdownPath(path: string): boolean {
	return path.toLowerCase().endsWith('.md') && !path.startsWith(TEMPLATE_SOURCE_PREFIX);
}

export function requiresLargeBackfillConfirmation(missingCount: number): boolean {
	return missingCount >= LARGE_ID_BACKFILL_THRESHOLD;
}

function preferredLineEnding(source: string): '\n' | '\r\n' {
	const firstNewline = source.indexOf('\n');
	return firstNewline > 0 && source[firstNewline - 1] === '\r' ? '\r\n' : '\n';
}

function findFrontmatterClosingLine(source: string, startOffset: number): number | null {
	let cursor = startOffset;
	while (cursor <= source.length) {
		const lineEnd = source.indexOf('\n', cursor);
		const rawLine = lineEnd === -1 ? source.slice(cursor) : source.slice(cursor, lineEnd);
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (/^---[\t ]*$/.test(line)) return cursor;
		if (lineEnd === -1) return null;
		cursor = lineEnd + 1;
	}
	return null;
}

/**
 * Insert one gvid line without serializing or otherwise rewriting the Markdown source.
 * `frontmatterExists` must come from Obsidian's own frontmatter detection.
 * Callers must first establish that the note does not already have a top-level gvid.
 */
export function insertGvidPreservingSource(
	source: string,
	gvid: string,
	frontmatterExists: boolean,
): string {
	const bomOffset = source.startsWith('\uFEFF') ? 1 : 0;
	const lineEnding = preferredLineEnding(source.slice(bomOffset));

	if (frontmatterExists) {
		const firstLineEnd = source.indexOf('\n', bomOffset);
		if (firstLineEnd === -1) throw new Error('Frontmatter opening line has no closing block');
		const rawFirstLine = source.slice(bomOffset, firstLineEnd);
		const firstLine = rawFirstLine.endsWith('\r') ? rawFirstLine.slice(0, -1) : rawFirstLine;
		if (!/^---[\t ]*$/.test(firstLine)) throw new Error('Frontmatter opening line not found');

		const closingStart = findFrontmatterClosingLine(source, firstLineEnd + 1);
		if (closingStart === null) throw new Error('Frontmatter closing line not found');

		return `${source.slice(0, closingStart)}${GVID_FIELD}: ${gvid}${lineEnding}${source.slice(closingStart)}`;
	}

	const prefix = source.slice(0, bomOffset);
	const body = source.slice(bomOffset);
	return `${prefix}---${lineEnding}${GVID_FIELD}: ${gvid}${lineEnding}---${lineEnding}${body}`;
}
