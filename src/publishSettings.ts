/** GVKit non-secret preferences. The same queue is reusable for future bindings. */
export const ZHOUYOU_SYNC_PATH = '/api/producer-documents/obsidian-sync';
export const DEFAULT_ZHOUYOU_URL = '';
export const DEFAULT_ZHOUYOU_SECRET_REF = 'gvkit-zhouyou-document-center';

export function checkZhouyouUrl(input: string): { ok: true; value: string } | { ok: false; message: string } {
	const value = input.trim();
	if (!value) return { ok: true, value: '' };
	if (!/^https?:\/\/[^/?#]+\/api\/producer-documents\/obsidian-sync$/.test(value)
		|| value.includes('\\') || value.includes('@')) {
		return { ok: false, message: '请填写完整 HTTP 或 HTTPS 同步接口地址，不含凭据、参数或片段' };
	}
	try {
		const url = new URL(value);
		if (!url.hostname || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
			|| url.pathname !== ZHOUYOU_SYNC_PATH || url.hash || url.search || url.href !== value) {
			return { ok: false, message: '同步地址结构不正确' };
		}
		return { ok: true, value };
	} catch {
		return { ok: false, message: '同步地址格式不正确' };
	}
}


export interface PublishDataStore {
	loadData(): Promise<unknown>;
	saveData(data: Record<string, unknown>): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ?
		{ ...(value as Record<string, unknown>) } : {};
}

export const DEFAULT_COLLAB_SECRET_REF = 'gvkit-collab-board-device';
export interface CollabSavedBinding {
  gvid: string; path: string; docId: string; epoch: number; revision: number;
  locatorRevision: number; hash: string; pending?: { op: string; hash: string };
  pendingRevoke?: string; revoked?: boolean;
}
export interface CollabPendingFirst { gvid: string; path: string; op: string; hash: string }

export class PublishSettings {
	private data: Record<string, unknown> = {};
	private shortcut = true;
	private shortcutRevision = 0;
	private zhouyouUrl = '';
	private zhouyouUrlRevision = 0;
	private secretReference = DEFAULT_ZHOUYOU_SECRET_REF;
	private loaded = false;
	private loading: Promise<void> | null = null;
	private saveTail: Promise<void> = Promise.resolve();
	private readonly store: PublishDataStore;

	constructor(store: PublishDataStore) {
		this.store = store;
	}

	load(): Promise<void> {
		if (this.loaded) return Promise.resolve();
		if (this.loading) return this.loading;
		this.loading = this.store.loadData().then((data) => {
			this.data = record(data);
			this.shortcut = typeof this.data.publishShortcut === 'boolean' ? this.data.publishShortcut : true;
			this.zhouyouUrl = typeof this.data.zhouyouSyncUrl === 'string' ? this.data.zhouyouSyncUrl : DEFAULT_ZHOUYOU_URL;
			const ref = this.data.zhouyouSecretRef;
			this.secretReference = typeof ref === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref) ? ref : DEFAULT_ZHOUYOU_SECRET_REF;
			this.loaded = true;
		}).finally(() => { this.loading = null; });
		return this.loading;
	}

	isLoaded(): boolean { return this.loaded; }

	getAutoPublishBindings(): Record<string, import('./zhouyouAutoPublish').AutoBinding> {
		return JSON.parse(JSON.stringify(this.data.zhouyouAutoBindings ?? {}));
	}

	getZhouyouUrl(): string { return this.zhouyouUrl; }

	getZhouyouSecretReference(): string { return this.secretReference; }

	/** A validated, detached, non-secret view. No caller may mutate live queued state. */
	getPublishBindingsSnapshot() {
		this.requireLoaded();
		const value = this.data.publishBindings;
		return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown;
	}

	setZhouyouUrl(input: string): Promise<void> {
		this.requireLoaded();
		const checked = checkZhouyouUrl(input);
		if (!checked.ok) return Promise.reject(new Error(checked.message));
		const value = checked.value;
		if (value === this.zhouyouUrl) return Promise.resolve();
		const revision = ++this.zhouyouUrlRevision;
		this.zhouyouUrl = value;
		return this.updateNonSecret(data => {
			data.zhouyouSyncUrl = value;
			if (typeof data.zhouyouSecretRef !== 'string') data.zhouyouSecretRef = this.secretReference;
		}).catch(() => {
			if (this.zhouyouUrlRevision === revision) {
				this.zhouyouUrl = typeof this.data.zhouyouSyncUrl === 'string' ? this.data.zhouyouSyncUrl : '';
			}
			throw new Error('同步地址未能保存，请重新尝试');
		});
	}

    getCollabSecretRef(): string {
        return typeof this.data.collabSecretRef === 'string' && /^[a-z0-9-]{1,120}$/.test(this.data.collabSecretRef) ?
            this.data.collabSecretRef : DEFAULT_COLLAB_SECRET_REF;
    }
    async setCollabSecretRef(ref: string): Promise<void> {
        if (!/^[a-z0-9-]{1,120}$/.test(ref)) throw Error('无效机密引用名称');
        await this.updateNonSecret(d => { d.collabSecretRef = ref; });
    }
    getCollabBindings(): CollabSavedBinding[] {
        const rows = this.data.collabBindings;
        return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) as CollabSavedBinding[] : [];
    }
    hasCollabPath(path: string): boolean { return this.getCollabBindings().some(b => b.path === path); }
    getCollabBinding(gvid: string): CollabSavedBinding | null {
        return this.getCollabBindings().find(b => b.gvid === gvid) ?? null;
    }
    getCollabPendingFirst(): CollabPendingFirst | null {
        const p = this.data.collabPendingFirst;
        return p && typeof p === 'object' ? JSON.parse(JSON.stringify(p)) as CollabPendingFirst : null;
    }
    async saveCollabPendingFirst(pending: CollabPendingFirst): Promise<void> {
        await this.updateNonSecret(d => { d.collabPendingFirst = pending; });
    }
    async saveCollabBinding(binding: CollabSavedBinding, clearFirst = false): Promise<void> {
        await this.updateNonSecret(d => {
            const rows = Array.isArray(d.collabBindings) ? d.collabBindings as CollabSavedBinding[] : [];
            d.collabBindings = [...rows.filter(row => row.gvid !== binding.gvid), binding];
            if (clearFirst) delete d.collabPendingFirst;
        });
    }

	getPublishShortcut(): boolean {
		return this.shortcut;
	}

	setPublishShortcut(value: boolean): Promise<void> {
		this.requireLoaded();
		const revision = ++this.shortcutRevision;
		this.shortcut = value;
		return this.updateNonSecret((data) => { data.publishShortcut = value; }).catch((error: unknown) => {
			// A delayed error from an older choice must never revert a newer choice,
			// even if the two choices happen to have the same boolean value.
			if (this.shortcutRevision === revision) {
				// updateNonSecret only commits data after saveData confirms completion.
				// Earlier queued writes may have succeeded since this choice was made.
				this.shortcut = typeof this.data.publishShortcut === 'boolean' ?
					this.data.publishShortcut : true;
			}
			throw error;
		});
	}

	/** All writers of ordinary plugin data must share this ordered persistence queue. */
	updateNonSecret(change: (data: Record<string, unknown>) => void): Promise<void> {
		this.requireLoaded();
		const work = this.saveTail.then(async () => {
			const next = { ...this.data };
			change(next);
			await this.store.saveData(next);
			this.data = next;
		});
		// A rejected save does not poison subsequent attempts.
		this.saveTail = work.then(() => undefined, () => undefined);
		return work;
	}

	private requireLoaded(): void {
		if (!this.loaded) throw new Error('GVKit preferences not initialized');
	}
}
