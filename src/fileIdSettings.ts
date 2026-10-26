import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import { requiresLargeBackfillConfirmation } from './fileIdCore';
import { FileIdManager } from './fileIds';
import { SafeMoveManager } from './safeMove';
import { SAFE_MOVE_PLAN_PATH } from './safeMoveCore';
import { PublishSettings, checkZhouyouUrl, DEFAULT_ZHOUYOU_SECRET_REF } from './publishSettings';
import { DeviceZhouyouSecret, guardIosSettingsInputs } from './publishSecretSettings';

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
	private cleanPublish: (() => void) | null = null;
	private readonly publishSettings: () => PublishSettings | null;

	constructor(
		app: App,
		plugin: Plugin,
		private fileIds: FileIdManager,
		private safeMoves: SafeMoveManager,
		publishSettings: () => PublishSettings | null,
	) {
		super(app, plugin);
		this.publishSettings = publishSettings;
	}

	dispose(): void { this.cleanPublish?.(); this.cleanPublish = null; }

	hide(): void { this.dispose(); super.hide(); }

	display(): void {
		const { containerEl } = this;
		this.dispose();
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
			text: '按 AI / 人工已审核的“源文件 → 目标位置”清单，在真实 Obsidian 内调用官方文件移动。移动后会检查并修复仍指向旧路径的内部链接；gvkit 不参与分类判断。',
		});
		new Setting(containerEl)
			.setName('执行清单')
			.setDesc(`固定读取：${SAFE_MOVE_PLAN_PATH}。整份清单预检通过前不会移动任何文件。`)
			.addButton((button) => {
				button.setButtonText('执行安全批量移动').setWarning().onClick(async () => {
					button.setDisabled(true).setButtonText('正在执行…');
					try {
						const result = await this.safeMoves.executeCurrentPlan();
						new Notice(
							`安全批量移动完成：${result.moved}/${result.total} 个文件；修复 ${result.linksRepaired} 条内部链接。`,
							8000,
						);
					} catch (error) {
						console.error('gvkit: safe batch move failed', error);
						new Notice(error instanceof Error ? error.message : 'AI 安全批量移动失败', 12000);
					} finally {
						button.setDisabled(false).setButtonText('执行安全批量移动');
					}
				});
			});

		new Setting(containerEl)
			.setName('修复已执行清单链接')
			.setDesc('用于清单已经完成移动、但旧版本执行后仍残留旧路径链接的情况。仅当所有旧源已不存在且所有新目标都存在时才会修改。')
			.addButton((button) => {
				button.setButtonText('检查并修复').onClick(async () => {
					button.setDisabled(true).setButtonText('正在检查…');
					try {
						const result = await this.safeMoves.repairCompletedCurrentPlanLinks();
						new Notice(
							`链接检查完成：修复 ${result.linksRepaired} 条，涉及 ${result.filesChanged} 个文件。`,
							8000,
						);
					} catch (error) {
						console.error('gvkit: completed safe move link repair failed', error);
						new Notice(error instanceof Error ? error.message : '安全移动链接修复失败', 12000);
					} finally {
						button.setDisabled(false).setButtonText('检查并修复');
					}
				});
			});
		const prefs = this.publishSettings();
		if (prefs?.isLoaded()) { this.renderZhouyou(prefs); this.renderCollab(prefs); }
		else this.containerEl.createEl('p', { text: '宙游文档中心设置初始化中，请重新打开设置页。' });
	}

    private renderCollab(prefs: PublishSettings): void {
        const root = this.containerEl.createDiv({ cls: 'gvkit-collab-settings' });
        root.createEl('h2', { text: '发布到协作板' });
        root.createEl('p', { text: '先在 grealm.net/collab-board/ → 我的机器凭据中生成发布 Key，复制后在下方粘贴并保存。Key 默认永不过期，可随时在网站撤销。' });
        if (!this.app.secretStorage || typeof this.app.secretStorage.setSecret !== 'function') {
            root.createEl('p', { text: '当前 Obsidian 不支持本机安全存储 Key，请更新 Obsidian。' });
            return;
        }
        const status = root.createEl('p');
        const refreshStatus = () => {
            status.setText(this.app.secretStorage?.getSecret(prefs.getCollabSecretRef())
                ? '本设备已保存发布 Key（首次发布时验证有效性）。'
                : '本设备尚未配置发布 Key。');
        };
        refreshStatus();
        let readKey = () => '';
        let clearKey = () => {};
        new Setting(root).setName('发布 Key')
            .setDesc('将网站生成的完整 Key 粘贴到这里，点击保存。仅存于本设备的 Obsidian 安全机密存储。')
            .addText(input => {
                input.setPlaceholder('粘贴发布 Key');
                input.inputEl.type = 'password';
                input.inputEl.autocomplete = 'off';
                input.inputEl.style.fontSize = '16px';
                readKey = () => input.getValue();
                clearKey = () => input.setValue('');
            })
            .addButton(button => button.setButtonText('保存').setCta().onClick(() => {
                const key = readKey().trim();
                if (!/^cbm_[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(key)) {
                    new Notice('Key 格式不正确，请复制协作板生成的完整发布 Key。');
                    return;
                }
                try {
                    this.app.secretStorage.setSecret(prefs.getCollabSecretRef(), key);
                    clearKey();
                    refreshStatus();
                    new Notice('发布 Key 已保存到本设备。');
                } catch {
                    new Notice('Key 未能保存，请检查 Obsidian 安全机密设置。');
                }
            }));
        root.createEl('p', { text: '之后打开一篇 Markdown，点「发布 → 发布到协作板」。发布后在协作板「全局文档管理」中勾选策划所在项目，即可分享。' });
    }

	private renderZhouyou(prefs: PublishSettings): void {
		const root = this.containerEl.createDiv({ cls: 'gvkit-zhouyou-settings' });
		root.createEl('h2', { text: '宙游文档中心' });
		let live = true;
		const local = new DeviceZhouyouSecret({
			secretStorage: this.app.secretStorage,
			loadLocalStorage: key => this.app.loadLocalStorage(key),
			saveLocalStorage: (key, value) => this.app.saveLocalStorage(key, value),
		}, () => prefs.getZhouyouSecretReference());
		const releaseViewport = guardIosSettingsInputs(root, Platform.isIosApp);
		let urlInput: TextComponent;
		let keyInput: TextComponent;
		this.cleanPublish = () => { live = false; keyInput?.setValue(''); releaseViewport(); };

		new Setting(root).setName('地址').setDesc('支持 HTTP 和 HTTPS。')
			.addText(text => {
				urlInput = text;
				text.setValue(prefs.getZhouyouUrl()).setPlaceholder('填写完整同步接口地址');
				text.inputEl.setAttribute('autocomplete', 'off');
				text.inputEl.setAttribute('autocapitalize', 'off');
				text.inputEl.spellcheck = false;
			})
			.addButton(button => {
				button.setButtonText('保存').onClick(async () => {
					if (!live || button.buttonEl.disabled) return;
					const check = checkZhouyouUrl(urlInput.getValue());
					if (!check.ok) { new Notice(check.message); return; }
					button.setDisabled(true);
					urlInput.setDisabled(true);
					try {
						await prefs.setZhouyouUrl(check.value);
						if (live) { urlInput.setValue(check.value); new Notice('地址已保存'); }
					} catch {
						if (live) new Notice('地址未能保存，请重试');
					} finally {
						if (live) { button.setDisabled(false); urlInput.setDisabled(false); }
					}
				});
				button.buttonEl.style.touchAction = 'manipulation';
			});

		const supported = local.supported();
		new Setting(root).setName('Key')
			.setDesc(supported ? '仅保存在本设备。' : '当前 Obsidian 不支持机密存储，请更新后保存 Key。')
			.addText(text => {
				keyInput = text;
				text.inputEl.type = 'password';
				text.inputEl.setAttribute('autocomplete', 'new-password');
				text.inputEl.setAttribute('autocapitalize', 'off');
				text.inputEl.spellcheck = false;
				text.setPlaceholder(local.status() === 'configured' ? '已保存；输入新 Key 可替换' : '填写 Key');
				text.setDisabled(!supported);
			})
			.addButton(button => {
				button.setButtonText('保存').setDisabled(!supported).onClick(() => {
					if (!live || !supported) return;
					const key = keyInput.getValue().trim();
					if (!key) { new Notice('请先填写 Key'); return; }
					try {
						// Save to the dedicated slot, preserving any previously selected shared secret.
						this.app.secretStorage.setSecret(DEFAULT_ZHOUYOU_SECRET_REF, key);
						local.select(DEFAULT_ZHOUYOU_SECRET_REF);
						if (local.runtimeCredential() !== key) throw new Error('Key readback failed');
						keyInput.setValue('').setPlaceholder('已保存；输入新 Key 可替换');
						new Notice('Key 已保存');
					} catch { new Notice('Key 未能保存，请重试'); }
				});
				button.buttonEl.style.touchAction = 'manipulation';
			});
	}
}
