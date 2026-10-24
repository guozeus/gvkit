import type { App } from 'obsidian';
import type { PublishDocumentContext } from './documentActions';
import type { ZhouyouProduct, ZhouyouResult, WriteAction } from './zhouyouClient';

/** This module never reads a Vault document or a credential. The workflow owns both. */
export type DialogAvailability = 'ready' | 'key-unconfigured' | 'url-missing' | 'unsupported' | 'disabled';
export type DialogRemoteStatus =
	| { kind: 'unlinked' }
	| { kind: 'legacy-candidate'; reviewId: number; sourcePath: string; gvid: string;
		candidatePath: string; sourceId: string; productId: string; documentId: string;
		recordVersion: number; currentVersionNo: number; localTitle: string; remoteTitle: string;
		localContent: string; remoteContent: string }
	| { kind: 'linked'; documentId: string; recordVersion: number; currentVersionNo: number;
		documentStatus: 'active' | 'archived'; verifiedPublishedVersionNo?: number;
		localContent?: string; remoteContent?: string }
	| { kind: 'conflict'; localContent?: string; remoteContent?: string }
	| { kind: 'unknown'; localContent?: string; remoteContent?: string };
export interface DialogSubmitIntent {
	readonly sourcePath: string;
	readonly productId: string;
	readonly action: WriteAction;
	readonly changeSummary: string;
}
export type DialogLinkedStatus = Extract<DialogRemoteStatus, { kind: 'linked' }>;
/** 'verified' is an explicit workflow attestation: matching ACK plus independent readback.
 * In particular publish requires independently confirmed business-publication evidence,
 * not merely equal body bytes or a higher recordVersion/currentVersionNo. */
export type DialogSubmitResult =
	| { kind: 'verified'; action: 'sync'; sourcePath: string; productId: string; status: DialogLinkedStatus }
	| { kind: 'verified'; action: 'publish'; sourcePath: string; productId: string;
		status: DialogLinkedStatus; publishedVersionNo: number }
	| { kind: 'acknowledged' | 'not-sent' | 'rejected' | 'conflict' | 'unknown' };
/** Reject malformed or mismatched verified results without depicting an unproven success. */
function matchedVerifiedStatus(result: DialogSubmitResult,
	selected: DialogConfirmation): DialogLinkedStatus | null {
	if (result.kind !== 'verified' || result.sourcePath !== selected.sourcePath ||
		result.productId !== selected.productId || result.action !== selected.action) return null;
	const status = result.status;
	if (!status || status.kind !== 'linked' || typeof status.documentId !== 'string' ||
		!status.documentId || !Number.isSafeInteger(status.recordVersion) || status.recordVersion < 1 ||
		!Number.isSafeInteger(status.currentVersionNo) || status.currentVersionNo < 0 ||
		(status.documentStatus !== 'active' && status.documentStatus !== 'archived')) return null;
	if (result.action === 'publish' &&
		(!Number.isSafeInteger(result.publishedVersionNo) || result.publishedVersionNo < 1 ||
		result.publishedVersionNo > status.currentVersionNo)) return null;
	return status;
}

export interface ZhouyouDialogHost {
	/** A status only: never return a secret or a URL containing one. */
	availability(): DialogAvailability;
	listProducts(): Promise<ZhouyouResult<ZhouyouProduct[]>>;
	/** Must query/verify the exact source and product through the workflow. Never uploads a body. */
	readStatus(productId: string): Promise<DialogRemoteStatus>;
	/** A separate user decision; these operations never send a document body. */
	confirmLegacy?(productId: string, reviewId: number): Promise<DialogRemoteStatus>;
	readAsNewDocument?(productId: string, reviewId: number): Promise<DialogRemoteStatus>;
	/** Must recheck source identity/revision, auth, binding, pending/operationId and consent before any network body. */
	submit(intent: DialogSubmitIntent): Promise<DialogSubmitResult>;
	/** Optional read-only human-review handoff. Only a verified clear may lift an uncertain-write block. */
	reviewAfterUncertain?(productId: string, observed: DialogRemoteStatus):
		Promise<{ cleared: boolean; status: DialogRemoteStatus }>;
	/** Optional navigation into the existing device-local GVKit settings. */
	openSettings?(): void;
}
export interface DialogConfirmation extends DialogSubmitIntent {
	readonly productName: string;
}
export interface DialogSnapshot {
	readonly path: string;
	readonly sourceValid: boolean;
	readonly availability: DialogAvailability;
	readonly phase: 'idle' | 'listing' | 'reading' | 'submitting';
	readonly products: readonly ZhouyouProduct[];
	readonly productId: string;
	readonly remote: DialogRemoteStatus | null;
	readonly changeSummary: string;
	readonly confirmation: DialogConfirmation | null;
	readonly notice: string;
	readonly needsReview: boolean;
}

/** Pure, one-document interaction state. No Obsidian runtime is needed for tests. */
export class ZhouyouDialogController {
	private readonly path: string;
	private readonly source: PublishDocumentContext;
	private readonly host: ZhouyouDialogHost;
	private readonly changed: () => void;
	private disposed = false;
	private epoch = 0;
	private phase: DialogSnapshot['phase'] = 'idle';
	private products: ZhouyouProduct[] = [];
	private productId = '';
	private remote: DialogRemoteStatus | null = null;
	private changeSummary = '';
	private confirmation: DialogConfirmation | null = null;
	private notice = '';
	private needsReview = false;

	constructor(source: PublishDocumentContext, host: ZhouyouDialogHost, changed: () => void = () => undefined) {
		this.source = source;
		this.path = source.file.path;
		this.host = host;
		this.changed = changed;
	}
	private validSource(): boolean {
		try { return this.source.isCurrent() && this.source.file.path === this.path; }
		catch { return false; }
	}
	private active(epoch: number): boolean { return !this.disposed && epoch === this.epoch; }
	private emit(): void { if (!this.disposed) this.changed(); }
	private ready(): boolean {
		return !this.disposed && this.validSource() && this.host.availability() === 'ready';
	}
	snapshot(): DialogSnapshot {
		return { path: this.path, sourceValid: this.validSource(),
			availability: this.host.availability(), phase: this.phase,
			products: [...this.products], productId: this.productId,
			remote: this.remote, changeSummary: this.changeSummary,
			confirmation: this.confirmation, notice: this.notice,
			needsReview: this.needsReview };
	}
	dispose(): void {
		this.disposed = true;
		this.epoch++;
		this.confirmation = null;
	}
	async loadProducts(): Promise<void> {
		if (this.phase === 'submitting' || this.phase === 'listing' || this.needsReview || !this.ready()) return;
		const id = ++this.epoch;
		this.phase = 'listing';
		this.confirmation = null;
		this.products = [];
		this.productId = '';
		this.remote = null;
		this.notice = '';
		this.emit();
		try {
			const result = await this.host.listProducts();
			if (!this.active(id) || !this.ready()) return;
			if (result.kind === 'acknowledged' && Array.isArray(result.data) &&
				result.data.every(p => typeof p.id === 'string' && !!p.id &&
					typeof p.name === 'string' && !!p.name.trim()) &&
				new Set(result.data.map(p => p.id)).size === result.data.length) {
				this.products = result.data.map(p => ({ id: p.id, name: p.name }));
				this.notice = this.products.length ? '' : '当前没有可用的授权产品。';
			} else {
				this.notice = '暂时无法取得授权产品，请核对本机配置或重新查询。';
			}
		} catch {
			if (this.active(id)) this.notice = '暂时无法取得授权产品，请稍后重新查询。';
		} finally {
			if (this.active(id)) {
				this.phase = 'idle';
				if (!this.validSource()) this.notice = '源文档已变化，请关闭后重新打开。';
				this.emit();
			}
		}
	}
	async chooseProduct(productId: string): Promise<void> {
		if (this.disposed || this.phase === 'listing' || this.phase === 'submitting' ||
			this.needsReview || !this.ready() || !this.products.some(p => p.id === productId)) return;
		++this.epoch; // An earlier product status must never replace the new selection.
		this.productId = productId;
		this.remote = null;
		this.changeSummary = '';
		this.confirmation = null;
		this.notice = '';
		this.phase = 'idle';
		this.emit();
		await this.refreshStatus();
	}
	async refreshStatus(): Promise<void> {
		if (!this.ready() || !this.productId || this.phase === 'listing' ||
			this.phase === 'submitting' || this.phase === 'reading') return;
		const productId = this.productId;
		const id = ++this.epoch;
		this.phase = 'reading';
		this.confirmation = null;
		this.notice = '';
		this.emit();
		try {
			const result = await this.host.readStatus(productId);
			if (!this.active(id) || !this.validSource() || this.productId !== productId) return;
			this.remote = result;
			this.needsReview = result.kind === 'conflict' || result.kind === 'unknown';
			if (this.needsReview) {
				this.needsReview = true;
				this.notice = result.kind === 'conflict'
					? '内容已有变更，请核对本地与远端内容。'
					: '结果未确认，请核对后再决定是否继续。';
			}
		} catch {
			if (this.active(id) && this.productId === productId) {
				this.remote = { kind: 'unknown' };
				this.needsReview = true;
				this.notice = '结果未确认，请核对后再决定是否继续。';
			}
		} finally {
			if (this.active(id)) {
				this.phase = 'idle';
				if (!this.validSource()) this.notice = '源文档已变化，请关闭后重新打开。';
				this.emit();
			}
		}
	}
	async chooseLegacy(confirm: boolean): Promise<void> {
		const candidate = this.remote;
		if (!this.ready() || this.phase !== 'idle' || this.needsReview ||
			candidate?.kind !== 'legacy-candidate' || candidate.productId !== this.productId) return;
		const action = confirm ? this.host.confirmLegacy : this.host.readAsNewDocument;
		if (!action) return;
		const id = ++this.epoch;
		this.phase = 'reading';
		this.emit();
		try {
			const result = await action(candidate.productId, candidate.reviewId);
			if (!this.active(id) || !this.validSource() || this.productId !== candidate.productId) return;
			this.remote = result;
			this.needsReview = result.kind === 'conflict' || result.kind === 'unknown';
			this.notice = result.kind === 'legacy-candidate'
				? '核对所依据的文档或远端状态已变化，请重新查询。'
				: this.needsReview ? '当前关系未确认，请重新核对。'
				: confirm ? '旧文档关系已确认；本次未同步正文或发布业务版本。'
					: '已按当前文档 GVID 独立查询，旧来源未被认领。';
		} catch {
			if (this.active(id)) {
				this.remote = { kind: 'unknown' };
				this.needsReview = true;
				this.notice = '当前关系未确认，请重新核对。';
			}
		} finally {
			if (this.active(id)) { this.phase = 'idle'; this.emit(); }
		}
	}
	setSummary(value: string): void {
		if (!this.ready() || this.phase !== 'idle' || this.confirmation || this.needsReview) return;
		this.changeSummary = value;
		// Do not rerender on every keystroke: preserve the mobile input focus.
	}
	startConfirmation(action: WriteAction): boolean {
		if (!this.ready() || this.phase !== 'idle' || this.needsReview || this.confirmation || !this.remote ||
			(this.remote.kind !== 'linked' && this.remote.kind !== 'unlinked')) return false;
		const product = this.products.find(p => p.id === this.productId);
		if (!product) return false;
		const summary = action === 'publish' ? this.changeSummary.trim() : '';
		if (action === 'publish' && !summary) {
			this.notice = '发布业务版本必须填写本次说明。';
			this.emit();
			return false;
		}
		this.confirmation = { sourcePath: this.path, productId: product.id,
			productName: product.name, action, changeSummary: summary };
		this.notice = '';
		this.emit();
		return true;
	}
	cancelConfirmation(): void {
		if (this.disposed || this.phase === 'submitting') return;
		this.confirmation = null;
		this.emit();
	}
	async confirm(): Promise<void> {
		const selected = this.confirmation;
		if (!selected || !this.ready() || this.phase !== 'idle' || this.needsReview ||
			this.productId !== selected.productId ||
			!this.products.some(p => p.id === selected.productId) ||
			!this.remote || !['linked', 'unlinked'].includes(this.remote.kind)) return;
		this.confirmation = null;
		this.phase = 'submitting'; // Synchronous lock before the first await.
		this.notice = '';
		const id = ++this.epoch;
		this.emit();
		try {
			const result = await this.host.submit({
				sourcePath: selected.sourcePath, productId: selected.productId,
				action: selected.action, changeSummary: selected.changeSummary,
			});
			if (!this.active(id)) return;
			if (!this.validSource()) {
				this.needsReview = true;
				this.remote = { kind: 'unknown' };
				this.notice = '操作期间源文档已变化；请核对结果，不能直接再次提交。';
			} else if (result.kind === 'verified') {
				const verified = matchedVerifiedStatus(result, selected);
				if (!verified) {
					this.needsReview = true;
					this.remote = { kind: 'unknown' };
					this.notice = '结果未确认，请核对后再决定是否继续。';
				} else {
					this.remote = result.action === 'publish'
						? { ...verified, verifiedPublishedVersionNo: result.publishedVersionNo }
						: verified;
					this.notice = result.action === 'publish'
						? '业务版本已确认发布：第 ' + result.publishedVersionNo +
							' 版；远端记录版本 ' + verified.recordVersion + '。'
						: '当前内容已确认同步；远端记录版本 ' + verified.recordVersion + '。';
				}
			} else if (result.kind === 'acknowledged') {
				this.remote = null; // ACK does not prove a published business-history row.
				this.notice = selected.action === 'sync'
					? '同步请求已获接口确认，请查询远端内容核对。'
					: '业务版本请求已获接口确认，请查询发布历史核对。';
			} else if (result.kind === 'conflict' || result.kind === 'unknown') {
				this.needsReview = true;
				this.remote = { kind: result.kind };
				this.notice = result.kind === 'conflict'
					? '内容已有变更，请核对本地与远端内容。'
					: '结果未确认，请核对后再决定是否继续。';
			} else {
				this.notice = result.kind === 'not-sent'
					? '本次未发送，请检查本机配置。'
					: '本次请求未获接受，请核对授权和远端状态。';
			}
		} catch {
			if (this.active(id)) {
				this.needsReview = true; // The callback might have sent the body.
				this.remote = { kind: 'unknown' };
				this.notice = '结果未确认，请核对后再决定是否继续。';
			}
		} finally {
			if (this.active(id)) {
				this.phase = 'idle';
				this.emit();
			}
		}
	}
	async reviewUncertain(): Promise<void> {
		if (!this.ready() || !this.needsReview || !this.productId || !this.remote ||
			this.phase !== 'idle' || !this.host.reviewAfterUncertain) return;
		const productId = this.productId;
		const observed = this.remote;
		const id = ++this.epoch;
		this.phase = 'reading';
		this.emit();
		try {
			const answer = await this.host.reviewAfterUncertain(productId, observed);
			if (!this.active(id) || !this.validSource()) return;
			this.remote = answer.status;
			this.needsReview = !answer.cleared;
			this.notice = answer.cleared
				? '核对流程已确认可以重新选择操作；仍需再次明确确认。'
				: '核对尚未完成，不能再次提交。';
		} catch {
			if (this.active(id)) this.notice = '核对尚未完成，不能再次提交。';
		} finally {
			if (this.active(id)) { this.phase = 'idle'; this.emit(); }
		}
	}
}

function availabilityText(status: DialogAvailability): string {
	switch (status) {
		case 'key-unconfigured': return '本机尚未配置 Key，请在 Obsidian 设置 → GVKit → 宙游文档中心填写。';
		case 'url-missing': return '尚未配置宙游文档中心地址，请前往 GVKit 设置。';
		case 'unsupported': return '本机的安全凭据功能暂不可用，请查看 GVKit 设置。';
		case 'disabled': return '宙游文档中心暂未启用，请查看 GVKit 设置。';
		default: return '';
	}
}

/** Runtime Obsidian is deliberately lazy: Node strip-types tests can import the pure controller. */
export async function openZhouyouPublishDialog(
	app: App, source: PublishDocumentContext, host: ZhouyouDialogHost,
): Promise<{ close(): void } | null> {
	const path = source.file.path;
	if (!source.isCurrent()) return null;
	// Obsidian loads a CJS plugin with host-provided require('obsidian').
	// Dynamic import('obsidian') is left as ESM by esbuild external and cannot resolve here.
	// This runtime call stays inside the UI entry: Node's pure controller import never invokes it.
	const { Modal, Platform, Setting } = require('obsidian') as typeof import('obsidian');
	const { guardIosSettingsInputs } = await import('./publishSecretSettings');
	if (!source.isCurrent() || source.file.path !== path) return null;
	class PublishModal extends Modal {
		private cleanZoom: (() => void) | null = null;
		private readonly controller = new ZhouyouDialogController(source, host, () => this.render());

		onOpen(): void {
			this.setTitle('发布到宙游文档中心');
			this.modalEl.style.maxWidth = 'min(92vw, 640px)';
			this.contentEl.style.maxWidth = '100%';
			this.contentEl.style.overflowX = 'hidden';
			this.contentEl.style.overflowY = 'auto';
			this.render();
			void this.controller.loadProducts();
		}
		onClose(): void {
			this.cleanZoom?.();
			this.cleanZoom = null;
			this.controller.dispose();
			this.contentEl.empty();
		}
		private render(): void {
			this.cleanZoom?.();
			this.cleanZoom = null;
			const root = this.contentEl;
			root.empty();
			const s = this.controller.snapshot();
			const line = (label: string, value: string) => {
				const p = root.createEl('p');
				p.style.overflowWrap = 'anywhere';
				p.createEl('strong', { text: label + '：' });
				p.appendText(value);
			};
			line('源文件', s.path);
			line('目标', '宙游文档中心');
			if (!s.sourceValid) {
				root.createEl('p', { text: '源文档已变化，请关闭后从当前文档重新打开。' });
				this.installGuard();
				return;
			}
			if (s.availability !== 'ready') {
				root.createEl('p', { text: availabilityText(s.availability) });
				if (host.openSettings) new Setting(root).addButton(b =>
					b.setButtonText('打开 GVKit 设置').onClick(() => { this.close(); host.openSettings?.(); }));
				this.installGuard();
				return;
			}
			if (s.notice) root.createEl('p', { text: s.notice });
			if (s.phase === 'listing') root.createEl('p', { text: '正在查询本人获授权的产品…' });
			if (s.phase === 'submitting') root.createEl('p', { text: '请求正在处理，请勿重复提交；关闭窗口不会撤销已发出的请求。' });
			if (s.products.length === 0 && s.phase !== 'listing') {
				new Setting(root).addButton(b => b.setButtonText('重新读取授权产品')
					.setDisabled(s.phase !== 'idle' || s.needsReview)
					.onClick(() => { void this.controller.loadProducts(); }));
			}
			if (s.products.length) {
				const label = root.createEl('label', { text: '本人获授权的产品' });
				label.style.display = 'block';
				const select = root.createEl('select');
				label.htmlFor = select.id = 'gvkit-zhouyou-product-select';
				select.style.width = 'fit-content';
				select.style.maxWidth = 'min(100%, 24rem)';
				select.style.minWidth = '0';
				select.style.boxSizing = 'border-box';
				select.disabled = s.phase === 'listing' || s.phase === 'submitting' || s.needsReview ||
					!!s.confirmation;
				const empty = select.createEl('option', { text: '请选择产品' });
				empty.value = '';
				for (const p of s.products) {
					const option = select.createEl('option', { text: p.name });
					option.value = p.id;
				}
				select.value = s.productId;
				select.addEventListener('change', () => { void this.controller.chooseProduct(select.value); });
			}
			if (s.productId) {
				if (s.phase === 'reading') root.createEl('p', { text: '正在核对远端状态…' });
				else if (s.remote?.kind === 'unlinked') line('远端状态', '尚未关联当前文档');
				else if (s.remote?.kind === 'linked') {
					line('远端状态', '已关联；记录版本 ' + s.remote.recordVersion +
						'；当前版本号 ' + s.remote.currentVersionNo +
						'；文档状态 ' + (s.remote.documentStatus === 'active' ? '正常' : '已归档'));
					if (s.remote.verifiedPublishedVersionNo !== undefined)
						line('已独立核验的业务发布版本', String(s.remote.verifiedPublishedVersionNo));
				} else if (s.remote?.kind === 'conflict') line('远端状态', '内容已有变更，请核对');
				else if (s.remote?.kind === 'legacy-candidate') {
					line('关系状态', '发现旧关系候选；须由本人核对，当前尚未关联');
					line('当前 GVID', s.remote.gvid);
					line('旧候选路径', s.remote.candidatePath);
					line('旧来源', s.remote.sourceId);
					line('产品', s.remote.productId);
					line('旧文档', s.remote.documentId);
					line('旧记录版本', String(s.remote.recordVersion));
					line('远端当前版本号', String(s.remote.currentVersionNo));
					line('本地标题', s.remote.localTitle);
					line('远端标题', s.remote.remoteTitle);
				}
				else if (s.remote?.kind === 'unknown') line('远端状态', '结果未确认，请核对');
				else if (s.phase === 'idle') line('远端状态', '尚未查询到可确认的状态');
				if (s.remote && ('localContent' in s.remote || 'remoteContent' in s.remote)) {
					const details = root.createEl('details');
					details.createEl('summary', { text: '展开只读内容核对' });
					for (const [label, text] of [
						['本地内容（只读）', s.remote.localContent],
						['远端内容（只读）', s.remote.remoteContent],
					] as const) {
						if (text === undefined) continue;
						details.createEl('p', { text: label });
						const pre = details.createEl('pre', { text });
						pre.style.whiteSpace = 'pre-wrap';
						pre.style.overflowWrap = 'anywhere';
						pre.style.maxWidth = '100%';
						pre.style.maxHeight = '16rem';
						pre.style.overflowY = 'auto';
					}
				}
				if (s.phase === 'idle' && !s.confirmation) {
					new Setting(root).addButton(b => b.setButtonText('查询当前状态')
						.onClick(() => { void this.controller.refreshStatus(); }));
				}
				if (s.phase === 'idle' && s.remote?.kind === 'legacy-candidate') {
					root.createEl('p', { text: '内容相同或不同都不能自动证明归属。请并列核对正文后明确选择。' });
					if (host.confirmLegacy && host.readAsNewDocument) new Setting(root)
						.addButton(b => b.setButtonText('确为同一历史文档').setCta()
							.onClick(() => { void this.controller.chooseLegacy(true); }))
						.addButton(b => b.setButtonText('这是新文档')
							.onClick(() => { void this.controller.chooseLegacy(false); }));
				}
				if (s.needsReview) {
					if (host.reviewAfterUncertain) new Setting(root).addButton(b =>
						b.setButtonText('提交人工核对结果').setDisabled(s.phase !== 'idle')
							.onClick(() => { void this.controller.reviewUncertain(); }));
				} else if (s.phase === 'idle' && s.remote &&
					(s.remote.kind === 'linked' || s.remote.kind === 'unlinked') && !s.confirmation) {
					const description = root.createEl('div');
					description.createEl('p', { text: '同步保存仅更新当前内容；发布业务版本是独立动作，须填写说明。' });
					const label = description.createEl('label', { text: '本次业务版本说明' });
					label.style.display = 'block';
					const textarea = description.createEl('textarea');
					label.htmlFor = textarea.id = 'gvkit-zhouyou-summary';
					textarea.value = s.changeSummary;
					textarea.rows = 3;
					textarea.style.boxSizing = 'border-box';
					textarea.style.width = 'min(100%, 30rem)';
					textarea.style.maxWidth = '100%';
					textarea.addEventListener('input', () => this.controller.setSummary(textarea.value));
					new Setting(root).addButton(b => b.setButtonText('同步保存当前内容')
						.onClick(() => { this.controller.startConfirmation('sync'); }))
						.addButton(b => b.setButtonText('发布业务版本').setCta()
							.onClick(() => { this.controller.startConfirmation('publish'); }));
				}
			}
			if (s.confirmation) {
				const c = s.confirmation;
				root.createEl('h3', { text: '请确认本次操作' });
				line('源文件', c.sourcePath);
				line('目标', '宙游文档中心');
				line('产品', c.productName);
				line('动作', c.action === 'sync' ? '同步保存当前内容（不发布业务版本）' : '发布业务版本');
				if (c.action === 'publish') line('本次说明', c.changeSummary);
				root.createEl('p', { text: '只有点击下方确认按钮，才会交由后续流程发送本篇文档。' });
				new Setting(root).addButton(b => b.setButtonText('返回修改')
					.onClick(() => this.controller.cancelConfirmation()))
					.addButton(b => b.setButtonText('确认执行当前操作').setCta()
						.onClick(() => { void this.controller.confirm(); }));
			}
			this.installGuard();
		}
		private installGuard(): void {
			// Only this dialog's controls: prevent double-tap zoom while preserving scrolling/pinch.
			this.contentEl.querySelectorAll<HTMLElement>(
				'button, select, textarea, a, [role="button"]').forEach(el => { el.style.touchAction = 'manipulation'; });
			this.cleanZoom = guardIosSettingsInputs(this.contentEl, Platform.isIosApp);
		}
	}
	const modal = new PublishModal(app);
	modal.open();
	return { close: () => modal.close() };
}
