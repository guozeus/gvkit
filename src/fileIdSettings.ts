import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { requiresLargeBackfillConfirmation } from './fileIdCore';
import { FileIdManager } from './fileIds';

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
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: '文件 ID' });
		containerEl.createEl('p', {
			text: '新建 Markdown 文件自动获得永久唯一的 gvid，采用 UUID v7。实际模板源目录 settings/模板/ 不参与赋 ID。',
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
	}
}
