import assert from 'node:assert/strict';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';
import {
	BindingBlocked, readPublishBindings, inspectBinding, installVerifiedBinding,
	confirmLegacyBinding,
	stagePreparedWrite, releaseDefinitelyNotSentWrite, mayRetryOriginal, recordAckCandidate,
	verifyReadCurrent, reconcileReadOnly, completeAcknowledgedWrite, resolveFromOperationHistory,
} from '../src/publishBindings.ts';
import { prepareZhouyouWrite, sha256Utf8, ZhouyouClient } from '../src/zhouyouClient.ts';
import type { LegacyObservation, NoteEvidence, VerifiedRemote } from '../src/publishBindings.ts';

const GVID = uuidv7();
const OTHER = uuidv7();
const SRC = GVID;
const PRODUCT = 'game-1';
const DOC = 'doc-1';
const OP = '00000000-0000-4000-8000-000000000021';
const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const contracts = { stableSourceVerified: true, atomicFirstCreateVerified: true, multiProductVerified: false };
function note(path = '项目/文章.md', gvid: unknown = GVID): NoteEvidence {
	return { gvid, path, identity: 'verified', pathProof: 'unverified' };
}
function old(fields: unknown = {}): LegacyObservation { return { inventory: 'checked', fields }; }
function remote(sourceId = SRC, productId = PRODUCT, documentId: string | null = DOC): VerifiedRemote {
	return documentId ? {
		evidence: 'server-verified-existing', sourceId, productId, documentId,
		recordVersion: 4, contentHash: HASH, currentVersionNo: 2,
	} : {
		evidence: 'server-verified-absent', sourceId, productId,
		documentId: null, recordVersion: null, contentHash: null, currentVersionNo: null,
	};
}
function installed() {
	return installVerifiedBinding([], note(), PRODUCT, old(), remote(), contracts);
}
function blocks(reason: string, fn: () => unknown) {
	assert.throws(fn, (error: unknown) => error instanceof BindingBlocked && error.reason === reason);
}
async function blocksAsync(reason: string, fn: () => Promise<unknown>) {
	await assert.rejects(fn, (error: unknown) => error instanceof BindingBlocked && error.reason === reason);
}
async function prepared(action: 'sync' | 'publish' = 'sync', operationId = OP) {
	return prepareZhouyouWrite({
		action, sourceId: SRC, productId: PRODUCT, documentId: DOC,
		recordVersion: 4, title: '文章', content: 'abc',
		changeSummary: action === 'publish' ? '更新了剧情' : '', operationId,
	});
}
test('valid v7 is required; empty/invalid gvid, unknown/duplicate/divergent known identities block', () => {
	for (const gvid of ['', 'invalid', '00000000-0000-4000-8000-000000000001', null]) {
		blocks('invalid-source', () => inspectBinding([], note('a.md', gvid), PRODUCT, old()));
	}
	for (const [identity, reason] of [
		['unknown', 'source-unverified'], ['duplicate', 'source-duplicate'], ['divergent', 'source-divergent'],
	] as const) blocks(reason, () => inspectBinding([], { ...note(), identity }, PRODUCT, old()));
});
test('never infer no legacy relationship from missing frontmatter / unknown private inventory', () => {
	blocks('legacy-unchecked', () => inspectBinding([], note(), PRODUCT, { inventory: 'unknown', fields: {} }));
	blocks('legacy-unchecked', () => inspectBinding([], note(), PRODUCT, { inventory: 'checked', fields: null }));
	const malformed = { zhou_source_id: 'old-source' };
	blocks('legacy-invalid', () => installVerifiedBinding([], note(), PRODUCT, old(malformed), remote(), contracts));
});
test('retains old IDs and rejects contradictory legacy, incomplete legacy pending and unreconciled pending', () => {
	const legacy = {
		zhou_source_id: 'old-source-uuid-v4', zhou_product_id: PRODUCT,
		zhou_document_id: DOC, zhou_record_version: 4,
	};
	blocks('ownership-unconfirmed', () => installVerifiedBinding([], note(), PRODUCT,
		old(legacy), remote('old-source-uuid-v4'), contracts));
	const migrated = confirmLegacyBinding([], note(), PRODUCT, old(legacy),
		remote('old-source-uuid-v4'), contracts);
	assert.equal(migrated[0]?.sourceId, 'old-source-uuid-v4');
	assert.equal(migrated[0]?.ownershipProof?.kind, 'legacy-user-confirmed');
	assert.equal(migrated[0]?.documentId, DOC);
	assert.equal(migrated[0]?.recordVersion, 4);
	blocks('legacy-conflict', () => installVerifiedBinding([], note(), PRODUCT, old(legacy), remote(), contracts));
	const partialPending = { ...legacy, zhou_operation_id: OP };
	blocks('legacy-invalid', () => installVerifiedBinding([], note(), PRODUCT, old(partialPending), remote('old-source-uuid-v4'), contracts));
	const completePending = { ...legacy, zhou_operation_id: OP, zhou_operation_hash: HASH,
		zhou_operation_record_version: 4, zhou_operation_document_id: DOC };
	blocks('legacy-pending', () => installVerifiedBinding([], note(), PRODUCT, old(completePending), remote('old-source-uuid-v4'), contracts));
});
test('different devices with same v7/product map to one verified business record; no random IDs', () => {
	const a = installed();
	const b = installVerifiedBinding([], note(), PRODUCT, old(), remote(), contracts);
	assert.equal(a[0]?.sourceId, b[0]?.sourceId);
	assert.equal(a[0]?.documentId, b[0]?.documentId);
	assert.equal(a[0]?.recordVersion, b[0]?.recordVersion);
	blocks('remote-unverified', () => installVerifiedBinding([], note(), PRODUCT, old(),
		remote(GVID, PRODUCT, null), { ...contracts, atomicFirstCreateVerified: false }));
	blocks('remote-unverified', () => installVerifiedBinding([], note(), PRODUCT, old(),
		remote(GVID, PRODUCT, null), { ...contracts, stableSourceVerified: false }));
	blocks('binding-conflict', () => installVerifiedBinding(a, note(), PRODUCT, old(),
		{ ...remote(), documentId: 'another-doc' }, contracts));
});
test('rename/move updates only hint with real proof; copy/path collision stops', () => {
	const a = installed();
	const renamed = { ...note('新目录/新名.md'), pathProof: 'same-file-rename' as const };
	blocks('path-conflict', () => inspectBinding(a, note('副本.md'), PRODUCT, old()));
	const b = installVerifiedBinding(a, renamed, PRODUCT, old(), remote(), contracts);
	assert.equal(b[0]?.pathHint, '新目录/新名.md');
	assert.equal(b[0]?.documentId, DOC);
	assert.equal(b[0]?.recordVersion, 4);
	assert.equal(a[0]?.pathHint, '项目/文章.md');
	const serverConfirmed = { ...note('手机/文件.md'), pathProof: 'server-confirmed' as const };
	assert.equal(installVerifiedBinding(b, serverConfirmed, PRODUCT, old(), remote(), contracts)[0]?.pathHint, '手机/文件.md');
	assert.equal(inspectBinding(a, note('项目/文章.md', OTHER), PRODUCT, old()), null,
		'a different current GVID may query its own source despite a stale old path hint');
});
test('product remains isolated, even when another product is authorized for an independent mapping', () => {
	const a = installed();
	blocks('product-isolation', () => installVerifiedBinding(a, note(), 'game-2', old(),
		remote(SRC, 'game-2', null), contracts));
	const separate = installVerifiedBinding(a, note(), 'game-2', old(),
		remote(SRC, 'game-2', null), { ...contracts, multiProductVerified: true });
	assert.equal(separate.length, 2);
	assert.equal(separate[0]?.documentId, DOC);
	assert.equal(separate[1]?.documentId, null);
	blocks('binding-conflict', () => installVerifiedBinding(a, note(), PRODUCT, old(),
		remote('another-source'), contracts));
});
test('refuse duplicate persisted keys, corrupt versions and never reset bad records to []', () => {
	const a = installed();
	blocks('binding-conflict', () => readPublishBindings([...a, ...a]));
	blocks('invalid-record', () => readPublishBindings([{ ...a[0], recordVersion: -1 }]));
	blocks('invalid-record', () => readPublishBindings('not-a-table'));
	assert.deepEqual(readPublishBindings(undefined), []);
});
test('legacy ownership is tied to the exact four IDs and every normal transition checks it', async () => {
	const fields = { zhou_source_id: '55c49585-5c6b-4a6d-8af3-2189e19d4d33',
		zhou_product_id: PRODUCT, zhou_document_id: DOC, zhou_record_version: 4 };
	const legacy = old(fields);
	const verified = remote(fields.zhou_source_id);
	const oldUnmarked = [{ ...installed()[0]!, sourceId: fields.zhou_source_id }];
	const oldPrepared = { ...(await prepared()), sourceId: fields.zhou_source_id };
	blocks('ownership-unconfirmed', () => inspectBinding(oldUnmarked, note(), PRODUCT, legacy));
	blocks('ownership-unconfirmed', () => stagePreparedWrite(oldUnmarked, note(), legacy, oldPrepared));
	const confirmed = confirmLegacyBinding([], note(), PRODUCT, legacy, verified, contracts);
	assert.equal(inspectBinding(confirmed, note(), PRODUCT, legacy)?.documentId, DOC);
	assert.equal(confirmed[0]?.ownershipProof?.gvid, GVID);
	assert.equal(confirmed[0]?.ownershipProof?.sourceId, fields.zhou_source_id);
	for (const changed of [
		{ sourceId: 'another-source' }, { documentId: 'another-doc' },
		{ productId: 'another-product' }, { gvid: OTHER },
	]) blocks('invalid-record', () => readPublishBindings([{ ...confirmed[0]!, ...changed }]));
	const copied = [{ ...confirmed[0]!, ownershipProof: undefined }];
	blocks('ownership-unconfirmed', () => inspectBinding(copied, note(), PRODUCT, legacy));
});
test('one GVID cannot seize another GVID source or document in the same product', () => {
	const source = '55c49585-5c6b-4a6d-8af3-2189e19d4d33';
	const legacy = old({ zhou_source_id: source, zhou_product_id: PRODUCT,
		zhou_document_id: DOC, zhou_record_version: 4 });
	const owner = confirmLegacyBinding([], note(), PRODUCT, legacy, remote(source), contracts);
	const second = note('项目/另一篇.md', OTHER);
	blocks('binding-conflict', () => confirmLegacyBinding(owner, second, PRODUCT,
		legacy, remote(source), contracts));
	blocks('binding-conflict', () => readPublishBindings([...owner,
		{ ...owner[0]!, gvid: OTHER, pathHint: '项目/另一篇.md', ownershipProof: undefined }]));
	blocks('binding-conflict', () => readPublishBindings([...owner,
		{ ...owner[0]!, gvid: OTHER, sourceId: 'other-source', pathHint: '项目/另一篇.md', ownershipProof: undefined }]));
	blocks('binding-conflict', () => installVerifiedBinding(owner, second, PRODUCT, old(),
		remote(OTHER, PRODUCT, DOC), contracts));
	assert.equal(inspectBinding(owner, note(), PRODUCT, legacy)?.sourceId, source);
});
test('persist exact immutable pending; repeat click/change/retry cannot allocate a new operation', async () => {
	const p = await prepared();
	const a = installed();
	const staged = stagePreparedWrite(a, note(), old(), p);
	assert.equal(a[0]?.pending, null);
	assert.equal(staged[0]?.pending?.operationId, OP);
	assert.equal(staged[0]?.pending?.payloadHash, p.payloadHash);
	assert.equal(staged[0]?.pending?.sourceRevision, HASH);
	assert.equal(staged[0]?.pending?.expectedRecordVersion, 4);
	blocks('pending-unconfirmed', () => stagePreparedWrite(staged, note(), old(), p));
	blocks('pending-unconfirmed', () => stagePreparedWrite(staged, note(), old(), awaitOther()));
	function awaitOther() { return { ...p, operationId: '00000000-0000-4000-8000-000000000022' }; }
	assert.equal(mayRetryOriginal(staged, note(), old(), p,
		{ userRequested: false, serverIdempotencyVerified: true }), false);
	assert.equal(mayRetryOriginal(staged, note(), old(), p,
		{ userRequested: true, serverIdempotencyVerified: false }), false);
	assert.equal(mayRetryOriginal(staged, note(), old(), p,
		{ userRequested: true, serverIdempotencyVerified: true }), true);
	assert.equal(mayRetryOriginal(staged, note(), old(), { ...p, title: 'different', payloadHash: 'f'.repeat(64) },
		{ userRequested: true, serverIdempotencyVerified: true }), false);
	assert.equal(mayRetryOriginal(staged, note(), old(), { ...p, sourceId: 'forged-source' },
		{ userRequested: true, serverIdempotencyVerified: true }), false);
});
test('prepared request must match bound product, expected version and server source', async () => {
	const a = installed();
	const p = await prepared();
	for (const changed of [
		{ sourceId: 'wrong' }, { recordVersion: 3 }, { documentId: 'other-doc' },
		{ payloadHash: 'bad' }, { operationId: 'not-uuid' },
	]) blocks('operation-mismatch', () => stagePreparedWrite(a, note(), old(), { ...p, ...changed }));
});
test('local abort before transport releases only its exact pending; a new explicit operation may stage', async () => {
	const p = await prepared('publish');
	const before = installed();
	const staged = stagePreparedWrite(before, note(), old(), p);
	const original = JSON.stringify(before);
	const attempt = {
		operationId: p.operationId, action: p.action, payloadHash: p.payloadHash,
		sourceRevision: p.sourceRevision, sourceId: p.sourceId, productId: p.productId,
		documentId: p.documentId, recordVersion: p.recordVersion,
	};
	// The owning workflow proves no sendWrite/transport has been invoked.
	const cleared = releaseDefinitelyNotSentWrite(staged, note(), old(), p,
		{ kind: 'aborted-before-transport', transportInvoked: false, attempt });
	assert.equal(cleared[0]?.pending, null);
	assert.deepEqual({ ...cleared[0], pending: null }, before[0]);
	assert.equal(JSON.stringify(before), original);
	assert.equal(staged[0]?.pending?.operationId, p.operationId);
	const next = await prepared('publish', '00000000-0000-4000-8000-000000000061');
	const restaged = stagePreparedWrite(cleared, note(), old(), next);
	assert.equal(restaged[0]?.pending?.operationId, next.operationId);
	blocks('pending-unconfirmed', () => releaseDefinitelyNotSentWrite(cleared, note(), old(), p,
		{ kind: 'aborted-before-transport', transportInvoked: false, attempt }));
});

test('actual client not-sent before transport can clear the matching original staged request', async () => {
	const p = await prepared('sync');
	const staged = stagePreparedWrite(installed(), note(), old(), p);
	let transportCalls = 0;
	const client = new ZhouyouClient(
		'https://example.test/api/producer-documents/obsidian-sync',
		async () => null,
		async () => { transportCalls++; throw Error('transport should not be invoked'); },
	);
	const result = await client.sendWrite(p);
	assert.equal(result.kind, 'not-sent');
	assert.equal(transportCalls, 0);
	if (result.kind !== 'not-sent') throw Error('Expected local not-sent');
	const attempt = {
		operationId: p.operationId, action: p.action, payloadHash: p.payloadHash,
		sourceRevision: p.sourceRevision, sourceId: p.sourceId, productId: p.productId,
		documentId: p.documentId, recordVersion: p.recordVersion,
	};
	const cleared = releaseDefinitelyNotSentWrite(staged, note(), old(), p,
		{ kind: 'send-write-not-sent', result, attempt });
	assert.equal(cleared[0]?.pending, null);
	assert.equal(cleared[0]?.recordVersion, 4);
	assert.equal(cleared[0]?.currentVersionNo, 2);
});

test('unknown, transmitted, forged or incomplete evidence never unlocks an unresolved publish', async () => {
	const p = await prepared('publish');
	const staged = stagePreparedWrite(installed(), note(), old(), p);
	const original = JSON.stringify(staged);
	const attempt = {
		operationId: p.operationId, action: p.action, payloadHash: p.payloadHash,
		sourceRevision: p.sourceRevision, sourceId: p.sourceId, productId: p.productId,
		documentId: p.documentId, recordVersion: p.recordVersion,
	};
	const abort = { kind: 'aborted-before-transport', transportInvoked: false, attempt } as const;
	const invalid = [
		null, {}, { kind: 'aborted-before-transport', attempt },
		{ ...abort, transportInvoked: true },
		{ kind: 'send-write-not-sent', attempt },
		{ kind: 'send-write-not-sent', attempt, result: { kind: 'unknown', reason: 'transport-failure' } },
		{ kind: 'send-write-not-sent', attempt, result: { kind: 'unknown', reason: 'server-failure' } },
		{ kind: 'send-write-not-sent', attempt, result: { kind: 'rejected', reason: 'http-rejection' } },
		{ kind: 'send-write-not-sent', attempt, result: { kind: 'rejected', reason: 'authorization' } },
		{ kind: 'send-write-not-sent', attempt, result: { kind: 'conflict', reason: 'record-version-conflict' } },
		{ kind: 'send-write-not-sent', attempt, result: { kind: 'acknowledged', data: {} } },
		{ kind: 'send-write-not-sent', attempt, result: { kind: 'not-sent', reason: 'server-confirmed' } },
	] as unknown[];
	for (const evidence of invalid) blocks('pending-unconfirmed', () =>
		releaseDefinitelyNotSentWrite(staged, note(), old(), p, evidence as never));
	for (const changed of [
		{ operationId: '00000000-0000-4000-8000-000000000062' },
		{ action: 'sync' }, { payloadHash: 'f'.repeat(64) }, { sourceRevision: 'f'.repeat(64) },
		{ sourceId: 'other-source' }, { productId: 'other-product' },
		{ documentId: 'other-document' }, { recordVersion: 3 },
	]) blocks('operation-mismatch', () => releaseDefinitelyNotSentWrite(staged, note(), old(), p,
		{ ...abort, attempt: { ...attempt, ...changed } } as never));
	for (const changed of [
		{ operationId: '00000000-0000-4000-8000-000000000063' },
		{ action: 'sync' }, { payloadHash: 'f'.repeat(64) }, { sourceRevision: 'f'.repeat(64) },
		{ sourceId: 'other-source' }, { productId: 'other-product' },
		{ documentId: 'other-document' }, { recordVersion: 3 },
	]) blocks('productId' in changed ? 'product-isolation' : 'operation-mismatch', () => releaseDefinitelyNotSentWrite(staged, note(), old(),
		{ ...p, ...changed } as never, abort));
	for (const altered of [
		{ recordVersion: 5 }, { documentId: 'other-document' },
		{ contentHash: 'f'.repeat(64) }, { currentVersionNo: 3 },
		{ pending: { ...staged[0]!.pending!, businessVersionBefore: 1 } },
		{ pending: { ...staged[0]!.pending!, contentHashBefore: 'f'.repeat(64) } },
	]) blocks('operation-mismatch', () => releaseDefinitelyNotSentWrite(
		[{ ...staged[0]!, ...altered }], note(), old(), p, abort));
	const acknowledged = recordAckCandidate(staged, note(), old(), PRODUCT, OP,
		{ documentId: DOC, recordVersion: 5, currentVersionNo: 3 });
	blocks('pending-unconfirmed', () => releaseDefinitelyNotSentWrite(acknowledged, note(), old(), p, abort));
	blocks('pending-unconfirmed', () => releaseDefinitelyNotSentWrite(
		[{ ...staged[0]!, pending: null }], note(), old(), p, abort));
	blocks('source-duplicate', () => releaseDefinitelyNotSentWrite(staged,
		{ ...note(), identity: 'duplicate' }, old(), p, abort));
	blocks('legacy-pending', () => releaseDefinitelyNotSentWrite(staged, note(),
		old({ zhou_source_id: SRC, zhou_product_id: PRODUCT,
			zhou_document_id: DOC, zhou_record_version: 4,
			zhou_operation_id: OP, zhou_operation_hash: HASH,
			zhou_operation_document_id: DOC, zhou_operation_record_version: 4 }), p, abort));
	assert.equal(JSON.stringify(staged), original);
});
test('ACK remains only candidate; unknown or conflict does not erase pending or modify history', async () => {
	const p = await prepared('publish');
	const a = stagePreparedWrite(installed(), note(), old(), p);
	const acked = recordAckCandidate(a, note(), old(), PRODUCT, OP,
		{ documentId: DOC, recordVersion: 5, currentVersionNo: 3 });
	assert.equal(acked[0]?.recordVersion, 4);
	assert.equal(acked[0]?.currentVersionNo, 2);
	assert.equal(acked[0]?.pending?.operationId, OP);
	assert.deepEqual(a[0]?.pending?.ackCandidate, null);
	blocks('operation-mismatch', () => recordAckCandidate(a, note(), old(), PRODUCT, OP,
		{ documentId: 'other-doc', recordVersion: 5, currentVersionNo: 3 }));
	blocks('operation-mismatch', () => recordAckCandidate(a, note(), old(), PRODUCT, 'new-op',
		{ documentId: DOC, recordVersion: 5, currentVersionNo: 3 }));
	blocks('binding-conflict', () => recordAckCandidate(acked, note(), old(), PRODUCT, OP,
		{ documentId: DOC, recordVersion: 6, currentVersionNo: 3 }));
});
test('read-current manual recovery hashes server bytes and updates baseline only; unknown publish stays blocked', async () => {
	const p = await prepared('publish');
	const a = stagePreparedWrite(installed(), note(), old(), p);
	const current = {
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 5,
		title: '文章', content: 'abc', contentHash: HASH, currentVersionNo: 3,
		documentStatus: 'active' as const,
	};
	const checked = await verifyReadCurrent(current);
	const b = reconcileReadOnly(a, note(), old(), PRODUCT, checked,
		{ userAccepted: true, accountUnchanged: true });
	assert.equal(b[0]?.recordVersion, 5);
	assert.equal(b[0]?.contentHash, HASH);
	assert.equal(b[0]?.pending?.operationId, OP);
	blocks('pending-unconfirmed', () => stagePreparedWrite(b, note(), old(), p));
	await blocksAsync('remote-unverified', () => verifyReadCurrent(
		{ ...current, contentHash: 'f'.repeat(64) }));
	blocks('remote-unverified', () => reconcileReadOnly(a, note(), old(), PRODUCT,
		current as typeof checked, { userAccepted: true, accountUnchanged: true }));
	blocks('remote-unverified', () => reconcileReadOnly(a, note(), old(), PRODUCT,
		checked, { userAccepted: false, accountUnchanged: true }));
	const wrongProduct = await verifyReadCurrent({ ...current, productId: 'another-product' });
	blocks('binding-conflict', () => reconcileReadOnly(a, note(), old(), PRODUCT,
		wrongProduct, { userAccepted: true, accountUnchanged: true }));
});
test('only exact independently verified operation history resolves unknown publish; no content/version shortcut', async () => {
	const p = await prepared('publish');
	const a = stagePreparedWrite(installed(), note(), old(), p);
	const proof = {
		evidence: 'independent-operation-history' as const,
		operationId: OP, action: 'publish' as const,
		payloadHash: p.payloadHash, sourceRevision: HASH,
		sourceId: SRC, productId: PRODUCT, documentId: DOC,
		recordVersion: 5, currentVersionNo: 3,
	};
	blocks('history-unverified', () => resolveFromOperationHistory(a, note(), old(),
		{ ...proof, evidence: 'mere-matching-content' as typeof proof.evidence }));
	blocks('operation-mismatch', () => resolveFromOperationHistory(a, note(), old(),
		{ ...proof, operationId: '00000000-0000-4000-8000-000000000077' }));
	blocks('operation-mismatch', () => resolveFromOperationHistory(a, note(), old(),
		{ ...proof, payloadHash: 'f'.repeat(64) }));
	blocks('history-unverified', () => resolveFromOperationHistory(a, note(), old(),
		{ ...proof, currentVersionNo: 2 }));
	const b = resolveFromOperationHistory(a, note(), old(), proof);
	assert.equal(a[0]?.pending?.operationId, OP);
	assert.equal(b[0]?.pending, null);
	assert.equal(b[0]?.recordVersion, 5);
	assert.equal(b[0]?.currentVersionNo, 3);
	assert.equal(b[0]?.contentHash, HASH);
});
test('serial JSON shape stores no credential, URL or source body', async () => {
	const p = await prepared('publish');
	const staged = stagePreparedWrite(installed(), note(), old(), p);
	const text = JSON.stringify(staged);
	assert.ok(!text.includes('Bearer'));
	assert.ok(!text.includes('https://'));
	assert.ok(!text.includes('更新了剧情'));
	assert.ok(!text.includes('"content":"abc"'));
	assert.deepEqual(readPublishBindings(JSON.parse(text)), staged);
	assert.equal(await sha256Utf8('abc'), HASH);
});
test('sync cannot be silently acknowledged as a new business release', async () => {
	const p = await prepared('sync');
	const a = stagePreparedWrite(installed(), note(), old(), p);
	const proof = {
		evidence: 'independent-operation-history' as const,
		operationId: OP, action: 'sync' as const, payloadHash: p.payloadHash,
		sourceRevision: HASH, sourceId: SRC, productId: PRODUCT,
		documentId: DOC, recordVersion: 5, currentVersionNo: 3,
	};
	blocks('history-unverified', () => resolveFromOperationHistory(a, note(), old(), proof));
	assert.equal(resolveFromOperationHistory(a, note(), old(), { ...proof, currentVersionNo: 2 })[0]?.pending, null);
});

test('unchanged legacy snapshot: first verified publish, next sync and next publish use advanced binding only', async () => {
	const originalFields = Object.freeze({
		zhou_source_id: SRC, zhou_product_id: PRODUCT,
		zhou_document_id: DOC, zhou_record_version: 4,
	});
	const legacy = old(originalFields);
	const source = note();
	const originalSource = JSON.stringify({ source, fields: originalFields });
	const gates = { accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true };
	const bound = installVerifiedBinding([], source, PRODUCT, legacy, remote(), contracts);
	assert.equal(inspectBinding(bound, source, PRODUCT, legacy)?.recordVersion, 4);
	const first = await prepared('publish');
	const firstPending = recordAckCandidate(
		stagePreparedWrite(bound, source, legacy, first), source, legacy, PRODUCT, OP,
		{ documentId: DOC, recordVersion: 5, currentVersionNo: 3 },
	);
	const firstRead = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 5,
		content: 'abc', contentHash: HASH, title: '文章',
		currentVersionNo: 3, documentStatus: 'active',
	});
	const afterFirst = completeAcknowledgedWrite(firstPending, source, legacy, first, firstRead, gates);
	assert.equal(afterFirst[0]?.pending, null);
	assert.equal(inspectBinding(afterFirst, source, PRODUCT, legacy)?.recordVersion, 5);
	const second = await prepareZhouyouWrite({
		action: 'sync', sourceId: SRC, productId: PRODUCT, documentId: DOC,
		recordVersion: 5, title: '文章', content: 'abc', changeSummary: '',
		operationId: '00000000-0000-4000-8000-000000000052',
	});
	const secondPending = recordAckCandidate(
		stagePreparedWrite(afterFirst, source, legacy, second), source, legacy, PRODUCT,
		second.operationId, { documentId: DOC, recordVersion: 6, currentVersionNo: 3 },
	);
	const secondRead = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 6,
		content: 'abc', contentHash: HASH, title: '文章',
		currentVersionNo: 3, documentStatus: 'active',
	});
	const afterSecond = completeAcknowledgedWrite(secondPending, source, legacy, second, secondRead, gates);
	assert.equal(afterSecond[0]?.pending, null);
	assert.equal(afterSecond[0]?.recordVersion, 6);
	const third = await prepareZhouyouWrite({
		action: 'publish', sourceId: SRC, productId: PRODUCT, documentId: DOC,
		recordVersion: 6, title: '文章', content: 'abc', changeSummary: '下一次明确发布',
		operationId: '00000000-0000-4000-8000-000000000053',
	});
	const thirdPending = recordAckCandidate(
		stagePreparedWrite(afterSecond, source, legacy, third), source, legacy, PRODUCT,
		third.operationId, { documentId: DOC, recordVersion: 7, currentVersionNo: 4 },
	);
	const thirdRead = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 7,
		content: 'abc', contentHash: HASH, title: '文章',
		currentVersionNo: 4, documentStatus: 'active',
	});
	const afterThird = completeAcknowledgedWrite(thirdPending, source, legacy, third, thirdRead, gates);
	assert.equal(afterThird[0]?.pending, null);
	assert.equal(afterThird[0]?.recordVersion, 7);
	assert.equal(afterThird[0]?.currentVersionNo, 4);
	assert.equal(inspectBinding(afterThird, source, PRODUCT, legacy)?.recordVersion, 7);
	assert.equal(bound[0]?.recordVersion, 4);
	assert.equal(JSON.stringify({ source, fields: originalFields }), originalSource);
});

test('historical legacy cannot contradict identity, document, pending or newer source version', () => {
	const fields = {
		zhou_source_id: SRC, zhou_product_id: PRODUCT,
		zhou_document_id: DOC, zhou_record_version: 4,
	};
	const bound = installVerifiedBinding([], note(), PRODUCT, old(fields), remote(), contracts);
	const advanced = [{ ...bound[0]!, recordVersion: 5 }];
	assert.equal(inspectBinding(advanced, note(), PRODUCT, old(fields))?.recordVersion, 5);
	assert.equal(installVerifiedBinding([], note(), PRODUCT, old(fields),
		{ ...remote(), recordVersion: 5 }, contracts)[0]?.recordVersion, 5);
	blocks('legacy-conflict', () => inspectBinding(advanced, note(), PRODUCT,
		old({ ...fields, zhou_source_id: 'another-source' })));
	blocks('legacy-conflict', () => inspectBinding(advanced, note(), PRODUCT,
		old({ ...fields, zhou_product_id: 'another-product' })));
	blocks('legacy-conflict', () => inspectBinding(advanced, note(), PRODUCT,
		old({ ...fields, zhou_document_id: 'another-document' })));
	blocks('legacy-conflict', () => inspectBinding(advanced, note(), PRODUCT,
		old({ ...fields, zhou_record_version: 6 })));
	blocks('legacy-conflict', () => inspectBinding(bound, note(), PRODUCT,
		old({ ...fields, zhou_record_version: 5 })));
	blocks('binding-conflict', () => installVerifiedBinding(advanced, note(), PRODUCT, old(fields),
		remote(), contracts));
	blocks('legacy-invalid', () => inspectBinding(advanced, note(), PRODUCT,
		old({ ...fields, zhou_record_version: -1 })));
	blocks('legacy-invalid', () => inspectBinding(advanced, note(), PRODUCT,
		old({ ...fields, zhou_operation_id: OP })));
	blocks('legacy-pending', () => inspectBinding(advanced, note(), PRODUCT,
		old({ ...fields, zhou_operation_id: OP, zhou_operation_hash: HASH,
			zhou_operation_record_version: 4, zhou_operation_document_id: DOC })));
});

test('legacy with no document remains historical after verified first sync creates one', async () => {
	const fields = Object.freeze({ zhou_source_id: SRC, zhou_product_id: PRODUCT });
	const legacy = old(fields);
	const createdFromAbsent = installVerifiedBinding([], note(), PRODUCT, legacy,
		remote(SRC, PRODUCT, null), contracts);
	const write = await prepareZhouyouWrite({
		action: 'sync', sourceId: SRC, productId: PRODUCT,
		documentId: null, recordVersion: null, title: '文章', content: 'abc',
		changeSummary: '', operationId: '00000000-0000-4000-8000-000000000054',
	});
	const received = recordAckCandidate(stagePreparedWrite(createdFromAbsent, note(), legacy, write),
		note(), legacy, PRODUCT, write.operationId,
		{ documentId: 'created-doc', recordVersion: 1, currentVersionNo: 0 });
	const checked = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: 'created-doc', recordVersion: 1,
		content: 'abc', contentHash: HASH, title: '文章',
		currentVersionNo: 0, documentStatus: 'active',
	});
	const completed = completeAcknowledgedWrite(received, note(), legacy, write, checked,
		{ accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true });
	assert.equal(inspectBinding(completed, note(), PRODUCT, legacy)?.documentId, 'created-doc');
	assert.equal(completed[0]?.pending, null);
	assert.deepEqual(fields, { zhou_source_id: SRC, zhou_product_id: PRODUCT });
});

test('normal sync: matching ACK plus independent verified read completes and permits a later sync', async () => {
	const p = await prepared('sync');
	const baseline = installed();
	const staged = stagePreparedWrite(baseline, note(), old(), p);
	assert.equal(staged[0]?.pending?.contentHashBefore, HASH);
	const received = recordAckCandidate(staged, note(), old(), PRODUCT, p.operationId,
		{ documentId: DOC, recordVersion: 5 });
	const readback = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 5,
		contentHash: HASH, title: '文章', content: 'abc',
		currentVersionNo: 2, documentStatus: 'active',
	});
	const gates = { accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true };
	const completed = completeAcknowledgedWrite(received, note(), old(), p, readback, gates);
	assert.equal(completed[0]?.pending, null);
	assert.equal(completed[0]?.recordVersion, 5);
	assert.equal(completed[0]?.contentHash, HASH);
	assert.equal(completed[0]?.currentVersionNo, 2);
	assert.equal(baseline[0]?.recordVersion, 4);
	assert.equal(received[0]?.pending?.operationId, OP);
	const followup = await prepareZhouyouWrite({
		action: 'sync', sourceId: SRC, productId: PRODUCT,
		documentId: DOC, recordVersion: 5, title: '文章',
		content: 'abc', changeSummary: '',
		operationId: '00000000-0000-4000-8000-000000000033',
	});
	assert.equal(stagePreparedWrite(completed, note(), old(), followup)[0]?.pending?.operationId, followup.operationId);
});
test('normal publish: verified ACK and server read V3 resolve pending without any historical API', async () => {
	const p = await prepared('publish');
	const baseline = installed();
	const staged = stagePreparedWrite(baseline, note(), old(), p);
	const received = recordAckCandidate(staged, note(), old(), PRODUCT, OP,
		{ documentId: DOC, recordVersion: 5, currentVersionNo: 3 });
	const checked = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC,
		recordVersion: 5, content: 'abc', contentHash: HASH,
		title: '文章', currentVersionNo: 3, documentStatus: 'active',
	});
	const completed = completeAcknowledgedWrite(received, note(), old(), p, checked,
		{ accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true });
	assert.equal(completed[0]?.pending, null);
	assert.equal(completed[0]?.recordVersion, 5);
	assert.equal(completed[0]?.currentVersionNo, 3);
	const later = await prepareZhouyouWrite({
		action: 'publish', sourceId: SRC, productId: PRODUCT,
		documentId: DOC, recordVersion: 5, title: '文章',
		content: 'abc', changeSummary: '下一个版本',
		operationId: '00000000-0000-4000-8000-000000000034',
	});
	assert.equal(stagePreparedWrite(completed, note(), old(), later)[0]?.pending?.businessVersionBefore, 3);
	assert.equal(staged[0]?.pending?.ackCandidate, null);
});
test('idempotent already-applied ACK is the SAME write, not a second business release', async () => {
	const p = await prepared('publish');
	const staged = stagePreparedWrite(installed(), note(), old(), p);
	assert.equal(mayRetryOriginal(staged, note(), old(), p,
		{ userRequested: true, serverIdempotencyVerified: true }), true);
	const replay = recordAckCandidate(staged, note(), old(), PRODUCT, OP,
		{ documentId: DOC, recordVersion: 5, currentVersionNo: 3, outcome: 'already-applied' });
	const current = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 5,
		title: '文章', content: 'abc', contentHash: HASH,
		currentVersionNo: 3, documentStatus: 'active',
	});
	const completed = completeAcknowledgedWrite(replay, note(), old(), p, current,
		{ accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true });
	assert.equal(completed[0]?.pending, null);
	assert.equal(completed[0]?.currentVersionNo, 3);
});
test('no ACK: even same body, higher record and publish version cannot clear unknown pending', async () => {
	const p = await prepared('publish');
	const staged = stagePreparedWrite(installed(), note(), old(), p);
	const readback = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 5,
		title: '文章', content: 'abc', contentHash: HASH,
		currentVersionNo: 3, documentStatus: 'active',
	});
	const gates = { accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true };
	blocks('pending-unconfirmed', () => completeAcknowledgedWrite(staged, note(), old(), p, readback, gates));
	const recovered = reconcileReadOnly(staged, note(), old(), PRODUCT, readback,
		{ userAccepted: true, accountUnchanged: true });
	assert.equal(recovered[0]?.pending?.operationId, OP);
	blocks('pending-unconfirmed', () => completeAcknowledgedWrite(recovered, note(), old(), p, readback, gates));
	blocks('pending-unconfirmed', () => stagePreparedWrite(recovered, note(), old(), p));
});
test('wrong ACK or read_current identity/version/hash blocks, old pending and baseline retained', async () => {
	const p = await prepared('publish');
	const staged = stagePreparedWrite(installed(), note(), old(), p);
	blocks('operation-mismatch', () => recordAckCandidate(staged, note(), old(), PRODUCT,
		'00000000-0000-4000-8000-000000000099',
		{ documentId: DOC, recordVersion: 5, currentVersionNo: 3 }));
	blocks('operation-mismatch', () => recordAckCandidate(staged, note(), old(), PRODUCT,
		OP, { documentId: 'other-doc', recordVersion: 5, currentVersionNo: 3 }));
	const received = recordAckCandidate(staged, note(), old(), PRODUCT, OP,
		{ documentId: DOC, recordVersion: 5, currentVersionNo: 3 });
	const data = {
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 5,
		title: '文章', content: 'abc', contentHash: HASH,
		currentVersionNo: 3, documentStatus: 'active' as const,
	};
	const gates = { accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true };
	for (const wrong of [
		{ sourceId: 'foreign-source' }, { productId: 'other-product' },
		{ documentId: 'foreign-doc' }, { recordVersion: 6 },
		{ currentVersionNo: 4 }, { currentVersionNo: 2 },
	]) {
		const snapshot = await verifyReadCurrent({ ...data, ...wrong });
		blocks('binding-conflict', () => completeAcknowledgedWrite(received, note(), old(), p, snapshot, gates));
	}
	const otherHash = await sha256Utf8('different');
	const changed = await verifyReadCurrent({ ...data, content: 'different', contentHash: otherHash });
	blocks('binding-conflict', () => completeAcknowledgedWrite(received, note(), old(), p, changed, gates));
	await blocksAsync('remote-unverified', () => verifyReadCurrent({ ...data, content: 'changed but wrong hash' }));
	assert.equal(received[0]?.pending?.operationId, OP);
	assert.equal(received[0]?.recordVersion, 4);
});
test('stale original prepared operation, manually advanced baseline and unverified session fail closed', async () => {
	const p = await prepared('publish');
	const staged = stagePreparedWrite(installed(), note(), old(), p);
	const received = recordAckCandidate(staged, note(), old(), PRODUCT, OP,
		{ documentId: DOC, recordVersion: 5, currentVersionNo: 3 });
	const checked = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 5,
		title: '文章', content: 'abc', contentHash: HASH,
		currentVersionNo: 3, documentStatus: 'active',
	});
	const gates = { accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true };
	for (const changed of [
		{ operationId: '00000000-0000-4000-8000-000000000077' },
		{ payloadHash: 'f'.repeat(64) },
		{ sourceRevision: 'f'.repeat(64) },
		{ sourceId: 'other-source' }, { recordVersion: 3 }, { documentId: 'wrong-doc' },
	]) blocks('operation-mismatch', () => completeAcknowledgedWrite(
		received, note(), old(), { ...p, ...changed }, checked, gates));
	for (const disabled of [
		{ accountAndEndpointUnchanged: false },
		{ sourceAndRequestUnchanged: false },
		{ independentServerRead: false },
	]) blocks('remote-unverified', () => completeAcknowledgedWrite(received, note(), old(), p,
		checked, { ...gates, ...disabled }));
	const manuallyRecovered = reconcileReadOnly(received, note(), old(), PRODUCT, checked,
		{ userAccepted: true, accountUnchanged: true });
	assert.equal(manuallyRecovered[0]?.pending?.ackCandidate?.recordVersion, 5);
	blocks('operation-mismatch', () => completeAcknowledgedWrite(manuallyRecovered, note(), old(), p, checked, gates));
	blocks('remote-unverified', () => completeAcknowledgedWrite(received, note(), old(), p,
		{ ...checked, contentHash: 'f'.repeat(64) }, gates));
	assert.equal(received[0]?.recordVersion, 4);
});
test('sync cannot claim a business release; first confirmed creation sync only accepts V0', async () => {
	const p = await prepared('sync');
	const staged = stagePreparedWrite(installed(), note(), old(), p);
	const received = recordAckCandidate(staged, note(), old(), PRODUCT, OP,
		{ documentId: DOC, recordVersion: 5 });
	const current = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 5,
		title: '文章', content: 'abc', contentHash: HASH,
		currentVersionNo: 3, documentStatus: 'active',
	});
	const gates = { accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true };
	blocks('history-unverified', () => completeAcknowledgedWrite(received, note(), old(), p, current, gates));
	const fresh = installVerifiedBinding([], note(), PRODUCT, old(), remote(SRC, PRODUCT, null), contracts);
	const newOperation = '00000000-0000-4000-8000-000000000045';
	const firstWrite = await prepareZhouyouWrite({
		action: 'sync', sourceId: SRC, productId: PRODUCT,
		documentId: null, recordVersion: null, title: '文章',
		content: 'abc', changeSummary: '', operationId: newOperation,
	});
	const awaiting = stagePreparedWrite(fresh, note(), old(), firstWrite);
	const receivedFirst = recordAckCandidate(awaiting, note(), old(), PRODUCT, newOperation,
		{ documentId: 'created-doc', recordVersion: 1, currentVersionNo: 0 });
	const firstRead = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: 'created-doc',
		recordVersion: 1, title: '文章', content: 'abc', contentHash: HASH,
		currentVersionNo: 0, documentStatus: 'active',
	});
	const done = completeAcknowledgedWrite(receivedFirst, note(), old(), firstWrite, firstRead, gates);
	assert.equal(done[0]?.documentId, 'created-doc');
	assert.equal(done[0]?.recordVersion, 1);
	assert.equal(done[0]?.currentVersionNo, 0);
	assert.equal(done[0]?.pending, null);
});

test('normal ACK/readback must not hide skipped business versions or unversioned changed sync', async () => {
	const gates = { accountAndEndpointUnchanged: true, sourceAndRequestUnchanged: true, independentServerRead: true };
	const publish = await prepared('publish');
	const pubPending = recordAckCandidate(stagePreparedWrite(installed(), note(), old(), publish),
		note(), old(), PRODUCT, OP, { documentId: DOC, recordVersion: 6, currentVersionNo: 4 });
	const skipped = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 6,
		content: 'abc', contentHash: HASH, title: '文章', currentVersionNo: 4,
		documentStatus: 'active',
	});
	blocks('history-unverified', () => completeAcknowledgedWrite(pubPending, note(), old(), publish, skipped, gates));
	const modified = await prepareZhouyouWrite({
		action: 'sync', sourceId: SRC, productId: PRODUCT,
		documentId: DOC, recordVersion: 4, title: '文章',
		content: 'updated', changeSummary: '', operationId: OP,
	});
	const syncPending = recordAckCandidate(stagePreparedWrite(installed(), note(), old(), modified),
		note(), old(), PRODUCT, OP, { documentId: DOC, recordVersion: 4, currentVersionNo: 2 });
	const unversioned = await verifyReadCurrent({
		sourceId: SRC, productId: PRODUCT, documentId: DOC, recordVersion: 4,
		content: 'updated', contentHash: await sha256Utf8('updated'),
		title: '文章', currentVersionNo: 2, documentStatus: 'active',
	});
	blocks('binding-conflict', () => completeAcknowledgedWrite(syncPending, note(), old(), modified, unversioned, gates));
});
