import type { PublishDocumentContext } from './documentActions';
import type { DialogAvailability, DialogRemoteStatus, DialogSubmitIntent, DialogSubmitResult, ZhouyouDialogHost } from './publishDialog';
import { PublishSettings } from './publishSettings';
import {
	BindingBlocked, readPublishBindings, inspectBinding, installVerifiedBinding, confirmLegacyBinding, legacyCandidate,
	stagePreparedWrite, releaseDefinitelyNotSentWrite, recordAckCandidate,
	verifyReadCurrent, completeAcknowledgedWrite, reconcileReadOnly,
	type NoteEvidence, type LegacyObservation, type VerifiedRemote, type PublishBinding,
	type DefinitelyNotSentEvidence, type HashVerifiedCurrent,
} from './publishBindings';
import {
	ZhouyouClient, prepareZhouyouWrite, newZhouyouOperationId, sha256Utf8,
	validateZhouyouEndpoint, type ZhouyouProduct, type ZhouyouResult, type ZhouyouCurrent, type PreparedWrite,
} from './zhouyouClient';

/** Runtime evidence must come from the currently selected native file, not the menu title.
 * Legacy inventory is 'unknown' until a device-side NON-SECRET inspection can prove it. */
export interface WorkflowObservation {
	note: NoteEvidence;
	legacy: LegacyObservation;
	content: string;
	title: string;
	/** Synchronous native file revision used by the save queue's final check. */
	sourceRevision?: string;
	/** Repeat this product's exact path check at every asynchronous boundary. */
	selectedProductId?: string;
}
export interface WorkflowPorts {
	/** Production cannot provide ready until the real backend and redirect chain are attested. */
	availability(): DialogAvailability;
	/** Opaque LOCAL identity/selection generation only; never return the Key. */
	credentialIdentity(): string;
	observe(context: PublishDocumentContext, productId?: string): Promise<WorkflowObservation>;
	currentSourceRevision?(context: PublishDocumentContext): string;
	client(endpoint: string): ZhouyouClient;
	/** Only the verified deployed backend contract can permit a real write. */
	writePermitted?(): boolean;
	/** A read-only, independent, authorized source/product mapping or proven absence.
	 * NEVER fabricate a 404 absence from a generic rejection. */
	resolveRemote?(observation: WorkflowObservation, productId: string): Promise<VerifiedRemote | null>;
	contracts?(): { stableSourceVerified: boolean; atomicFirstCreateVerified: boolean; multiProductVerified: boolean } | null;
}
function same(a: WorkflowObservation, b: WorkflowObservation): boolean {
	return a.note.gvid === b.note.gvid && a.note.path === b.note.path &&
		a.note.identity === b.note.identity &&
		a.note.pathProof === b.note.pathProof && a.sourceRevision === b.sourceRevision &&
		a.title === b.title && a.content === b.content &&
		JSON.stringify(a.legacy) === JSON.stringify(b.legacy) &&
		a.selectedProductId === b.selectedProductId;
}
/** Native callbacks must be keyed by the SAME TFile in main's WeakMap. */
export interface NativeRenameTrail {
	readonly currentPath: string;
	readonly earlierPaths: readonly string[];
}
export function recordNativeRename(
	trail: NativeRenameTrail | undefined, previousPath: string, currentPath: string,
): NativeRenameTrail {
	if (!previousPath || !currentPath || previousPath === currentPath)
		return { currentPath, earlierPaths: [] };
	const earlier = trail?.currentPath === previousPath ? trail.earlierPaths : [];
	return { currentPath, earlierPaths: [...new Set([...earlier, previousPath])].filter(p => p !== currentPath) };
}
export function matchesNativeRename(
	trail: NativeRenameTrail | undefined, currentPath: string, boundOldPath: string,
): boolean {
	return !!trail && trail.currentPath === currentPath && !!boundOldPath &&
		boundOldPath !== currentPath && trail.earlierPaths.includes(boundOldPath);
}
/** Resolve one source using the server's explicit missing-document response only. */
export async function resolveExistingRemoteByRead(
	observation: WorkflowObservation, productId: string, client: ZhouyouClient,
): Promise<VerifiedRemote | null> {
	if (observation.legacy.inventory !== 'checked' || !observation.legacy.fields ||
		typeof observation.legacy.fields !== 'object' || Array.isArray(observation.legacy.fields))
		return null;
	const fields = observation.legacy.fields as Record<string, unknown>;
	const oldKeys = [
		'zhou_source_id', 'zhou_document_id', 'zhou_product_id', 'zhou_record_version',
		'zhou_operation_id', 'zhou_operation_hash', 'zhou_operation_record_version', 'zhou_operation_document_id',
	];
	const hasOld = oldKeys.some(key => Object.prototype.hasOwnProperty.call(fields, key));
	if (hasOld && (fields.zhou_product_id !== productId ||
		typeof fields.zhou_source_id !== 'string' || !fields.zhou_source_id ||
		typeof fields.zhou_document_id !== 'string' || !fields.zhou_document_id ||
		typeof fields.zhou_record_version !== 'number' ||
		!Number.isSafeInteger(fields.zhou_record_version) || fields.zhou_record_version < 1 ||
		oldKeys.slice(4).some(key => Object.prototype.hasOwnProperty.call(fields, key))))
		return null;
	const sourceId = hasOld ? fields.zhou_source_id as string : observation.note.gvid;
	if (typeof sourceId !== 'string' || !sourceId) return null;
	const documentId = hasOld ? fields.zhou_document_id as string : null;
	const response = await client.readCurrent({ sourceId, productId, documentId });
	if (!hasOld && response.kind === 'not-found') return {
		evidence: 'server-verified-absent', sourceId, productId,
		documentId: null, recordVersion: null, contentHash: null, currentVersionNo: null,
	};
	if (response.kind !== 'acknowledged') return null;
	const current = await verifyReadCurrent(response.data);
	if (hasOld && (current.documentId !== documentId || current.recordVersion < (fields.zhou_record_version as number)))
		return null;
	return {
		evidence: 'server-verified-existing', sourceId: current.sourceId,
		productId: current.productId, documentId: current.documentId,
		recordVersion: current.recordVersion, contentHash: current.contentHash,
		currentVersionNo: current.currentVersionNo,
	};
}
function linked(current: ZhouyouCurrent): DialogRemoteStatus {
	return { kind: 'linked', documentId: current.documentId, recordVersion: current.recordVersion,
		currentVersionNo: current.currentVersionNo, documentStatus: current.documentStatus };
}
interface LegacyReview {
	id: number;
	productId: string;
	stamp: string;
	observation: WorkflowObservation;
	candidateLegacy: LegacyObservation;
	sourceSnapshot: string;
	candidateSnapshot: string;
	bindings: string;
	current: HashVerifiedCurrent;
}
function remoteSnapshot(current: ZhouyouCurrent): string {
	return JSON.stringify([current.sourceId, current.productId, current.documentId,
		current.recordVersion, current.currentVersionNo, current.documentStatus,
		current.contentHash, current.title, current.content]);
}
function sourceSnapshot(observation: WorkflowObservation): string {
	return JSON.stringify([observation.note, observation.title, observation.content,
		observation.legacy, observation.sourceRevision, observation.selectedProductId]);
}
/** Single-window lifecycle gate; not a substitute for server-side source/product CAS. */
export class PublishWorkflow {
	private active = true;
	private readonly writing = new Set<object>();
	private readonly reviews = new WeakMap<object, LegacyReview>();
	private readonly newChoices = new WeakMap<object, { productId: string; stamp: string;
		gvid: unknown; path: string; legacy: string; revision: string }>();
	private nextReviewId = 0;
	private readonly settings: PublishSettings;
	private readonly ports: WorkflowPorts;
	constructor(settings: PublishSettings, ports: WorkflowPorts) {
		this.settings = settings;
		this.ports = ports;
	}
	stop(): void { this.active = false; }
	availability(): DialogAvailability {
		if (!this.active || !this.settings.isLoaded()) return 'disabled';
		if (!this.settings.getZhouyouUrl()) return 'url-missing';
		return this.ports.availability();
	}
	private ready(): boolean { return this.availability() === 'ready'; }
	private configStamp(): string {
		// The credential itself is NEVER returned to this workflow or persisted.
		return JSON.stringify([this.settings.getZhouyouUrl(),
			this.settings.getZhouyouSecretReference(), this.ports.credentialIdentity()]);
	}
	private client(): ZhouyouClient {
		return this.ports.client(validateZhouyouEndpoint(this.settings.getZhouyouUrl()));
	}
	private async observe(context: PublishDocumentContext, productId?: string): Promise<WorkflowObservation> {
		if (!this.active || !context.isCurrent()) throw new Error('source-not-current');
		const original = context.file.path;
		const result = await this.ports.observe(context, productId);
		if (!this.active || !context.isCurrent() || context.file.path !== original ||
			result.note.path !== original || !result.title.trim() ||
			typeof result.content !== 'string') throw new Error('source-changed');
		return { ...result, selectedProductId: productId };
	}
	private async unchanged(context: PublishDocumentContext, prior: WorkflowObservation, stamp: string): Promise<boolean> {
		if (!this.ready() || this.configStamp() !== stamp) return false;
		try { return same(prior, await this.observe(context, prior.selectedProductId)) && this.configStamp() === stamp; }
		catch { return false; }
	}
	private sourceRevisionMatches(context: PublishDocumentContext, observation: WorkflowObservation): boolean {
		return !!observation.sourceRevision && !!this.ports.currentSourceRevision &&
			context.isCurrent() && context.file.path === observation.note.path &&
			this.ports.currentSourceRevision(context) === observation.sourceRevision;
	}
	private snapshotBindings(): string {
		return JSON.stringify(this.settings.getPublishBindingsSnapshot() ?? null);
	}
	private usesNewDocument(context: PublishDocumentContext, observation: WorkflowObservation, productId: string): boolean {
		const choice = this.newChoices.get(context.file);
		return !!choice && choice.productId === productId && choice.stamp === this.configStamp()
			&& choice.gvid === observation.note.gvid && choice.path === observation.note.path
			&& choice.legacy === JSON.stringify(observation.legacy)
			&& choice.revision === observation.sourceRevision
			&& this.sourceRevisionMatches(context, observation);
	}
	listProducts(): Promise<ZhouyouResult<ZhouyouProduct[]>> {
		if (!this.ready()) return Promise.resolve({ kind: 'not-sent', reason: 'invalid-request' });
		return this.client().listProducts();
	}
	private async binding(context: PublishDocumentContext, productId: string): Promise<{
		observation: WorkflowObservation; binding: PublishBinding | null;
		candidate: LegacyObservation | null;
	}> {
		const observation = await this.observe(context, productId);
		const old = legacyCandidate(observation.legacy, productId);
		const skipOld = old && this.usesNewDocument(context, observation, productId);
		const effective = skipOld ? { ...observation,
			legacy: { inventory: 'checked' as const, fields: {}, origin: 'none' as const } } : observation;
		const snapshot = this.settings.getPublishBindingsSnapshot();
		let binding: PublishBinding | null;
		try {
			binding = inspectBinding(snapshot, observation.note, productId, effective.legacy);
		} catch (error) {
			// Valid legacy UUIDv4 with no matching GVKit row needs its original remote
			// record read BEFORE the core can compare the two identities.
			if (!(error instanceof BindingBlocked) ||
				(error.reason !== 'legacy-conflict' && error.reason !== 'ownership-unconfirmed')) throw error;
			const rows = readPublishBindings(snapshot);
			const prior = rows.find(row => row.gvid === observation.note.gvid && row.productId === productId);
			if (prior?.pending) throw error;
			if (prior && old && (prior.sourceId !== old.sourceId ||
				prior.documentId !== old.documentId)) {
				// A previously chosen independent GVID row may coexist with a stale
				// old path claim; ask again after restart, never transfer its IDs.
				if (prior.sourceId === observation.note.gvid && old.sourceId !== prior.sourceId)
					return { observation, binding: null, candidate: observation.legacy };
				throw error;
			}
			if (prior && error.reason === 'ownership-unconfirmed' && !old &&
				prior.documentId && prior.recordVersion) {
				return { observation, binding: null, candidate: {
					inventory: 'checked', origin: 'saved-unconfirmed', candidatePath: prior.pathHint,
					fields: { zhou_source_id: prior.sourceId, zhou_product_id: prior.productId,
						zhou_document_id: prior.documentId, zhou_record_version: prior.recordVersion },
				} };
			}
			if (!old) throw error;
			if (old.sourceId !== observation.note.gvid && !skipOld)
				return { observation, binding: null, candidate: observation.legacy };
			binding = null;
		}
		if (!binding && this.ports.resolveRemote && this.ports.contracts) {
			const contracts = this.ports.contracts();
			if (!contracts) return { observation, binding: null, candidate: null };
			const stamp = this.configStamp();
			const remote = await this.ports.resolveRemote(effective, productId);
			if (!remote || !await this.unchanged(context, observation, stamp)) throw new Error('unverified-remote');
			const bindings = JSON.stringify(snapshot ?? null);
			await this.settings.updateNonSecret(data => {
				if (!this.active || !context.isCurrent() || context.file.path !== observation.note.path ||
					(skipOld && !this.sourceRevisionMatches(context, observation)) ||
					this.configStamp() !== stamp || JSON.stringify(data.publishBindings ?? null) !== bindings)
					throw new Error('source-or-authorization-changed');
				data.publishBindings = installVerifiedBinding(data.publishBindings, observation.note,
					productId, effective.legacy, remote, contracts);
			});
			binding = inspectBinding(this.settings.getPublishBindingsSnapshot(),
				observation.note, productId, effective.legacy);
		}
		return { observation, binding, candidate: null };
	}
	async readStatus(context: PublishDocumentContext, productId: string): Promise<DialogRemoteStatus> {
		if (!this.ready()) return { kind: 'unknown' };
		try {
			const stamp = this.configStamp();
			const { observation, binding, candidate } = await this.binding(context, productId);
			if (candidate) return await this.readLegacyReview(context, observation, candidate, productId, stamp);
			if (!binding || binding.pending || !await this.unchanged(context, observation, stamp))
				return { kind: 'unknown' };
			if (binding.documentId === null) return { kind: 'unlinked' };
			const response = await this.client().readCurrent({
				sourceId: binding.sourceId, productId, documentId: binding.documentId });
			if (response.kind !== 'acknowledged' || !await this.unchanged(context, observation, stamp))
				return { kind: 'unknown' };
			const current = await verifyReadCurrent(response.data);
			if (current.documentId !== binding.documentId || current.recordVersion !== binding.recordVersion ||
				current.contentHash !== binding.contentHash || current.currentVersionNo !== binding.currentVersionNo)
				return { kind: 'conflict', localContent: observation.content, remoteContent: current.content };
			return linked(current);
		} catch { return { kind: 'unknown' }; }
	}
	private async readLegacyReview(context: PublishDocumentContext,
		observation: WorkflowObservation, candidateLegacy: LegacyObservation,
		productId: string, stamp: string): Promise<DialogRemoteStatus> {
		const old = legacyCandidate(candidateLegacy, productId);
		if (!old?.documentId || !old.recordVersion || !this.sourceRevisionMatches(context, observation))
			return { kind: 'unknown' };
		const before = this.snapshotBindings();
		const products = await this.client().listProducts();
		if (products.kind !== 'acknowledged' || !products.data.some(p => p.id === productId))
			return { kind: 'unknown' };
		const response = await this.client().readCurrent({ sourceId: old.sourceId,
			productId, documentId: old.documentId });
		if (response.kind !== 'acknowledged') return { kind: 'unknown' };
		const current = await verifyReadCurrent(response.data);
		if (current.sourceId !== old.sourceId || current.productId !== productId ||
			current.documentId !== old.documentId || current.recordVersion < old.recordVersion ||
			!await this.unchanged(context, observation, stamp) ||
			!this.sourceRevisionMatches(context, observation) || this.snapshotBindings() !== before)
			return { kind: 'unknown' };
		const id = ++this.nextReviewId;
		this.reviews.set(context.file, { id, productId, stamp, observation,
			candidateLegacy, sourceSnapshot: sourceSnapshot(observation),
			candidateSnapshot: JSON.stringify(candidateLegacy), bindings: before, current });
		return { kind: 'legacy-candidate', reviewId: id, sourcePath: observation.note.path,
			gvid: observation.note.gvid as string,
			candidatePath: candidateLegacy.candidatePath ?? observation.note.path,
			sourceId: old.sourceId, productId, documentId: old.documentId,
			recordVersion: current.recordVersion, currentVersionNo: current.currentVersionNo,
			localTitle: observation.title, remoteTitle: current.title,
			localContent: observation.content, remoteContent: current.content };
	}
	private async freshReview(context: PublishDocumentContext, productId: string,
		reviewId: number, readOld = true): Promise<LegacyReview | null> {
		const review = this.reviews.get(context.file);
		if (!review || review.id !== reviewId || review.productId !== productId ||
			!this.ready() || this.configStamp() !== review.stamp ||
			sourceSnapshot(review.observation) !== review.sourceSnapshot ||
			JSON.stringify(review.candidateLegacy) !== review.candidateSnapshot ||
			!this.sourceRevisionMatches(context, review.observation) ||
			this.snapshotBindings() !== review.bindings ||
			!await this.unchanged(context, review.observation, review.stamp)) return null;
		const products = await this.client().listProducts();
		if (products.kind !== 'acknowledged' || !products.data.some(p => p.id === productId)) return null;
		if (!readOld) return await this.unchanged(context, review.observation, review.stamp) &&
			this.sourceRevisionMatches(context, review.observation) &&
			this.snapshotBindings() === review.bindings ? review : null;
		const old = legacyCandidate(review.candidateLegacy, productId);
		if (!old?.documentId || !old.recordVersion) return null;
		const response = await this.client().readCurrent({ sourceId: old.sourceId,
			productId, documentId: old.documentId });
		if (response.kind !== 'acknowledged') return null;
		const current = await verifyReadCurrent(response.data);
		if (current.sourceId !== old.sourceId || current.productId !== productId ||
			current.documentId !== old.documentId || current.recordVersion < old.recordVersion ||
			remoteSnapshot(current) !== remoteSnapshot(review.current) ||
			!await this.unchanged(context, review.observation, review.stamp) ||
			!this.sourceRevisionMatches(context, review.observation) ||
			this.snapshotBindings() !== review.bindings ||
			sourceSnapshot(review.observation) !== review.sourceSnapshot ||
			JSON.stringify(review.candidateLegacy) !== review.candidateSnapshot) return null;
		return { ...review, current };
	}
	async confirmLegacy(context: PublishDocumentContext, productId: string,
		reviewId: number): Promise<DialogRemoteStatus> {
		if (this.writing.has(context.file)) return { kind: 'unknown' };
		this.writing.add(context.file);
		try {
			const review = await this.freshReview(context, productId, reviewId);
			if (!review || !this.ports.contracts) return { kind: 'unknown' };
			const contracts = this.ports.contracts();
			if (!contracts) return { kind: 'unknown' };
			const current = review.current;
			const remote: VerifiedRemote = { evidence: 'server-verified-existing',
				sourceId: current.sourceId, productId: current.productId,
				documentId: current.documentId, recordVersion: current.recordVersion,
				contentHash: current.contentHash, currentVersionNo: current.currentVersionNo };
			await this.settings.updateNonSecret(data => {
				if (!this.active || this.configStamp() !== review.stamp ||
					!this.sourceRevisionMatches(context, review.observation) ||
					context.view.editor.getValue() !== review.observation.content ||
					sourceSnapshot(review.observation) !== review.sourceSnapshot ||
					JSON.stringify(review.candidateLegacy) !== review.candidateSnapshot ||
					JSON.stringify(data.publishBindings ?? null) !== review.bindings ||
					this.reviews.get(context.file)?.id !== reviewId)
					throw new Error('review-changed');
				data.publishBindings = confirmLegacyBinding(data.publishBindings,
					review.observation.note, productId, review.candidateLegacy, remote, contracts);
			});
			this.reviews.delete(context.file);
			return await this.readStatus(context, productId);
		} catch { return { kind: 'unknown' }; }
		finally { this.writing.delete(context.file); }
	}
	async readAsNewDocument(context: PublishDocumentContext, productId: string,
		reviewId: number): Promise<DialogRemoteStatus> {
		try {
			const review = await this.freshReview(context, productId, reviewId, false);
			if (!review) return { kind: 'unknown' };
			const previous = readPublishBindings(this.settings.getPublishBindingsSnapshot())
				.find(row => row.gvid === review.observation.note.gvid && row.productId === productId);
			if (previous && previous.sourceId !== review.observation.note.gvid) {
				// An unconfirmed older row cannot be replaced by choosing "new".
				const response = await this.client().readCurrent({
					sourceId: review.observation.note.gvid as string, productId, documentId: null });
				if (response.kind !== 'acknowledged') return { kind: 'unknown' };
				const current = await verifyReadCurrent(response.data);
				return await this.unchanged(context, review.observation, review.stamp) &&
					this.sourceRevisionMatches(context, review.observation) &&
					this.snapshotBindings() === review.bindings
					? { kind: 'unknown', localContent: review.observation.content,
						remoteContent: current.content } : { kind: 'unknown' };
			}
			this.newChoices.set(context.file, { productId, stamp: review.stamp,
				gvid: review.observation.note.gvid, path: review.observation.note.path,
				legacy: JSON.stringify(review.observation.legacy),
				revision: review.observation.sourceRevision! });
			this.reviews.delete(context.file);
			return await this.readStatus(context, productId);
		} catch { return { kind: 'unknown' }; }
	}
	async review(context: PublishDocumentContext, productId: string): Promise<{
		cleared: boolean; status: DialogRemoteStatus;
	}> {
		if (!this.ready()) return { cleared: false, status: { kind: 'unknown' } };
		try {
			const stamp = this.configStamp();
			const { observation, binding } = await this.binding(context, productId);
			const effectiveLegacy: LegacyObservation = this.usesNewDocument(context, observation, productId)
				? { inventory: 'checked', fields: {}, origin: 'none' } : observation.legacy;
			if (!binding || !binding.documentId) return { cleared: false, status: { kind: 'unknown' } };
			const response = await this.client().readCurrent({
				sourceId: binding.sourceId, productId, documentId: binding.documentId });
			if (response.kind !== 'acknowledged') return { cleared: false, status: { kind: 'unknown' } };
			const current = await verifyReadCurrent(response.data);
			if (!await this.unchanged(context, observation, stamp)) return { cleared: false, status: { kind: 'unknown' } };
			await this.settings.updateNonSecret(data => {
				if (this.configStamp() !== stamp || !this.active || !context.isCurrent()) throw new Error('changed');
				data.publishBindings = reconcileReadOnly(data.publishBindings, observation.note, effectiveLegacy,
					productId, current, { userAccepted: true, accountUnchanged: true });
			});
			// Manual read-only reconciliation intentionally NEVER removes an unknown pending.
			const saved = inspectBinding(this.settings.getPublishBindingsSnapshot(),
				observation.note, productId, effectiveLegacy);
			return { cleared: saved?.pending === null, status: linked(current) };
		} catch { return { cleared: false, status: { kind: 'unknown' } }; }
	}
	/** Release only this exact staged operation with verified local no-send evidence. */
	private async releaseUnsent(
		observation: WorkflowObservation, prepared: PreparedWrite,
		evidence: DefinitelyNotSentEvidence, legacy = observation.legacy,
	): Promise<boolean> {
		try {
			await this.settings.updateNonSecret(data => {
				data.publishBindings = releaseDefinitelyNotSentWrite(
					data.publishBindings, observation.note, legacy, prepared, evidence);
			});
			return true;
		} catch { return false; }
	}
	private attempt(prepared: PreparedWrite) {
		return {
			operationId: prepared.operationId, action: prepared.action,
			payloadHash: prepared.payloadHash, sourceRevision: prepared.sourceRevision,
			sourceId: prepared.sourceId, productId: prepared.productId,
			documentId: prepared.documentId, recordVersion: prepared.recordVersion,
		};
	}
	async submit(context: PublishDocumentContext, intent: DialogSubmitIntent): Promise<DialogSubmitResult> {
		if (!this.ready() || this.ports.writePermitted?.() === false || !context.isCurrent() || context.file.path !== intent.sourcePath ||
			(intent.action !== 'sync' && intent.action !== 'publish') ||
			(intent.action === 'publish' && !intent.changeSummary.trim())) return { kind: 'not-sent' };
		if (this.writing.has(context.file)) return { kind: 'conflict' };
		this.writing.add(context.file); // acquire synchronously, before any await
		let staged = false;
		try {
			const stamp = this.configStamp();
			const start = await this.observe(context, intent.productId);
			const effectiveLegacy: LegacyObservation = this.usesNewDocument(context, start, intent.productId)
				? { inventory: 'checked', fields: {}, origin: 'none' } : start.legacy;
			const client = this.client();
			const products = await client.listProducts();
			if (products.kind !== 'acknowledged') return { kind: products.kind === 'not-sent' ? 'not-sent' : products.kind === 'rejected' ? 'rejected' : 'unknown' };
			if (!products.data.some(product => product.id === intent.productId) ||
				!await this.unchanged(context, start, stamp)) return { kind: 'not-sent' };
			const remote = await this.readStatus(context, intent.productId);
			if (remote.kind !== 'linked' && remote.kind !== 'unlinked') return { kind: remote.kind === 'conflict' ? 'conflict' : 'unknown' };
			const binding = inspectBinding(this.settings.getPublishBindingsSnapshot(),
				start.note, intent.productId, effectiveLegacy);
			if (!binding || binding.pending) return { kind: 'unknown' };
			if (remote.kind === 'unlinked' ? binding.documentId !== null :
				(binding.documentId !== remote.documentId || binding.recordVersion !== remote.recordVersion ||
					binding.currentVersionNo !== remote.currentVersionNo)) return { kind: 'conflict' };
			const prepared = await prepareZhouyouWrite({
				action: intent.action, sourceId: binding.sourceId, productId: intent.productId,
				documentId: binding.documentId, recordVersion: binding.recordVersion,
				title: start.title, content: start.content,
				changeSummary: intent.action === 'publish' ? intent.changeSummary.trim() : '',
				operationId: newZhouyouOperationId(),
			});
			if (!await this.unchanged(context, start, stamp)) return { kind: 'not-sent' };
			// Synchronous core conversion inside the SOLE shared save queue.
			await this.settings.updateNonSecret(data => {
				if (this.configStamp() !== stamp || !this.active || !context.isCurrent() ||
					context.file.path !== start.note.path) throw new Error('changed');
				data.publishBindings = stagePreparedWrite(data.publishBindings,
					start.note, effectiveLegacy, prepared);
			});
			staged = true;
			if (!await this.unchanged(context, start, stamp) || this.ports.writePermitted?.() === false) {
				const cleared = await this.releaseUnsent(start, prepared, {
					kind: 'aborted-before-transport', transportInvoked: false,
					attempt: this.attempt(prepared),
				}, effectiveLegacy);
				return { kind: cleared ? 'not-sent' : 'unknown' };
			}
			const sent = await client.sendWrite(prepared); // exactly one attempt, fixed operationId
			if (sent.kind === 'not-sent') {
				const cleared = await this.releaseUnsent(start, prepared, {
					kind: 'send-write-not-sent', result: sent, attempt: this.attempt(prepared),
				}, effectiveLegacy);
				return { kind: cleared ? 'not-sent' : 'unknown' };
			}
			if (sent.kind !== 'acknowledged') {
				// Rejections/conflicts, timeouts and missing ACK are not local no-send proof.
				return { kind: sent.kind === 'conflict' ? 'conflict' : 'unknown' };
			}
			// An ACK is from the PREVIOUS account/endpoint if local credentials
			// changed in flight. Never write it into a different account's binding.
			if (!this.ready() || this.configStamp() !== stamp) return { kind: 'unknown' };
			await this.settings.updateNonSecret(data => {
				if (this.configStamp() !== stamp) throw new Error('authorization-changed');
				data.publishBindings = recordAckCandidate(data.publishBindings,
					start.note, effectiveLegacy, intent.productId, prepared.operationId, sent.data);
			});
			if (!await this.unchanged(context, start, stamp)) return { kind: 'acknowledged' };
			const fetched = await client.readCurrent({
				sourceId: prepared.sourceId, productId: prepared.productId, documentId: sent.data.documentId });
			if (fetched.kind !== 'acknowledged') return { kind: 'acknowledged' };
			const checked = await verifyReadCurrent(fetched.data);
			if (!await this.unchanged(context, start, stamp)) return { kind: 'acknowledged' };
			await this.settings.updateNonSecret(data => {
				if (this.configStamp() !== stamp || !context.isCurrent() ||
					context.file.path !== start.note.path) throw new Error('changed');
				data.publishBindings = completeAcknowledgedWrite(data.publishBindings,
					start.note, effectiveLegacy, prepared, checked, {
						accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true,
						independentServerRead: true,
					});
			});
			if (!await this.unchanged(context, start, stamp)) return { kind: 'acknowledged' };
			const status = linked(checked);
			if (status.kind !== 'linked') return { kind: 'unknown' };
			return intent.action === 'publish'
				? { kind: 'verified', action: 'publish', sourcePath: intent.sourcePath,
					productId: intent.productId, status, publishedVersionNo: checked.currentVersionNo }
				: { kind: 'verified', action: 'sync', sourcePath: intent.sourcePath,
					productId: intent.productId, status };
		} catch {
			return { kind: staged ? 'unknown' : 'not-sent' };
		} finally {
			this.writing.delete(context.file);
		}
	}
	dialogHost(context: PublishDocumentContext): ZhouyouDialogHost {
		return {
			availability: () => this.availability(),
			listProducts: () => this.listProducts(),
			readStatus: productId => this.readStatus(context, productId),
			confirmLegacy: (productId, reviewId) => this.confirmLegacy(context, productId, reviewId),
			readAsNewDocument: (productId, reviewId) => this.readAsNewDocument(context, productId, reviewId),
			submit: intent => this.submit(context, intent),
			reviewAfterUncertain: productId => this.review(context, productId),
		};
	}
}
