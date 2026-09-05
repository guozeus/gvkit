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

export function addMissingGvid(
	frontmatter: Record<string, unknown>,
	generate: () => string = createGvid,
): boolean {
	if (hasOwnGvid(frontmatter)) return false;
	frontmatter[GVID_FIELD] = generate();
	return true;
}

export function isTargetMarkdownPath(path: string): boolean {
	return path.toLowerCase().endsWith('.md') && !path.startsWith(TEMPLATE_SOURCE_PREFIX);
}

export function requiresLargeBackfillConfirmation(missingCount: number): boolean {
	return missingCount >= LARGE_ID_BACKFILL_THRESHOLD;
}
