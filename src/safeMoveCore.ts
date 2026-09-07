import { validate as validateUuid, version as uuidVersion } from 'uuid';

export const SAFE_MOVE_PLAN_PATH = 'inbox/tmp/ai-safe-move-plan.json';

function isUuidV7(value: unknown): value is string {
	return typeof value === 'string' && validateUuid(value) && uuidVersion(value) === 7;
}

export interface SafeMoveItem {
	gvid: string;
	from: string;
	to: string;
}

export interface SafeMovePlan {
	version: 1;
	plan_id: string;
	log_path: string;
	moves: SafeMoveItem[];
}

export interface LinkIdentity {
	kind: 'gvid' | 'path';
	value: string;
	original_path: string;
}

export interface LinkBaselineEdge {
	source: LinkIdentity;
	target: LinkIdentity;
	count: number;
}

export interface LinkBaseline {
	version: 1;
	plan_id: string;
	edges: LinkBaselineEdge[];
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
	const segments = value.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new Error(`${label} 含有非法路径段`);
	}
}

export function parseSafeMovePlan(source: string): SafeMovePlan {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new Error('迁移清单不是合法 JSON');
	}
	assertPlainObject(value, '迁移清单');
	if (value.version !== 1) throw new Error('迁移清单 version 必须为 1');
	if (typeof value.plan_id !== 'string' || value.plan_id.trim().length === 0) {
		throw new Error('迁移清单缺少 plan_id');
	}
	assertSafeVaultPath(value.log_path, 'log_path');
	if (!value.log_path.startsWith('inbox/bak/') || !value.log_path.endsWith('.jsonl')) {
		throw new Error('log_path 必须位于 inbox/bak/ 下并以 .jsonl 结尾');
	}
	if (!Array.isArray(value.moves) || value.moves.length === 0) {
		throw new Error('迁移清单 moves 必须是非空数组');
	}

	const moves: SafeMoveItem[] = [];
	const seenGvid = new Set<string>();
	const seenFrom = new Set<string>();
	const seenTo = new Set<string>();
	for (let index = 0; index < value.moves.length; index += 1) {
		const raw = value.moves[index];
		assertPlainObject(raw, `moves[${index}]`);
		if (!isUuidV7(raw.gvid)) throw new Error(`moves[${index}].gvid 不是合法 UUID v7`);
		assertSafeVaultPath(raw.from, `moves[${index}].from`);
		assertSafeVaultPath(raw.to, `moves[${index}].to`);
		if (!raw.from.toLowerCase().endsWith('.md') || !raw.to.toLowerCase().endsWith('.md')) {
			throw new Error(`moves[${index}] 当前只允许移动 Markdown 文件`);
		}
		if (raw.from === raw.to) throw new Error(`moves[${index}] 原路径与目标路径相同`);
		if (seenGvid.has(raw.gvid)) throw new Error(`清单存在重复 gvid：${raw.gvid}`);
		if (seenFrom.has(raw.from)) throw new Error(`清单存在重复源路径：${raw.from}`);
		if (seenTo.has(raw.to)) throw new Error(`清单存在重复目标路径：${raw.to}`);
		seenGvid.add(raw.gvid);
		seenFrom.add(raw.from);
		seenTo.add(raw.to);
		moves.push({ gvid: raw.gvid, from: raw.from, to: raw.to });
	}

	return {
		version: 1,
		plan_id: value.plan_id,
		log_path: value.log_path,
		moves,
	};
}

export function baselinePathForLog(logPath: string): string {
	if (!logPath.endsWith('.jsonl')) throw new Error('执行日志路径必须以 .jsonl 结尾');
	return `${logPath.slice(0, -'.jsonl'.length)}.links.json`;
}

export function currentPathForIdentity(identity: LinkIdentity, plan: SafeMovePlan): string {
	if (identity.kind !== 'gvid') return identity.original_path;
	const move = plan.moves.find((item) => item.gvid === identity.value);
	return move?.to ?? identity.original_path;
}
