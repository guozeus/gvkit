/** Isolated device-only secret selection. Never serialize actual secret values. */
export const LOCAL_SECRET_SELECTION = 'gvkit-zhouyou-local-secret-v1';

export interface SecretPort {
	getSecret(ref: string): string | null;
	listSecrets(): string[];
	setSecret(ref: string, secret: string): void;
}
export interface LocalPort {
	secretStorage?: Partial<SecretPort> | null;
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown | null): void;
}
export type SecretStatus = 'unsupported' | 'unconfigured' | 'reconfigure' | 'configured' | 'stopped';

export function validSecretReference(ref: unknown): ref is string {
	return typeof ref === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref) && ref.length <= 120;
}
type Choice = { enabled: boolean; ref: string };

export class DeviceZhouyouSecret {
	private readonly port: LocalPort;
	private readonly sharedReference: () => string;
	/** Held only for this plugin instance, never serialized, returned to UI, or logged. */
	private previousRuntimeValue: string | null | undefined;
	private previousRuntimeRef = '';
	private revision = 0;

	constructor(port: LocalPort, sharedReference: () => string) {
		this.port = port;
		this.sharedReference = sharedReference;
	}

	supported(): boolean {
		const s = this.port.secretStorage;
		return !!s && typeof s.getSecret === 'function' && typeof s.listSecrets === 'function'
			&& typeof s.setSecret === 'function' && typeof this.port.loadLocalStorage === 'function'
			&& typeof this.port.saveLocalStorage === 'function';
	}

	private choice(): Choice | null | undefined {
		try {
			const data = this.port.loadLocalStorage(LOCAL_SECRET_SELECTION);
			if (data === null || data === undefined) return null;
			if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
			const row = data as Record<string, unknown>;
			if (typeof row.enabled !== 'boolean' || !validSecretReference(row.ref)) return undefined;
			return { enabled: row.enabled, ref: row.ref };
		} catch {
			return undefined; // An unreadable opt-out must not silently reactivate a key.
		}
	}

	reference(): string {
		const choice = this.choice();
		if (choice && validSecretReference(choice.ref)) return choice.ref;
		const shared = this.sharedReference();
		return validSecretReference(shared) ? shared : 'gvkit-zhouyou-document-center';
	}

	status(): SecretStatus {
		if (!this.supported()) return 'unsupported';
		const choice = this.choice();
		if (choice === undefined || choice?.enabled === false) return 'stopped';
		try {
			// Only check existence. Never pass a value to UI, settings, log or diagnostics.
			if (Boolean(this.port.secretStorage?.getSecret?.(this.reference()))) return 'configured';
			return choice ? 'reconfigure' : 'unconfigured';
		} catch {
			return 'reconfigure';
		}
	}

	/** This value is only consumed inside ZhouyouClient's runtime credential callback.
	 * An unreadable/stopped/unsupported choice never falls back to ordinary plugin data. */
	runtimeCredential(): string | null {
		if (!this.supported()) return null;
		const choice = this.choice();
		if (choice === undefined || choice?.enabled === false) return null;
		try {
			const value = this.port.secretStorage?.getSecret?.(this.reference());
			return typeof value === 'string' && value.length > 0 ? value : null;
		} catch { return null; }
	}

	/** Opaque counter: detects in-place replacement at the SAME reference, too.
	 * Only the counter leaves this device-only object; never the value or a hash. */
	runtimeRevision(): number {
		const ref = this.reference();
		const value = this.runtimeCredential();
		if (this.previousRuntimeValue === undefined || this.previousRuntimeRef !== ref
			|| this.previousRuntimeValue !== value) {
			this.revision++;
			this.previousRuntimeRef = ref;
			this.previousRuntimeValue = value;
		}
		return this.revision;
	}

	/** Clear the ephemeral comparison material on plugin unload. */
	disposeRuntime(): void {
		this.previousRuntimeValue = undefined;
		this.previousRuntimeRef = '';
	}

	select(ref: string): void {
		if (!this.supported()) throw new Error('secure local storage unavailable');
		if (!validSecretReference(ref)) throw new Error('invalid secret reference');
		this.port.saveLocalStorage(LOCAL_SECRET_SELECTION, { enabled: true, ref });
	}

	stop(): void {
		if (!this.supported()) throw new Error('secure local storage unavailable');
		this.port.saveLocalStorage(LOCAL_SECRET_SELECTION, { enabled: false, ref: this.reference() });
		// Obsidian publicly exposes no deleteSecret: stop is not physical erasure.
	}

	enable(): void {
		this.select(this.reference());
	}
}

/** Temporary viewport protection, only for editable controls owned by this iOS section. */
export function guardIosSettingsInputs(root: HTMLElement, ios: boolean): () => void {
	if (!ios || typeof document === 'undefined') return () => undefined;
	let alive = true;
	let meta: HTMLMetaElement | null = null;
	let oldValue: string | null = null;
	let appliedValue: string | null = null;
	let created = false;
	let pendingEnd: ReturnType<typeof setTimeout> | null = null;
	let interaction = 0;
	const editable = (target: EventTarget | null): boolean => target instanceof HTMLElement
		&& root.contains(target)
		&& target.matches('input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select, [contenteditable="true"]');
	const cancelPendingEnd = () => {
		interaction++;
		if (pendingEnd !== null) {
			clearTimeout(pendingEnd);
			pendingEnd = null;
		}
	};
	const restore = () => {
		if (!meta) return;
		if (meta.getAttribute('content') === appliedValue) {
			if (created) meta.remove();
			else if (oldValue === null) meta.removeAttribute('content');
			else meta.setAttribute('content', oldValue);
		}
		meta = null; oldValue = null; appliedValue = null; created = false;
	};
	const protect = (event: Event) => {
		if (!alive || !editable(event.target)) return;
		// Even if protected already, a new gesture/focus invalidates the previous end check.
		cancelPendingEnd();
		if (meta) return;
		meta = document.querySelector('meta[name="viewport"]');
		if (!meta) {
			meta = document.createElement('meta');
			meta.setAttribute('name', 'viewport');
			document.head.appendChild(meta);
			created = true;
		}
		oldValue = meta.getAttribute('content');
		const items = (oldValue ?? '').split(',').map(s => s.trim()).filter(s => s && !/^maximum-scale\s*=/.test(s));
		items.push('maximum-scale=1');
		appliedValue = items.join(', ');
		meta.setAttribute('content', appliedValue);
	};
	const cancel = (event: Event) => {
		if (!alive || !meta || !editable(event.target)) return;
		cancelPendingEnd();
		// A cancelled gesture cannot focus a field; retain protection if already editing.
		if (!editable(document.activeElement)) restore();
	};
	const end = (event: Event) => {
		if (!alive || !meta || !editable(event.target)) return;
		cancelPendingEnd();
		if (editable(document.activeElement)) return;
		const thisInteraction = interaction;
		// Allow the native click/focus sequence to follow touchend/pointerup before restoring.
		pendingEnd = setTimeout(() => {
			pendingEnd = null;
			if (alive && interaction === thisInteraction && !editable(document.activeElement)) restore();
		}, 350);
	};
	const blur = () => {
		const thisInteraction = interaction;
		queueMicrotask(() => {
			// Moving from a field to an owned button still ends the editing session.
			// A newer editable interaction must never be undone by an older blur.
			if (alive && interaction === thisInteraction && !editable(document.activeElement)) {
				cancelPendingEnd();
				restore();
			}
		});
	};
	root.addEventListener('pointerdown', protect);
	root.addEventListener('touchstart', protect, { passive: true });
	root.addEventListener('focusin', protect);
	root.addEventListener('pointercancel', cancel);
	root.addEventListener('touchcancel', cancel);
	root.addEventListener('pointerup', end);
	root.addEventListener('touchend', end);
	root.addEventListener('focusout', blur);
	return () => {
		alive = false;
		cancelPendingEnd();
		root.removeEventListener('pointerdown', protect);
		root.removeEventListener('touchstart', protect);
		root.removeEventListener('focusin', protect);
		root.removeEventListener('pointercancel', cancel);
		root.removeEventListener('touchcancel', cancel);
		root.removeEventListener('pointerup', end);
		root.removeEventListener('touchend', end);
		root.removeEventListener('focusout', blur);
		restore();
	};
}
