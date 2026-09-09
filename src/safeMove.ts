import { App, TFile, TFolder } from 'obsidian';
import {
	parseSafeMovePlan,
	requiredTargetFolders,
	SAFE_MOVE_PLAN_PATH,
	validateSafeMovePreflight,
	type SafeMovePlan,
	type VaultPathKind,
} from './safeMoveCore';

export interface SafeMoveRunResult {
	moved: number;
	total: number;
}

const MOVE_YIELD_EVERY = 20;

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
		this.preflight(plan);
		await this.ensureTargetFolders(plan);

		let moved = 0;
		for (let index = 0; index < plan.length; index += 1) {
			const item = plan[index]!;
			const file = this.app.vault.getAbstractFileByPath(item.from);
			if (!(file instanceof TFile)) {
				throw new Error(`执行中止（已移动 ${moved}/${plan.length}）：源文件已不存在：${item.from}`);
			}
			if (this.app.vault.getAbstractFileByPath(item.to) !== null) {
				throw new Error(`执行中止（已移动 ${moved}/${plan.length}）：目标路径已存在：${item.to}`);
			}

			try {
				await this.app.fileManager.renameFile(file, item.to);
				moved += 1;
			} catch (error) {
				throw new Error(
					`执行中止（已移动 ${moved}/${plan.length}）：${item.from} → ${item.to}：${formatError(error)}`,
				);
			}

			if ((index + 1) % MOVE_YIELD_EVERY === 0) await yieldToUi();
		}

		return { moved, total: plan.length };
	}

	private async readPlan(): Promise<SafeMovePlan> {
		const file = this.app.vault.getAbstractFileByPath(SAFE_MOVE_PLAN_PATH);
		if (!(file instanceof TFile)) {
			throw new Error(`未找到移动清单：${SAFE_MOVE_PLAN_PATH}`);
		}
		return parseSafeMovePlan(await this.app.vault.read(file));
	}

	private preflight(plan: SafeMovePlan): void {
		const errors = validateSafeMovePreflight(plan, (path) => this.getPathKind(path));
		if (errors.length > 0) {
			throw new Error(
				`移动清单预检失败，未移动任何文件：\n${errors.slice(0, 20).join('\n')}${
					errors.length > 20 ? `\n……另有 ${errors.length - 20} 项` : ''
				}`,
			);
		}
	}

	private async ensureTargetFolders(plan: SafeMovePlan): Promise<void> {
		for (const path of requiredTargetFolders(plan)) {
			const kind = this.getPathKind(path);
			if (kind === 'folder') continue;
			if (kind === 'file') throw new Error(`目标目录路径被文件占用：${path}`);
			try {
				await this.app.vault.createFolder(path);
			} catch (error) {
				throw new Error(`创建目标目录失败（尚未移动文件）：${path}：${formatError(error)}`);
			}
		}
	}

	private getPathKind(path: string): VaultPathKind {
		const value = this.app.vault.getAbstractFileByPath(path);
		if (value instanceof TFile) return 'file';
		if (value instanceof TFolder) return 'folder';
		return 'missing';
	}
}
