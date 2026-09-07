import {
	App,
	getFrontMatterInfo,
	normalizePath,
	parseYaml,
	TFile,
	TFolder,
} from 'obsidian';
import { isUuidV7 } from './fileIdCore';
import {
	baselinePathForLog,
	currentPathForIdentity,
	parseSafeMovePlan,
	SAFE_MOVE_PLAN_PATH,
	type LinkBaseline,
	type LinkBaselineEdge,
	type LinkIdentity,
	type SafeMoveItem,
	type SafeMovePlan,
} from './safeMoveCore';

interface PreflightMove {
	item: SafeMoveItem;
	status: 'pending' | 'completed';
}

interface SafeMoveRunResult {
	planId: string;
	moved: number;
	skippedCompleted: number;
	validatedEdges: number;
}

interface MoveLogEntry {
	type: 'move';
	plan_id: string;
	timestamp: string;
	gvid: string;
	from: string;
	to: string;
	status: 'success' | 'failure';
	error?: string;
}

const LINK_VALIDATION_TIMEOUT_MS = 10_000;
const LINK_VALIDATION_POLL_MS = 200;
const MOVE_YIELD_EVERY = 20;

function parentPath(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function yieldToUi(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export class SafeMoveManager {
	constructor(private app: App) {}

	async executeCurrentPlan(): Promise<SafeMoveRunResult> {
		const plan = await this.readPlan();
		const preflight = await this.preflight(plan);
		const baseline = await this.loadOrCreateLinkBaseline(plan);
		let moved = 0;
		let skippedCompleted = 0;

		for (let index = 0; index < preflight.length; index += 1) {
			const entry = preflight[index]!;
			if (entry.status === 'completed') {
				skippedCompleted += 1;
				continue;
			}

			try {
				const file = this.app.vault.getAbstractFileByPath(entry.item.from);
				if (!(file instanceof TFile)) throw new Error('执行时源文件已不存在');
				await this.app.fileManager.renameFile(file, entry.item.to);
				await this.appendMoveLog(plan, entry.item, 'success');
				moved += 1;
			} catch (error) {
				await this.appendMoveLog(plan, entry.item, 'failure', error);
				throw new Error(`移动失败：${entry.item.from} → ${entry.item.to}：${formatError(error)}`);
			}

			if ((index + 1) % MOVE_YIELD_EVERY === 0) await yieldToUi();
		}

		await this.waitForLinkBaseline(plan, baseline);
		await this.appendValidationLog(plan, baseline.edges.length, 'success');
		return {
			planId: plan.plan_id,
			moved,
			skippedCompleted,
			validatedEdges: baseline.edges.length,
		};
	}

	private async readPlan(): Promise<SafeMovePlan> {
		const file = this.app.vault.getAbstractFileByPath(SAFE_MOVE_PLAN_PATH);
		if (!(file instanceof TFile)) {
			throw new Error(`未找到执行清单：${SAFE_MOVE_PLAN_PATH}`);
		}
		return parseSafeMovePlan(await this.app.vault.read(file));
	}

	private async preflight(plan: SafeMovePlan): Promise<PreflightMove[]> {
		const logParent = this.app.vault.getAbstractFileByPath(parentPath(plan.log_path));
		if (!(logParent instanceof TFolder)) {
			throw new Error(`执行日志目录不存在：${parentPath(plan.log_path)}`);
		}

		const successful = await this.readSuccessfulLogEntries(plan);
		const result: PreflightMove[] = [];
		const errors: string[] = [];
		for (const item of plan.moves) {
			const source = this.app.vault.getAbstractFileByPath(item.from);
			const destination = this.app.vault.getAbstractFileByPath(item.to);
			const destinationParent = this.app.vault.getAbstractFileByPath(parentPath(item.to));
			const priorSuccess = successful.get(item.gvid);

			if (priorSuccess) {
				if (source !== null) {
					errors.push(`${item.gvid} 已记录成功但源路径仍存在：${item.from}`);
					continue;
				}
				if (!(destination instanceof TFile)) {
					errors.push(`${item.gvid} 已记录成功但目标文件不存在：${item.to}`);
					continue;
				}
				const destinationGvid = await this.readGvid(destination);
				if (destinationGvid !== item.gvid) {
					errors.push(`${item.gvid} 已记录成功但目标文件 GVID 不匹配：${item.to}`);
					continue;
				}
				result.push({ item, status: 'completed' });
				continue;
			}

			if (!(source instanceof TFile)) {
				errors.push(`源文件不存在：${item.from}`);
				continue;
			}
			if (destination !== null) {
				errors.push(`目标路径已存在：${item.to}`);
				continue;
			}
			if (!(destinationParent instanceof TFolder)) {
				errors.push(`目标目录不存在：${parentPath(item.to)}`);
				continue;
			}
			const sourceGvid = await this.readGvid(source);
			if (sourceGvid !== item.gvid) {
				errors.push(`源文件 GVID 不匹配：${item.from}`);
				continue;
			}
			result.push({ item, status: 'pending' });
		}

		if (errors.length > 0) {
			throw new Error(`迁移清单预检失败，未移动任何新文件：\n${errors.slice(0, 20).join('\n')}${errors.length > 20 ? `\n……另有 ${errors.length - 20} 项` : ''}`);
		}
		return result;
	}

	private async readGvid(file: TFile): Promise<string | null> {
		const cached = this.app.metadataCache.getFileCache(file)?.frontmatter?.gvid;
		if (isUuidV7(cached)) return cached;
		const source = await this.app.vault.read(file);
		const info = getFrontMatterInfo(source);
		if (!info.exists) return null;
		const parsed = parseYaml(info.frontmatter);
		const value = parsed?.gvid;
		return isUuidV7(value) ? value : null;
	}

	private async readSuccessfulLogEntries(plan: SafeMovePlan): Promise<Map<string, MoveLogEntry>> {
		const file = this.app.vault.getAbstractFileByPath(plan.log_path);
		if (file === null) return new Map();
		if (!(file instanceof TFile)) throw new Error(`执行日志路径不是文件：${plan.log_path}`);
		const result = new Map<string, MoveLogEntry>();
		for (const line of (await this.app.vault.read(file)).split(/\r?\n/)) {
			if (line.trim().length === 0) continue;
			try {
				const value = JSON.parse(line) as Partial<MoveLogEntry>;
				if (
					value.type === 'move' &&
					value.plan_id === plan.plan_id &&
					value.status === 'success' &&
					typeof value.gvid === 'string' &&
					typeof value.from === 'string' &&
					typeof value.to === 'string'
				) {
					const planItem = plan.moves.find((item) => item.gvid === value.gvid);
					if (planItem && planItem.from === value.from && planItem.to === value.to) {
						result.set(value.gvid, value as MoveLogEntry);
					}
				}
			} catch {
				throw new Error(`执行日志包含非法 JSONL：${plan.log_path}`);
			}
		}
		return result;
	}

	private async loadOrCreateLinkBaseline(plan: SafeMovePlan): Promise<LinkBaseline> {
		const path = baselinePathForLog(plan.log_path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const value = JSON.parse(await this.app.vault.read(existing)) as LinkBaseline;
			if (value.version !== 1 || value.plan_id !== plan.plan_id || !Array.isArray(value.edges)) {
				throw new Error(`链接基线与当前计划不匹配：${path}`);
			}
			return value;
		}
		if (existing !== null) throw new Error(`链接基线路径不是文件：${path}`);
		const completed = await this.readSuccessfulLogEntries(plan);
		if (completed.size > 0) {
			throw new Error(`当前计划已有成功移动记录，但原始链接基线不存在：${path}`);
		}

		const baseline: LinkBaseline = {
			version: 1,
			plan_id: plan.plan_id,
			edges: await this.collectAffectedLinkEdges(plan),
		};
		await this.app.vault.create(path, `${JSON.stringify(baseline, null, 2)}\n`);
		return baseline;
	}

	private async collectAffectedLinkEdges(plan: SafeMovePlan): Promise<LinkBaselineEdge[]> {
		const movedPaths = new Set(plan.moves.map((item) => item.from));
		const identityCache = new Map<string, LinkIdentity>();
		const getIdentity = async (path: string): Promise<LinkIdentity> => {
			const cached = identityCache.get(path);
			if (cached) return cached;
			const file = this.app.vault.getAbstractFileByPath(path);
			let identity: LinkIdentity;
			if (file instanceof TFile && path.toLowerCase().endsWith('.md')) {
				const gvid = await this.readGvid(file);
				identity = gvid
					? { kind: 'gvid', value: gvid, original_path: path }
					: { kind: 'path', value: path, original_path: path };
			} else {
				identity = { kind: 'path', value: path, original_path: path };
			}
			identityCache.set(path, identity);
			return identity;
		};

		const edges: LinkBaselineEdge[] = [];
		for (const [sourcePath, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			for (const [targetPath, count] of Object.entries(targets)) {
				if (!sourcePath.toLowerCase().endsWith('.md') || !targetPath.toLowerCase().endsWith('.md')) continue;
				if (!movedPaths.has(sourcePath) && !movedPaths.has(targetPath)) continue;
				edges.push({
					source: await getIdentity(sourcePath),
					target: await getIdentity(targetPath),
					count,
				});
			}
		}
		return edges.sort((left, right) => {
			const a = `${left.source.kind}:${left.source.value}>${left.target.kind}:${left.target.value}`;
			const b = `${right.source.kind}:${right.source.value}>${right.target.kind}:${right.target.value}`;
			return a.localeCompare(b);
		});
	}

	private linksMatchBaseline(plan: SafeMovePlan, baseline: LinkBaseline): { ok: true } | { ok: false; errors: string[] } {
		const errors: string[] = [];
		for (const edge of baseline.edges) {
			const sourcePath = normalizePath(currentPathForIdentity(edge.source, plan));
			const targetPath = normalizePath(currentPathForIdentity(edge.target, plan));
			const actual = this.app.metadataCache.resolvedLinks[sourcePath]?.[targetPath] ?? 0;
			if (actual !== edge.count) {
				errors.push(`${sourcePath} → ${targetPath}：迁移前 ${edge.count}，迁移后 ${actual}`);
			}
		}
		return errors.length === 0 ? { ok: true } : { ok: false, errors };
	}

	private async waitForLinkBaseline(plan: SafeMovePlan, baseline: LinkBaseline): Promise<void> {
		const deadline = Date.now() + LINK_VALIDATION_TIMEOUT_MS;
		let latestErrors: string[] = [];
		while (Date.now() <= deadline) {
			const result = this.linksMatchBaseline(plan, baseline);
			if (result.ok) return;
			latestErrors = result.errors;
			await new Promise((resolve) => window.setTimeout(resolve, LINK_VALIDATION_POLL_MS));
		}
		await this.appendValidationLog(plan, baseline.edges.length, 'failure', latestErrors);
		throw new Error(`页面链接语义验收失败：\n${latestErrors.slice(0, 20).join('\n')}${latestErrors.length > 20 ? `\n……另有 ${latestErrors.length - 20} 项` : ''}`);
	}

	private async appendMoveLog(
		plan: SafeMovePlan,
		item: SafeMoveItem,
		status: 'success' | 'failure',
		error?: unknown,
	): Promise<void> {
		const entry: MoveLogEntry = {
			type: 'move',
			plan_id: plan.plan_id,
			timestamp: new Date().toISOString(),
			gvid: item.gvid,
			from: item.from,
			to: item.to,
			status,
			...(error === undefined ? {} : { error: formatError(error) }),
		};
		await this.appendJsonLine(plan.log_path, entry);
	}

	private async appendValidationLog(
		plan: SafeMovePlan,
		edgeCount: number,
		status: 'success' | 'failure',
		errors: string[] = [],
	): Promise<void> {
		await this.appendJsonLine(plan.log_path, {
			type: 'link_validation',
			plan_id: plan.plan_id,
			timestamp: new Date().toISOString(),
			status,
			edge_count: edgeCount,
			...(errors.length === 0 ? {} : { errors }),
		});
	}

	private async appendJsonLine(path: string, value: unknown): Promise<void> {
		const line = `${JSON.stringify(value)}\n`;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing === null) {
			await this.app.vault.create(path, line);
			return;
		}
		if (!(existing instanceof TFile)) throw new Error(`日志路径不是文件：${path}`);
		await this.app.vault.append(existing, line);
	}
}
