import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import { requiresLargeBackfillConfirmation } from './fileIdCore';
import { FileIdManager } from './fileIds';
import { SafeMoveManager } from './safeMove';
import { SAFE_MOVE_PLAN_PATH } from './safeMoveCore';
import { PublishSettings, checkZhouyouUrl } from './publishSettings';
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
        root.createEl('h2', { text: '协作板' });
        root.createEl('p', { text: '在 grealm.net/collab-board/ 的「我的机器凭据」签发本人 publication_device 凭据（不是 AI Token）。只发布当前手动确认的一篇；内部项目可见性在协作板管理页另行勾选。' });
        const field = new Setting(root).setName('跨设备 Vault 命名空间')
            .setDesc('同一 Vault 的各台设备必须填写相同值；首次可自动生成。已有已发布文档后禁止修改。');
        field.addText(input => {
            input.setValue(prefs.getCollabSpaceId()).setPlaceholder('首次自动生成或粘贴另一设备的值');
            input.inputEl.addEventListener('change', () => {
                const value = input.getValue().trim();
                if (!value) return;
                void prefs.setCollabSpaceId(value).catch(e => new Notice(e instanceof Error ? e.message : '无法保存命名空间'));
            });
        }).addButton(button => button.setButtonText('生成/查看').onClick(() => {
            void prefs.ensureCollabSpaceId().then(v => {
                new Notice('协作板命名空间：' + v, 10000);
                this.display();
            }).catch(() => new Notice('命名空间保存失败'));
        }));
        if (!this.app.secretStorage || typeof SecretComponent !== 'function') {
            root.createEl('p', { text: '当前 Obsidian 不支持原生机密设置，协作板发布不可用。' });
            return;
        }
        new Setting(root).setName('本设备协作板凭据')
            .setDesc('使用 Obsidian 原生机密控件创建/选择；仅保存机密引用，凭据不写入插件数据。')
            .addComponent(el => new SecretComponent(this.app, el)
                .setValue(prefs.getCollabSecretRef())
                .onChange(ref => {
                    if (ref) void prefs.setCollabSecretRef(ref).catch(() => new Notice('凭据引用保存失败'));
                }));
        root.createEl('p', { text: '发布后可在 https://grealm.net/collab-board/ 管理文档。当前支持首次发布和已绑定、原路径文档的自动内容同步；移动/撤回/图片以及跨设备冲突恢复仍待后续联调。' });
    }

	private renderZhouyou(prefs: PublishSettings): void {
		const root = this.containerEl.createDiv({ cls: 'gvkit-zhouyou-settings' });
		root.createEl('h2', { text: '宙游文档中心' });
		root.createEl('p', { text: '设置完成不代表已连接公司服务器；每台设备须本人分别填写 Key。' });
		let live = true;
		let latestUrlChoice = 0;
		const local = new DeviceZhouyouSecret({
			secretStorage: this.app.secretStorage,
			loadLocalStorage: key => this.app.loadLocalStorage(key),
			saveLocalStorage: (key, value) => this.app.saveLocalStorage(key, value),
		}, () => prefs.getZhouyouSecretReference());
		const releaseViewport = guardIosSettingsInputs(root, Platform.isIosApp);
		this.cleanPublish = () => { live = false; releaseViewport(); };

		new Setting(root).setName('完整同步地址')
			.setDesc('必须是公司提供的 HTTPS 地址，以 /api/producer-documents/obsidian-sync 结尾，不含查询或片段。')
			.addText(text => {
				text.setValue(prefs.getZhouyouUrl()).setPlaceholder('https://公司接口域名/api/producer-documents/obsidian-sync');
				text.inputEl.setAttribute('autocomplete', 'off');
				text.inputEl.addEventListener('change', () => {
					if (!live) return;
					const check = checkZhouyouUrl(text.getValue());
					if (!check.ok) { new Notice(check.message); return; }
					const myRevision = ++latestUrlChoice;
					void prefs.setZhouyouUrl(check.value).then(() => {
						if (live && latestUrlChoice === myRevision) text.setValue(prefs.getZhouyouUrl());
					}).catch(() => {
						if (!live || latestUrlChoice !== myRevision) return;
						text.setValue(prefs.getZhouyouUrl());
						new Notice('同步地址未能保存，请重新尝试');
					});
				});
			});

		const stateEl = root.createEl('p', { text: '' });
		stateEl.setAttribute('role', 'status');
		const update = () => {
			if (!live) return;
			const messages = {
				unsupported: '当前设备不支持官方本机机密存储，已禁用 Key 配置。',
				unconfigured: '未配置：请在原生机密控件新建并选择本设备的 Key。',
				reconfigure: '需重新配置：此设备所选引用没有有效 Key。',
				configured: '已配置（仅本设备），尚未验证公司连接与权限。',
				stopped: '本设备已停止使用 Key；底层机密未删除，其他设备不受影响。',
			};
			stateEl.setText(messages[local.status()]);
		};
		update();
		if (!local.supported() || typeof SecretComponent !== 'function') {
			new Setting(root).setName('Key 配置').setDesc('官方安全机密控件不可用，禁止改用普通同步文本设置。');
			return;
		}
		new Setting(root).setName('新建、选择或更换本机 Key')
			.setDesc('官方机密控件负责填写和遮蔽。这里只处理引用名称，绝不显示 Key 原值。')
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(local.reference())
				.onChange(ref => {
					if (!live) return;
					try {
						if (ref) local.select(ref);
						else local.stop();
						update();
					} catch {
						new Notice('本机机密引用未能保存，请重新选择');
					}
				}));
		new Setting(root).setName('本设备 Key 状态')
			.setDesc('清除仅停止 GVKit 在本机使用，不会改动共享引用、图标偏好、业务绑定或记录历史。')
			.addButton(b => {
				b.setButtonText('刷新状态').onClick(update);
				b.buttonEl.style.touchAction = 'manipulation';
			})
			.addButton(b => {
				b.setButtonText('重新启用').setCta().onClick(() => {
					if (!live) return;
					try { local.enable(); update(); }
					catch { new Notice('本机 Key 无法启用，请检查安全机密设置'); }
				});
				b.buttonEl.style.touchAction = 'manipulation';
			})
			.addButton(b => {
				b.setButtonText('停止本机使用').onClick(() => {
					if (!live) return;
					try { local.stop(); update(); }
					catch { new Notice('本机 Key 未能停止使用，请检查设备设置'); }
				});
				b.buttonEl.style.touchAction = 'manipulation';
			});
		root.createEl('p', { text: '停止使用不会物理删除 Key。若需要真正删除，请到本机 Obsidian 原生机密管理中操作；此插件不调用不存在的删除 API。' });
	}
}
