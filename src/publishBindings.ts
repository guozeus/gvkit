/** Non-secret publish bindings. Every transition consumes the LATEST ordinary
 * settings snapshot inside PublishSettings.updateNonSecret(change). No IO here.
 * The caller must verify native note identity, complete local legacy inventory,
 * authorised remote identity and backend atomicity before asserting evidence.
 * These evidence labels are gates, not substitutes for server verification. */
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import type { PreparedWrite, ZhouyouCurrent, ZhouyouWriteAck, ZhouyouResult, WriteAction } from './zhouyouClient';

export type BindingFailure =
	| 'invalid-source' | 'source-unverified' | 'source-duplicate' | 'source-divergent'
	| 'path-conflict' | 'product-isolation' | 'binding-conflict'
	| 'legacy-unchecked' | 'legacy-invalid' | 'legacy-pending' | 'legacy-conflict'
	| 'ownership-unconfirmed'
	| 'remote-unverified' | 'invalid-record' | 'pending-unconfirmed'
	| 'operation-mismatch' | 'history-unverified';

export class BindingBlocked extends Error {
	readonly reason: BindingFailure;
	constructor(reason: BindingFailure) {
		super(reason);
		this.reason = reason;
		this.name = 'BindingBlocked';
	}
}
function stop(reason: BindingFailure): never { throw new BindingBlocked(reason); }
function object(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function id(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0 && v.length <= 256
		&& v.trim() === v && !/[\s\u0000-\u001f\u007f]/u.test(v);
}
function positive(v: unknown): v is number {
	return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}
function nonnegative(v: unknown): v is number {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function sha(v: unknown): v is string {
	return typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
}
function operationId(v: unknown): v is string {
	return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
}
function sourceGvid(v: unknown): v is string {
	return typeof v === 'string' && validateUuid(v) && uuidVersion(v) === 7;
}
function nullableId(v: unknown): v is string | null { return v === null || id(v); }
function nullableVersion(v: unknown): v is number | null { return v === null || positive(v); }
function pair(documentId: unknown, recordVersion: unknown): boolean {
	return nullableId(documentId) && nullableVersion(recordVersion)
		&& ((documentId === null) === (recordVersion === null));
}
function location(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0 && v.length <= 2048
		&& v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v);
}

/** VERIFIED means the host has inspected actual known file/index relationships,
 * not merely seen the gvid property. A different path needs same-file rename or
 * authoritative source confirmation: gvid/path/identical content alone is not proof. */
export interface NoteEvidence {
	gvid: unknown;
	path: string;
	identity: 'verified' | 'unknown' | 'duplicate' | 'divergent';
	pathProof: 'unverified' | 'same-file-rename' | 'server-confirmed';
}
export interface LegacyObservation {
	/** checked: local runtime examined permitted non-secret legacy locations;
	 * unknown: frontmatter absence does NOT prove there was no old data.json binding. */
	inventory: 'checked' | 'unknown';
	/** Exact eight old zhou_* fields, as extracted locally; no private settings. */
	fields: unknown;
	/** Origin is a review hint, never evidence that the old source belongs to this TFile. */
	origin?: 'none' | 'note-fields' | 'path-only' | 'native-rename-hint' | 'saved-unconfirmed';
	candidatePath?: string;
	/** An orphan exists, but is not claimed as the current note's relation. */
	unresolvedOrphan?: boolean;
}
export interface VerifiedRemote {
	/** Only an independently verified authorised read/absence, never an ACK guess. */
	evidence: 'server-verified-existing' | 'server-verified-absent';
	sourceId: string;
	productId: string;
	documentId: string | null;
	recordVersion: number | null;
	contentHash: string | null;
	currentVersionNo: number | null;
}
export interface AckCandidate {
	documentId: string;
	recordVersion: number;
	currentVersionNo: number | null;
}
export interface PendingWrite {
	operationId: string;
	action: WriteAction;
	payloadHash: string;
	sourceRevision: string;
	documentId: string | null;
	expectedRecordVersion: number | null;
	businessVersionBefore: number | null;
	/** Stable pre-send content baseline; detect recovery or concurrent mutation. */
	contentHashBefore: string | null;
	ackCandidate: AckCandidate | null;
}
export interface PublishBinding {
	gvid: string;
	sourceId: string;
	productId: string;
	documentId: string | null;
	recordVersion: number | null;
	contentHash: string | null;
	currentVersionNo: number | null;
	pathHint: string;
	pending: PendingWrite | null;
	/** Non-secret, exact tuple accepted by the user after an authorized read. */
	ownershipProof?: { kind: 'legacy-user-confirmed'; gvid: string; sourceId: string;
		productId: string; documentId: string };
}
export type BindingTable = PublishBinding[];

const OLD_FIELDS = [
	'zhou_source_id', 'zhou_document_id', 'zhou_product_id', 'zhou_record_version',
	'zhou_operation_id', 'zhou_operation_hash', 'zhou_operation_record_version',
	'zhou_operation_document_id',
] as const;
type OldField = typeof OLD_FIELDS[number];
interface OldBinding {
	sourceId: string;
	productId: string;
	documentId: string | null;
	recordVersion: number | null;
	pending: boolean;
}
function legacyChecked(legacy: LegacyObservation): OldBinding | null {
	if (!legacy || legacy.inventory !== 'checked' || !object(legacy.fields)) stop('legacy-unchecked');
	const fields = legacy.fields;
	const present = OLD_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(fields, key));
	if (!present) return null;
	// A partial or inconsistent old binding is evidence of risk, not a new file.
	if (!id(fields.zhou_source_id) || !id(fields.zhou_product_id)) stop('legacy-invalid');
	const doc = fields.zhou_document_id === undefined ? null : fields.zhou_document_id;
	const version = fields.zhou_record_version === undefined ? null : fields.zhou_record_version;
	if (!pair(doc, version)) stop('legacy-invalid');
	const pendingKeys: OldField[] = [
		'zhou_operation_id', 'zhou_operation_hash',
		'zhou_operation_record_version', 'zhou_operation_document_id',
	];
	const hasPending = pendingKeys.some((key) => fields[key] !== undefined);
	if (hasPending && (!operationId(fields.zhou_operation_id) || !sha(fields.zhou_operation_hash)
		|| !pair(fields.zhou_operation_document_id, fields.zhou_operation_record_version)
		|| fields.zhou_operation_document_id !== doc
		|| fields.zhou_operation_record_version !== version)) stop('legacy-invalid');
	return {
		sourceId: fields.zhou_source_id as string,
		productId: fields.zhou_product_id as string,
		documentId: doc as string | null, recordVersion: version as number | null,
		pending: hasPending,
	};
}
function checkNote(note: NoteEvidence): string {
	if (!sourceGvid(note?.gvid) || !location(note.path)) stop('invalid-source');
	if (note.identity === 'duplicate') stop('source-duplicate');
	if (note.identity === 'divergent') stop('source-divergent');
	if (note.identity !== 'verified') stop('source-unverified');
	return note.gvid as string;
}
function key(gvid: string, productId: string): string { return JSON.stringify([gvid, productId]); }
function checkPending(value: unknown): value is PendingWrite {
	if (!object(value) || !operationId(value.operationId) || !sha(value.payloadHash)
		|| !sha(value.sourceRevision) || (value.action !== 'sync' && value.action !== 'publish')
		|| !pair(value.documentId, value.expectedRecordVersion)
		|| !(value.businessVersionBefore === null || nonnegative(value.businessVersionBefore))
		|| !(value.contentHashBefore === null || sha(value.contentHashBefore))) return false;
	const c = value.ackCandidate;
	return c === null || (object(c) && id(c.documentId) && positive(c.recordVersion)
		&& (c.currentVersionNo === null || nonnegative(c.currentVersionNo)));
}
function checkBinding(value: unknown): value is PublishBinding {
	if (!object(value) || !sourceGvid(value.gvid) || !id(value.sourceId)
		|| !id(value.productId) || !location(value.pathHint)
		|| !pair(value.documentId, value.recordVersion)
		|| !(value.contentHash === null || sha(value.contentHash))
		|| !(value.currentVersionNo === null || nonnegative(value.currentVersionNo))
		|| !(value.pending === null || checkPending(value.pending))) return false;
	if (value.documentId === null && (value.contentHash !== null || value.currentVersionNo !== null)) return false;
	if (value.ownershipProof !== undefined && (!object(value.ownershipProof)
		|| value.ownershipProof.kind !== 'legacy-user-confirmed'
		|| value.ownershipProof.gvid !== value.gvid
		|| value.ownershipProof.sourceId !== value.sourceId
		|| value.ownershipProof.productId !== value.productId
		|| value.ownershipProof.documentId !== value.documentId
		|| !id(value.ownershipProof.documentId))) return false;
	return true;
}
/** Validate untrusted persisted JSON and reject ambiguous duplicate mappings.
 * Never reset corrupt state to an empty table and risk duplicate creation. */
export function readPublishBindings(raw: unknown): BindingTable {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) stop('invalid-record');
	const seen = new Set<string>();
	const sources = new Map<string, string>();
	const documents = new Map<string, string>();
	const result: BindingTable = [];
	for (const value of raw) {
		if (!checkBinding(value)) stop('invalid-record');
		const entry = value as PublishBinding;
		const composite = key(entry.gvid, entry.productId);
		if (seen.has(composite)) stop('binding-conflict');
		seen.add(composite);
		const sourceKey = key(entry.sourceId, entry.productId);
		const documentKey = entry.documentId === null ? null : key(entry.documentId, entry.productId);
		if ((sources.has(sourceKey) && sources.get(sourceKey) !== entry.gvid)
			|| (documentKey && documents.has(documentKey) && documents.get(documentKey) !== entry.gvid))
			stop('binding-conflict');
		sources.set(sourceKey, entry.gvid);
		if (documentKey) documents.set(documentKey, entry.gvid);
		result.push({
			gvid: entry.gvid, sourceId: entry.sourceId, productId: entry.productId,
			documentId: entry.documentId, recordVersion: entry.recordVersion,
			contentHash: entry.contentHash, currentVersionNo: entry.currentVersionNo,
			pathHint: entry.pathHint,
			...(entry.ownershipProof ? { ownershipProof: { ...entry.ownershipProof } } : {}),
			pending: entry.pending === null ? null : {
				...entry.pending,
				ackCandidate: entry.pending.ackCandidate === null ? null : { ...entry.pending.ackCandidate },
			},
		});
	}
	return result;
}
function get(table: readonly PublishBinding[], gvid: string, productId: string): PublishBinding | null {
	return table.find((entry) => entry.gvid === gvid && entry.productId === productId) ?? null;
}
function checkIdentity(table: readonly PublishBinding[], note: NoteEvidence, productId: string, allowOtherProduct: boolean): PublishBinding | null {
	const gvid = checkNote(note);
	if (!id(productId)) stop('invalid-record');
	for (const entry of table) {
		// A stale path hint from another GVID is not ownership of a new TFile.
		if (entry.gvid !== gvid) continue;
		if (entry.pathHint !== note.path && note.pathProof !== 'same-file-rename'
			&& note.pathProof !== 'server-confirmed') stop('path-conflict');
		if (entry.productId !== productId && !allowOtherProduct && !get(table, gvid, productId))
			stop('product-isolation');
	}
	return get(table, gvid, productId);
}
function checkOld(legacy: LegacyObservation, existing: PublishBinding | null, remote?: VerifiedRemote): void {
	if (legacy.unresolvedOrphan && existing && existing.sourceId !== existing.gvid)
		stop('legacy-unchecked'); // P2 recovery must prove this orphan's relationship.
	const old = legacyChecked(legacy);
	if (!old) return;
	if (old.pending) stop('legacy-pending');
	const candidate = remote ?? existing;
	// The legacy source fields are an unchanged historical snapshot, not the live
	// server baseline. Require stable identities and monotonic verified progress.
	if (!candidate || candidate.sourceId !== old.sourceId || candidate.productId !== old.productId
		|| (old.documentId !== null && candidate.documentId !== old.documentId)
		|| (old.recordVersion !== null && (candidate.recordVersion === null
			|| candidate.recordVersion < old.recordVersion)))
		stop('legacy-conflict');
}
function checkOwnership(binding: PublishBinding): void {
	if (binding.sourceId !== binding.gvid && !binding.ownershipProof) stop('ownership-unconfirmed');
}
/** This only identifies a precise candidate. It does not assign ownership. */
export function legacyCandidate(legacy: LegacyObservation, productId: string): OldBinding | null {
	const old = legacyChecked(legacy);
	if (!old) return null;
	if (old.pending) stop('legacy-pending');
	if (old.productId !== productId || old.documentId === null || old.recordVersion === null)
		stop('legacy-conflict');
	return old;
}
function replace(table: readonly PublishBinding[], next: PublishBinding): BindingTable {
	const index = table.findIndex((item) => item.gvid === next.gvid && item.productId === next.productId);
	return readPublishBindings(index === -1 ? [...table, next]
		: table.map((item, i) => i === index ? next : item));
}
/** Read/check before any action. No verification of private legacy inventory or
 * native uniqueness is inferred from an empty input or matching current body. */
export function inspectBinding(
	raw: unknown, note: NoteEvidence, productId: string, legacy: LegacyObservation,
): PublishBinding | null {
	const table = readPublishBindings(raw);
	const existing = checkIdentity(table, note, productId, false);
	checkOld(legacy, existing);
	if (existing) checkOwnership(existing);
	return existing;
}
function verifyRemote(remote: VerifiedRemote, productId: string): void {
	if (!remote || !id(remote.sourceId) || remote.productId !== productId) stop('remote-unverified');
	if (remote.evidence === 'server-verified-existing') {
		if (!id(remote.documentId) || !positive(remote.recordVersion)
			|| !sha(remote.contentHash) || !nonnegative(remote.currentVersionNo))
			stop('remote-unverified');
	} else if (remote.evidence === 'server-verified-absent') {
		if (remote.documentId !== null || remote.recordVersion !== null
			|| remote.contentHash !== null || remote.currentVersionNo !== null)
			stop('remote-unverified');
	} else stop('remote-unverified');
}
/** Fresh binding requires a real server read/absence plus proven backend mapping
 * and first-create atomicity, supplied by a future workflow. A true flag from a
 * mock cannot authorise production. Never create a per-device random sourceId. */
export function installVerifiedBinding(
	raw: unknown, note: NoteEvidence, productId: string, legacy: LegacyObservation,
	remote: VerifiedRemote, contracts: { stableSourceVerified: boolean; atomicFirstCreateVerified: boolean; multiProductVerified: boolean },
): BindingTable {
	const table = readPublishBindings(raw);
	const prior = checkIdentity(table, note, productId, contracts.multiProductVerified === true);
	checkOld(legacy, prior, remote);
	verifyRemote(remote, productId);
	if (contracts.stableSourceVerified !== true || (remote.evidence === 'server-verified-absent' && contracts.atomicFirstCreateVerified !== true))
		stop('remote-unverified');
	if (prior) {
		checkOwnership(prior);
		if (prior.sourceId !== remote.sourceId || prior.documentId !== remote.documentId
			|| prior.recordVersion !== remote.recordVersion || prior.contentHash !== remote.contentHash
			|| prior.currentVersionNo !== remote.currentVersionNo) stop('binding-conflict');
		return replace(table, { ...prior, pathHint: note.path });
	}
	if (remote.sourceId !== note.gvid) stop('ownership-unconfirmed');
	const entry: PublishBinding = {
		gvid: note.gvid as string, productId, sourceId: remote.sourceId,
		documentId: remote.documentId, recordVersion: remote.recordVersion,
		contentHash: remote.contentHash, currentVersionNo: remote.currentVersionNo,
		pathHint: note.path, pending: null,
	};
	return replace(table, entry);
}
/** Called only for an explicit, freshly rechecked user decision. All normal
 * transitions then use the same tuple proof check as this installation. */
export function confirmLegacyBinding(
	raw: unknown, note: NoteEvidence, productId: string, legacy: LegacyObservation,
	remote: VerifiedRemote, contracts: { stableSourceVerified: boolean; atomicFirstCreateVerified: boolean; multiProductVerified: boolean },
): BindingTable {
	const old = legacyCandidate(legacy, productId);
	if (!old || remote.evidence !== 'server-verified-existing'
		|| remote.sourceId !== old.sourceId || remote.productId !== old.productId
		|| remote.documentId !== old.documentId || remote.recordVersion === null
		|| remote.recordVersion < old.recordVersion!) stop('legacy-conflict');
	const table = readPublishBindings(raw);
	const prior = checkIdentity(table, note, productId, false);
	checkOld(legacy, prior, remote);
	verifyRemote(remote, productId);
	if (contracts.stableSourceVerified !== true) stop('remote-unverified');
	if (prior?.pending) stop('pending-unconfirmed');
	if (prior?.ownershipProof) stop('binding-conflict');
	if (prior && (prior.sourceId !== remote.sourceId || prior.documentId !== remote.documentId
		|| (prior.recordVersion !== null && remote.recordVersion < prior.recordVersion)
		|| (prior.recordVersion === remote.recordVersion && prior.contentHash !== null
			&& prior.contentHash !== remote.contentHash)
		|| (prior.currentVersionNo !== null && remote.currentVersionNo! < prior.currentVersionNo)))
		stop('binding-conflict');
	const proof = { kind: 'legacy-user-confirmed' as const, gvid: note.gvid as string,
		sourceId: remote.sourceId, productId, documentId: remote.documentId! };
	const entry: PublishBinding = { gvid: note.gvid as string, sourceId: remote.sourceId,
		productId, documentId: remote.documentId, recordVersion: remote.recordVersion,
		contentHash: remote.contentHash, currentVersionNo: remote.currentVersionNo,
		pathHint: note.path, pending: null, ownershipProof: proof };
	return replace(table, entry);
}
function usable(raw: unknown, note: NoteEvidence, productId: string, legacy: LegacyObservation): {
	table: BindingTable; binding: PublishBinding;
} {
	const table = readPublishBindings(raw);
	const binding = checkIdentity(table, note, productId, false);
	checkOld(legacy, binding);
	if (binding) checkOwnership(binding);
	if (!binding) stop('remote-unverified');
	return { table, binding };
}
function matches(pending: PendingWrite, prepared: PreparedWrite): boolean {
	return pending.operationId === prepared.operationId && pending.action === prepared.action
		&& pending.payloadHash === prepared.payloadHash && pending.sourceRevision === prepared.sourceRevision
		&& pending.documentId === prepared.documentId
		&& pending.expectedRecordVersion === prepared.recordVersion;
}
/** Caller first awaits prepareZhouyouWrite and rechecks source/title/body. Then
 * call this synchronously INSIDE the sole updateNonSecret serial save callback;
 * only after its save resolves may the client attempt any write. */
export function stagePreparedWrite(
	raw: unknown, note: NoteEvidence, legacy: LegacyObservation, prepared: PreparedWrite,
): BindingTable {
	const { table, binding } = usable(raw, note, prepared.productId, legacy);
	if (binding.pending) stop('pending-unconfirmed');
	if (prepared.sourceId !== binding.sourceId || prepared.documentId !== binding.documentId
		|| prepared.recordVersion !== binding.recordVersion
		|| !operationId(prepared.operationId) || !sha(prepared.payloadHash)
		|| !sha(prepared.sourceRevision) || (prepared.action !== 'sync' && prepared.action !== 'publish'))
		stop('operation-mismatch');
	return replace(table, { ...binding, pathHint: note.path, pending: {
		operationId: prepared.operationId, action: prepared.action, payloadHash: prepared.payloadHash,
		sourceRevision: prepared.sourceRevision, documentId: prepared.documentId,
		expectedRecordVersion: prepared.recordVersion,
		businessVersionBefore: binding.currentVersionNo,
		contentHashBefore: binding.contentHash, ackCandidate: null,
	} });
}
/** Only the caller owning THIS staged attempt may release it after it has
 * established that its transport was never invoked, or after its exact sendWrite
 * returned the client-side 'not-sent' result. Values here do not authenticate
 * their own provenance; NEVER treat a server rejection, timeout, thrown transport,
 * missing ACK or remote inference as evidence. Do not persist evidence. */
export interface NotSentAttemptIdentity {
	readonly operationId: string;
	readonly action: WriteAction;
	readonly payloadHash: string;
	readonly sourceRevision: string;
	readonly sourceId: string;
	readonly productId: string;
	readonly documentId: string | null;
	readonly recordVersion: number | null;
}
export type DefinitelyNotSentEvidence =
	| { readonly kind: 'aborted-before-transport'; readonly transportInvoked: false; readonly attempt: NotSentAttemptIdentity }
	| { readonly kind: 'send-write-not-sent'; readonly result: Extract<ZhouyouResult<ZhouyouWriteAck>, { kind: 'not-sent' }>; readonly attempt: NotSentAttemptIdentity };

/** Pure synchronous transition in the sole updateNonSecret(change) queue.
 * Recheck the LATEST persisted binding and this operation's original prepared
 * request. Await successful saveData before UI says 'not sent / may try again'.
 * Never call this for any attempt that might have entered transport. */
export function releaseDefinitelyNotSentWrite(
	raw: unknown, note: NoteEvidence, legacy: LegacyObservation,
	prepared: PreparedWrite, evidence: DefinitelyNotSentEvidence,
): BindingTable {
	const { table, binding } = usable(raw, note, prepared.productId, legacy);
	const pending = binding.pending;
	if (!pending || pending.ackCandidate !== null) stop('pending-unconfirmed');
	if (prepared.sourceId !== binding.sourceId || !matches(pending, prepared)
		|| binding.documentId !== pending.documentId
		|| binding.recordVersion !== pending.expectedRecordVersion
		|| binding.contentHash !== pending.contentHashBefore
		|| binding.currentVersionNo !== pending.businessVersionBefore)
		stop('operation-mismatch');
	if (!object(evidence) || !object(evidence.attempt)) stop('pending-unconfirmed');
	const attempt = evidence.attempt;
	if (attempt.operationId !== prepared.operationId || attempt.action !== prepared.action
		|| attempt.payloadHash !== prepared.payloadHash || attempt.sourceRevision !== prepared.sourceRevision
		|| attempt.sourceId !== prepared.sourceId || attempt.productId !== prepared.productId
		|| attempt.documentId !== prepared.documentId || attempt.recordVersion !== prepared.recordVersion)
		stop('operation-mismatch');
	if (evidence.kind === 'aborted-before-transport') {
		if (evidence.transportInvoked !== false) stop('pending-unconfirmed');
	} else if (evidence.kind === 'send-write-not-sent') {
		const result = evidence.result;
		if (!object(result) || result.kind !== 'not-sent'
			|| (result.reason !== 'missing-credential' && result.reason !== 'credential-unavailable'
				&& result.reason !== 'invalid-credential' && result.reason !== 'invalid-request'
				&& result.reason !== 'crypto-unavailable'))
			stop('pending-unconfirmed');
	} else stop('pending-unconfirmed');
	// Only remove the exact local not-sent attempt; preserve all verified history.
	return replace(table, { ...binding, pending: null });
}

/** No automatic retry. Both explicit user intent AND independently established
 * idempotent operationId scope/lifetime are required; the original prepared
 * request must match exactly and the caller must recheck source/content. */
export function mayRetryOriginal(
	raw: unknown, note: NoteEvidence, legacy: LegacyObservation, prepared: PreparedWrite,
	gates: { userRequested: boolean; serverIdempotencyVerified: boolean },
): boolean {
	const { binding } = usable(raw, note, prepared.productId, legacy);
	return !!binding.pending && prepared.sourceId === binding.sourceId
		&& matches(binding.pending, prepared)
		&& gates.userRequested === true && gates.serverIdempotencyVerified === true;
}
/** ACK is candidate ONLY. No update of baseline or clearing of pending. */
export function recordAckCandidate(
	raw: unknown, note: NoteEvidence, legacy: LegacyObservation,
	productId: string, operation: string, ack: ZhouyouWriteAck,
): BindingTable {
	const { table, binding } = usable(raw, note, productId, legacy);
	const pending = binding.pending;
	if (!pending || pending.operationId !== operation) stop('operation-mismatch');
	if (!id(ack.documentId) || !positive(ack.recordVersion)
		|| (pending.documentId !== null && pending.documentId !== ack.documentId)
		|| (pending.expectedRecordVersion !== null && ack.recordVersion < pending.expectedRecordVersion)
		|| (ack.currentVersionNo !== undefined && !nonnegative(ack.currentVersionNo))
		|| (pending.action === 'publish' && !positive(ack.currentVersionNo)))
		stop('operation-mismatch');
	const candidate: AckCandidate = {
		documentId: ack.documentId, recordVersion: ack.recordVersion,
		currentVersionNo: ack.currentVersionNo ?? null,
	};
	if (pending.ackCandidate && JSON.stringify(pending.ackCandidate) !== JSON.stringify(candidate))
		stop('binding-conflict');
	return replace(table, { ...binding, pending: { ...pending, ackCandidate: candidate } });
}
// Verify untrusted server bytes outside the existing synchronous save queue.
// The opaque immutable result is later consumed INSIDE updateNonSecret(change).
const CURRENT_VALIDATED = Symbol('gvkit-current-validated');
// A copied/spread snapshot must NOT inherit the authority of the verified object.
const VERIFIED_CURRENT = new WeakSet<object>();
export interface HashVerifiedCurrent extends ZhouyouCurrent {
	readonly [CURRENT_VALIDATED]: true;
}
export async function verifyReadCurrent(current: ZhouyouCurrent): Promise<HashVerifiedCurrent> {
	if (!current || !id(current.sourceId) || !id(current.productId)
		|| !id(current.documentId) || !positive(current.recordVersion)
		|| !nonnegative(current.currentVersionNo) || !sha(current.contentHash)
		|| current.documentStatus !== 'active' || typeof current.content !== 'string'
		|| typeof current.title !== 'string') stop('remote-unverified');
	if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') stop('remote-unverified');
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(current.content));
	const hex = Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
	if (hex !== current.contentHash) stop('remote-unverified');
	const checked = Object.freeze({ ...current, [CURRENT_VALIDATED]: true as const });
	VERIFIED_CURRENT.add(checked);
	return checked;
}
/** Read-only/manual baseline recovery does NOT confirm a prior publish.
 * This synchronous transition rechecks LATEST bindings inside save queue.
 * Never writes source Markdown or removes its pending operation. */
export function reconcileReadOnly(
	raw: unknown, note: NoteEvidence, legacy: LegacyObservation, productId: string,
	current: HashVerifiedCurrent, gates: { userAccepted: boolean; accountUnchanged: boolean },
): BindingTable {
	const { table, binding } = usable(raw, note, productId, legacy);
	if (!current || current[CURRENT_VALIDATED] !== true || !VERIFIED_CURRENT.has(current)) stop('remote-unverified');
	if (!gates.userAccepted || !gates.accountUnchanged) stop('remote-unverified');
	if (current.sourceId !== binding.sourceId || current.productId !== binding.productId
		|| !id(current.documentId) || (binding.documentId !== null && current.documentId !== binding.documentId)
		|| !positive(current.recordVersion)
		|| (binding.recordVersion !== null && current.recordVersion < binding.recordVersion)
		|| !nonnegative(current.currentVersionNo) || !sha(current.contentHash)
		|| current.documentStatus !== 'active' || typeof current.content !== 'string')
		stop('binding-conflict');
	return replace(table, {
		...binding, pathHint: note.path, documentId: current.documentId,
		recordVersion: current.recordVersion, contentHash: current.contentHash,
		currentVersionNo: current.currentVersionNo,
		// Never silently erase an unknown sync OR publish, even if content matches.
	});
}
/** NORMAL completed attempt only: client returned a matched ACK for the exact
 * persisted operation, and an independent read_current proves that particular
 * write's source/body/document/record/business-version state. An ACK alone, a
 * matching current body WITHOUT ACK, or a mere recordVersion increment fails.
 *
 * Input 'prepared' is the original exact prepareZhouyouWrite result (recheck
 * against current note bytes before finishing); the caller must have checked
 * the same live credential/approved HTTPS endpoint and independently fetched
 * read_current with the matching sourceId/productId/documentId after the ACK.
 * These runtime gates must come from actual checked facts, not assumed defaults.
 *
 * Call synchronously inside the existing updateNonSecret save queue with the
 * LATEST raw state after verifyReadCurrent(current) was awaited outside it.
 * Only after saveData resolves may UI show success / permit another operation.
 * A manual recovery deliberately never clears pending. */
export function completeAcknowledgedWrite(
	raw: unknown, note: NoteEvidence, legacy: LegacyObservation, prepared: PreparedWrite,
	current: HashVerifiedCurrent,
	gates: {
		accountAndEndpointUnchanged: boolean;
		sourceAndRequestUnchanged: boolean;
		independentServerRead: boolean;
	},
): BindingTable {
	const { table, binding } = usable(raw, note, prepared.productId, legacy);
	const pending = binding.pending;
	if (!pending || !pending.ackCandidate) stop('pending-unconfirmed');
	if (!current || current[CURRENT_VALIDATED] !== true || !VERIFIED_CURRENT.has(current)
		|| !gates || gates.accountAndEndpointUnchanged !== true
		|| gates.sourceAndRequestUnchanged !== true || gates.independentServerRead !== true)
		stop('remote-unverified');
	if (prepared.sourceId !== binding.sourceId || !matches(pending, prepared)
		|| binding.documentId !== pending.documentId
		|| binding.recordVersion !== pending.expectedRecordVersion
		|| binding.contentHash !== pending.contentHashBefore
		|| binding.currentVersionNo !== pending.businessVersionBefore)
		stop('operation-mismatch');
	const ack = pending.ackCandidate;
	if (current.sourceId !== binding.sourceId || current.productId !== binding.productId
		|| current.documentId !== ack.documentId
		|| (pending.documentId !== null && current.documentId !== pending.documentId)
		|| current.recordVersion !== ack.recordVersion
		|| current.contentHash !== pending.sourceRevision
		|| (ack.currentVersionNo !== null && current.currentVersionNo !== ack.currentVersionNo)
		|| current.documentStatus !== 'active')
		stop('binding-conflict');
	if (pending.businessVersionBefore === null && pending.documentId !== null)
		stop('history-unverified');
	if (pending.expectedRecordVersion !== null
		&& (pending.action === 'publish' || pending.contentHashBefore !== pending.sourceRevision
			? current.recordVersion <= pending.expectedRecordVersion
			: current.recordVersion < pending.expectedRecordVersion)) stop('binding-conflict');
	// A normal sync never creates a business release; a first creation that
	// was independently absent can only read back the zero-release baseline.
	if (pending.action === 'sync'
		&& current.currentVersionNo !== (pending.businessVersionBefore ?? 0))
		stop('history-unverified');
	// A normal publish creates exactly ONE next business version. The same
	// operation replayed with already-applied ACK is still this one version.
	if (pending.action === 'publish' &&
		(ack.currentVersionNo === null
			|| current.currentVersionNo !== (pending.businessVersionBefore ?? 0) + 1))
		stop('history-unverified');
	return replace(table, {
		...binding, pathHint: note.path,
		documentId: current.documentId, recordVersion: current.recordVersion,
		contentHash: current.contentHash, currentVersionNo: current.currentVersionNo,
		pending: null,
	});
}

export interface VerifiedOperationHistory {
	evidence: 'independent-operation-history';
	operationId: string;
	action: WriteAction;
	payloadHash: string;
	sourceRevision: string;
	sourceId: string;
	productId: string;
	documentId: string;
	recordVersion: number;
	currentVersionNo: number;
}
/** Only after downstream verifies actual operationId/action/hash + business
 * history against authoritative server proof. A read_current body, version
 * increment, ACK or user acknowledgement alone CANNOT create this evidence. */
export function resolveFromOperationHistory(
	raw: unknown, note: NoteEvidence, legacy: LegacyObservation, proof: VerifiedOperationHistory,
): BindingTable {
	const { table, binding } = usable(raw, note, proof.productId, legacy);
	const pending = binding.pending;
	if (!pending) stop('operation-mismatch');
	if (proof.evidence !== 'independent-operation-history') stop('history-unverified');
	if (proof.sourceId !== binding.sourceId || proof.productId !== binding.productId
		|| proof.operationId !== pending.operationId || proof.action !== pending.action
		|| proof.payloadHash !== pending.payloadHash || proof.sourceRevision !== pending.sourceRevision
		|| !id(proof.documentId) || (pending.documentId !== null && proof.documentId !== pending.documentId)
		|| (binding.documentId !== null && proof.documentId !== binding.documentId)
		|| !positive(proof.recordVersion) || !nonnegative(proof.currentVersionNo)
		|| (pending.expectedRecordVersion !== null && proof.recordVersion < pending.expectedRecordVersion)
		|| (binding.recordVersion !== null && proof.recordVersion < binding.recordVersion)
		|| (binding.currentVersionNo !== null && proof.currentVersionNo < binding.currentVersionNo))
		stop('operation-mismatch');
	if (pending.ackCandidate && (proof.documentId !== pending.ackCandidate.documentId
		|| proof.recordVersion !== pending.ackCandidate.recordVersion
		|| (pending.ackCandidate.currentVersionNo !== null
			&& proof.currentVersionNo !== pending.ackCandidate.currentVersionNo)))
		stop('binding-conflict');
	if (pending.action === 'publish' && (proof.currentVersionNo === 0
		|| (pending.businessVersionBefore !== null && proof.currentVersionNo <= pending.businessVersionBefore)))
		stop('history-unverified');
	// A content sync must not silently be accepted as a new business release.
	if (pending.action === 'sync' && pending.businessVersionBefore !== null
		&& proof.currentVersionNo !== pending.businessVersionBefore)
		stop('history-unverified');
	return replace(table, {
		...binding, documentId: proof.documentId, recordVersion: proof.recordVersion,
		contentHash: pending.sourceRevision, currentVersionNo: proof.currentVersionNo,
		pending: null,
	});
}
