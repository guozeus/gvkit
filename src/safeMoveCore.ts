export const SAFE_MOVE_PLAN_PATH = 'inbox/tmp/ai-safe-move-plan.json';

export interface SafeMoveItem {
	from: string;
	to: string;
}

export type SafeMovePlan = SafeMoveItem[];
export type VaultPathKind = 'file' | 'folder' | 'missing';

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

export function parseSafeMovePlan(source: string): SafeMovePlan {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
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

export function parentPath(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
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
		const parent = parentPath(item.to);
		if (parent !== '' && getPathKind(parent) !== 'folder') {
			errors.push(`目标目录不存在：${parent}`);
		}
	}
	return errors;
}
