import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { requiresLargeBackfillConfirmation } from './fileIdCore';
import { FileIdManager } from './fileIds';
import { SafeMoveManager } from './safeMove';
import { SAFE_MOVE_PLAN_PATH } from './safeMoveCore';

class LargeBackfillConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private missingCount: number,
		private resolveChoice: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('确认批量补齐文件 ID');
		this.contentEl.createEl('p', {
			text: `发现 ${this.missingCount.toLocaleString()} 个 Markdown 文件缺失 gvid。继续将批量修改大量文件，并可能在一段时间内增加 Obsidian、同步和 Git 负载。`,
		});

		new Setting(this.contentEl)
			.addButton((button) => {
				button.setButtonText('取消').onClick(() => {
					this.finish(false);
				});
			})
			.addButton((button) => {
				button.setButtonText('确认继续').setWarning().onClick(() => {
					this.finish(true);
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.finish(false, false);
	}

	private finish(confirmed: boolean, close = true): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolveChoice(confirmed);
		if (close) this.close();
	}
}

function confirmLargeBackfill(app: App, missingCount: number): Promise<boolean> {
	return new Promise((resolve) => {
		new LargeBackfillConfirmModal(app, missingCount, resolve).open();
	});
}

function formatFailureSuffix(inspectFailures: number, writeFailures: number): string {
	const total = inspectFailures + writeFailures;
	return total > 0 ? `；另有 ${total} 个文件因读取或 frontmatter 错误未处理` : '';
}

export class GvkitSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private fileIds: FileIdManager,
		private safeMoves: SafeMoveManager,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: '文件 ID' });
		containerEl.createEl('p', {
			text: '新建 Markdown 文件自动获得永久唯一的 gvid，采用 UUID v7。实际模板源目录 settings/模板/ 与 settings/gvkit/ 控制文件不参与赋 ID。',
		});

		new Setting(containerEl)
			.setName('补齐缺失 ID')
			.setDesc('按需扫描现有 Markdown 文件，只为缺少 gvid 的目标文件补齐 ID。')
			.addButton((button) => {
				button.setButtonText('补齐缺失 ID').onClick(async () => {
					button.setDisabled(true).setButtonText('正在检查…');
					try {
						const scan = await this.fileIds.scanMissingGvid();
						const missingCount = scan.missingFiles.length;

						if (missingCount === 0) {
							new Notice(`没有需要补齐的文件${formatFailureSuffix(scan.inspectionFailures.length, 0)}`);
							return;
						}

						if (requiresLargeBackfillConfirmation(missingCount)) {
							const confirmed = await confirmLargeBackfill(this.app, missingCount);
							if (!confirmed) {
								new Notice('已取消批量补齐，未修改文件');
								return;
							}
						}

						button.setButtonText('正在补齐…');
						const result = await this.fileIds.backfillMissingGvid(scan.missingFiles);
						new Notice(
							`已补齐 ${result.added} 个文件 ID${formatFailureSuffix(scan.inspectionFailures.length, result.failures.length)}`,
							8000,
						);
					} catch (error) {
						console.error('gvkit: failed to backfill file IDs', error);
						new Notice('补齐文件 ID 失败，请查看控制台错误');
					} finally {
						button.setDisabled(false).setButtonText('补齐缺失 ID');
					}
				});
			});

		containerEl.createEl('h2', { text: 'AI 安全批量移动' });
		containerEl.createEl('p', {
			text: '按 AI / 人工已审核的“源文件 → 目标位置”清单，在真实 Obsidian 内调用官方文件移动。gvkit 只负责执行，不参与分类判断。',
		});
		new Setting(containerEl)
			.setName('执行清单')
			.setDesc(`固定读取：${SAFE_MOVE_PLAN_PATH}。整份清单预检通过前不会移动任何文件。`)
			.addButton((button) => {
				button.setButtonText('执行安全批量移动').setWarning().onClick(async () => {
					button.setDisabled(true).setButtonText('正在执行…');
					try {
						const result = await this.safeMoves.executeCurrentPlan();
						new Notice(`安全批量移动完成：${result.moved}/${result.total} 个文件。`, 8000);
					} catch (error) {
						console.error('gvkit: safe batch move failed', error);
						new Notice(error instanceof Error ? error.message : 'AI 安全批量移动失败', 12000);
					} finally {
						button.setDisabled(false).setButtonText('执行安全批量移动');
					}
				});
			});
	}
}
