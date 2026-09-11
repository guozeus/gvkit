export const SAFE_MOVE_PLAN_PATH = 'settings/gvkit/ai-safe-move-plan.md';

export interface SafeMoveItem {
	from: string;
	to: string;
}

export type SafeMovePlan = SafeMoveItem[];
export type VaultPathKind = 'file' | 'folder' | 'missing';

export interface SafeMoveLinkRewriteResult {
	source: string;
	replacements: number;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${label} 必须是对象`);
	}
}

function assertSafeVaultPath(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
		throw new Error(`${label} 必须是非空 Vault 相对路径`);
	}
	if (value.startsWith('/') || value.includes('\\')) {
		throw new Error(`${label} 必须使用 Vault 相对路径和 / 分隔符`);
	}
	if (Array.from(value).some((char) => char.charCodeAt(0) < 32)) {
		throw new Error(`${label} 含有控制字符`);
	}
	const segments = value.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new Error(`${label} 含有非法路径段`);
	}
	const root = segments[0]!.toLowerCase();
	if (root === '.obsidian' || root === '.trash') {
		throw new Error(`${label} 不能指向 Obsidian 控制目录`);
	}
}

function stripOptionalFrontmatter(source: string): string {
	if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return source;
	const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
	if (!match) throw new Error('移动清单 frontmatter 不完整');
	return source.slice(match[0].length);
}

export function parseSafeMovePlan(source: string): SafeMovePlan {
	let value: unknown;
	try {
		value = JSON.parse(stripOptionalFrontmatter(source));
	} catch (error) {
		if (error instanceof Error && error.message === '移动清单 frontmatter 不完整') throw error;
		throw new Error('移动清单不是合法 JSON');
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('移动清单必须是非空数组');
	}

	const moves: SafeMoveItem[] = [];
	const seenFrom = new Set<string>();
	const seenTo = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const raw = value[index];
		assertPlainObject(raw, `moves[${index}]`);
		assertSafeVaultPath(raw.from, `moves[${index}].from`);
		assertSafeVaultPath(raw.to, `moves[${index}].to`);

		const fromKey = raw.from.toLowerCase();
		const toKey = raw.to.toLowerCase();
		if (fromKey === toKey) throw new Error(`moves[${index}] 原路径与目标路径相同`);
		if (seenFrom.has(fromKey)) throw new Error(`清单存在重复源路径：${raw.from}`);
		if (seenTo.has(toKey)) throw new Error(`清单存在重复目标路径：${raw.to}`);
		seenFrom.add(fromKey);
		seenTo.add(toKey);
		moves.push({ from: raw.from, to: raw.to });
	}

	return moves;
}

function linkPathMap(plan: SafeMovePlan): Map<string, string> {
	const paths = new Map<string, string>();
	for (const item of plan) {
		paths.set(item.from, item.to);
		if (item.from.toLowerCase().endsWith('.md') && item.to.toLowerCase().endsWith('.md')) {
			paths.set(item.from.slice(0, -3), item.to.slice(0, -3));
		}
	}
	return paths;
}

function linkPathEnd(inner: string): number {
	let end = inner.length;
	for (const separator of ['|', '#', '^']) {
		const index = inner.indexOf(separator);
		if (index !== -1 && index < end) end = index;
	}
	return end;
}

export function rewriteSafeMoveWikiLinks(source: string, plan: SafeMovePlan): SafeMoveLinkRewriteResult {
	const paths = linkPathMap(plan);
	const wikiLinkPattern = new RegExp('(!?\\[\\[)([^\\]\\n]+)(\\]\\])', 'g');
	let replacements = 0;
	const rewritten = source.replace(wikiLinkPattern, (whole, open: string, inner: string, close: string) => {
		const end = linkPathEnd(inner);
		const path = inner.slice(0, end);
		const replacement = paths.get(path);
		if (!replacement) return whole;
		replacements += 1;
		return open + replacement + inner.slice(end) + close;
	});
	return { source: rewritten, replacements };
}

export function parentPath(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

export function parentPaths(path: string): string[] {
	const parents: string[] = [];
	let current = parentPath(path);
	while (current !== '') {
		parents.push(current);
		current = parentPath(current);
	}
	return parents;
}

export function requiredTargetFolders(plan: SafeMovePlan): string[] {
	const folders = new Set<string>();
	for (const item of plan) {
		for (const parent of parentPaths(item.to)) folders.add(parent);
	}
	return [...folders].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

export function validateSafeMovePreflight(
	plan: SafeMovePlan,
	getPathKind: (path: string) => VaultPathKind,
): string[] {
	const errors: string[] = [];
	for (const item of plan) {
		if (getPathKind(item.from) !== 'file') {
			errors.push(`源文件不存在：${item.from}`);
			continue;
		}
		if (getPathKind(item.to) !== 'missing') {
			errors.push(`目标路径已存在：${item.to}`);
			continue;
		}
		for (const parent of parentPaths(item.to)) {
			if (getPathKind(parent) === 'file') {
				errors.push(`目标目录路径被文件占用：${parent}`);
				break;
			}
		}
	}
	return errors;
}

export function validateCompletedSafeMovePlan(
	plan: SafeMovePlan,
	getPathKind: (path: string) => VaultPathKind,
): string[] {
	const errors: string[] = [];
	for (const item of plan) {
		if (getPathKind(item.from) !== 'missing') {
			errors.push(`旧源路径仍然存在：${item.from}`);
			continue;
		}
		if (getPathKind(item.to) !== 'file') {
			errors.push(`已移动目标文件不存在：${item.to}`);
		}
	}
	return errors;
}
