import assert from 'node:assert/strict';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';
import { PublishSettings } from '../src/publishSettings.ts';
import { build } from 'esbuild';
// Runtime Node strip-types does not resolve extensionless production imports.
// Bundle the actual production entry using the existing build tool, without writing files.
const built = await build({ entryPoints: ['src/publishWorkflow.ts'], bundle: true,
	platform: 'node', format: 'esm', write: false });
const workflowModule = await import('data:text/javascript;base64,' +
	Buffer.from(built.outputFiles[0]!.contents).toString('base64'));
const { PublishWorkflow, recordNativeRename, matchesNativeRename, resolveExistingRemoteByRead } = workflowModule;
import { installVerifiedBinding, inspectBinding, confirmLegacyBinding } from '../src/publishBindings.ts';
import { observeLegacyForCurrentNote } from '../src/publishLegacy.ts';
import { ZhouyouClient, sha256Utf8 } from '../src/zhouyouClient.ts';
import type { PublishDocumentContext } from '../src/documentActions.ts';
import type { WorkflowObservation, WorkflowPorts } from '../src/publishWorkflow.ts';

const URL = 'https://example.test/api/producer-documents/obsidian-sync';
const PRODUCT = 'game-1';
const FILE = '故事/文章.md';
function intent(action: 'sync' | 'publish' = 'sync') {
	return { sourcePath: FILE, productId: PRODUCT, action,
		changeSummary: action === 'publish' ? '第一版剧情已完成' : '' };
}
async function harness(options: { firstSaveFails?: boolean; preset?: boolean; minimumAck?: boolean; writesAllowed?: boolean; resolveThroughApi?: boolean } = {}) {
	const gvid = uuidv7();
	const file = { path: FILE };
	let valid = true;
	let content = 'abc';
	let epoch = 1;
	let credential: string | null = 'fake-key-not-real';
	let available = true;
	let remoteContent = 'abc';
	let recordVersion = options.preset === false ? 0 : 4;
	let businessVersion = options.preset === false ? 0 : 2;
	let sourceIdentity: 'verified' | 'duplicate' | 'unknown' = 'verified';
	let renameVerified = false;
	let delivery: 'normal' | 'unknown' | 'bad-read' | 'rejected' = 'normal';
	let releaseList: Promise<void> | null = null;
	let sent = 0;
	let changes = 0;
	let failed = false;
	let afterStageSaved: (() => void) | null = null;
	let afterApplied: (() => void) | null = null;
	let keyCalls = 0;
	let missingKeyOnCall = 0;
	let disk: Record<string, unknown> = { oldSetting: { keep: 'yes' }, publishShortcut: true };
	const hash = await sha256Utf8(remoteContent);
	if (options.preset !== false) {
		disk.publishBindings = installVerifiedBinding([], {
			gvid, path: FILE, identity: 'verified', pathProof: 'unverified',
		}, PRODUCT, { inventory: 'checked', fields: {} }, {
			evidence: 'server-verified-existing', sourceId: gvid,
			productId: PRODUCT, documentId: 'doc-1',
			recordVersion, contentHash: hash, currentVersionNo: businessVersion,
		}, { stableSourceVerified: true, atomicFirstCreateVerified: true, multiProductVerified: false });
	}
	const settings = new PublishSettings({
		loadData: async () => structuredClone(disk),
		saveData: async data => {
			if (options.firstSaveFails && !failed) {
				failed = true;
				throw new Error('fake persistence failure');
			}
			disk = structuredClone(data);
			changes++;
			const rows = data.publishBindings as Array<{ pending?: { ackCandidate: unknown } | null }> | undefined;
			if (afterStageSaved && rows?.[0]?.pending && rows[0].pending.ackCandidate === null) {
				const callback = afterStageSaved;
				afterStageSaved = null;
				callback();
			}
		},
	});
	await settings.load();
	await settings.setZhouyouUrl(URL);
	// Simulate the normal installed configuration, using no actual SecretStorage.
	const ctx = { file, view: {}, leaf: {}, isCurrent: () => valid } as unknown as PublishDocumentContext;
	const obs = (): WorkflowObservation => ({
		note: { gvid, path: file.path, identity: sourceIdentity,
			pathProof: renameVerified ? 'same-file-rename' : 'unverified' },
		legacy: { inventory: 'checked', fields: {} }, content, title: '文章',
	});
	const ports: WorkflowPorts = {
		writePermitted: () => options.writesAllowed !== false,
		availability: () => available ? 'ready' : 'key-unconfigured',
		credentialIdentity: () => String(epoch),
		observe: async () => obs(),
		client: endpoint => new ZhouyouClient(endpoint, () => {
			keyCalls++;
			return missingKeyOnCall === keyCalls ? null : credential;
		}, async request => {
			const payload = JSON.parse(request.body) as Record<string, unknown>;
			if (payload.action === 'list_products') {
				if (releaseList) await releaseList;
				return { status: 200, body: { code: 0, data: { products: [{ id: PRODUCT, name: '游戏一' }] } } };
			}
			if (payload.action === 'read_current') {
				if (recordVersion === 0) return { status: 404, body: { code: 'PRODUCER_DOCUMENT_NOT_FOUND' } };
				return { status: 200, body: { code: 0, data: {
					sourceId: gvid, productId: PRODUCT, documentId: 'doc-1', title: '文章',
					content: delivery === 'bad-read' && sent ? 'other text' : remoteContent,
					contentHash: await sha256Utf8(remoteContent),
					recordVersion, documentStatus: 'active', currentVersionNo: businessVersion,
				} } };
			}
			if (payload.action === 'sync' || payload.action === 'publish') {
				sent++;
				if (delivery === 'unknown') throw new Error('fake timeout');
				if (delivery === 'rejected') return { status: 403, body: { code: 1 } };
				remoteContent = String(payload.content);
				recordVersion++;
				if (payload.action === 'publish') businessVersion++;
				afterApplied?.();
				return { status: 200, body: { code: 0, data: {
					...(options.minimumAck ? {} : {
						sourceId: gvid, productId: PRODUCT, operationId: payload.operationId,
						contentHash: await sha256Utf8(remoteContent), documentStatus: 'active',
					}),
					documentId: 'doc-1', recordVersion,
					...(payload.action === 'publish' ? { currentVersionNo: businessVersion } : {}),
				} } };
			}
			throw new Error('invalid fake action');
		}),
	};
	if (options.preset === false) {
		ports.resolveRemote = async (observation, productId) => ({
			evidence: recordVersion === 0 ? 'server-verified-absent' : 'server-verified-existing',
			sourceId: observation.note.gvid as string, productId,
			documentId: recordVersion === 0 ? null : 'doc-1',
			recordVersion: recordVersion === 0 ? null : recordVersion,
			contentHash: recordVersion === 0 ? null : await sha256Utf8(remoteContent),
			currentVersionNo: recordVersion === 0 ? null : businessVersion,
		});
		ports.contracts = () => ({
			stableSourceVerified: true, atomicFirstCreateVerified: true, multiProductVerified: false,
		});
	}
	if (options.resolveThroughApi) ports.resolveRemote = (observation, productId) =>
		resolveExistingRemoteByRead(observation, productId, ports.client(URL));
	const workflow = new PublishWorkflow(settings, ports);
	return {
		workflow, settings, ctx, file, gvid,
		disk: () => structuredClone(disk), sent: () => sent, changes: () => changes,
		record: () => recordVersion, business: () => businessVersion,
		changeContent: (value: string) => { content = value; },
		setValid: (value: boolean) => { valid = value; },
		rotate: () => { epoch++; },
		setCredential: (value: string | null) => { credential = value; epoch++; available = value !== null; },
		setDelivery: (value: typeof delivery) => { delivery = value; },
		setRemoteVersion: (value: number) => { recordVersion = value; },
		onStageSaved: (callback: () => void) => { afterStageSaved = callback; },
		onRemoteApplied: (callback: () => void) => { afterApplied = callback; },
		withholdKeyOnCall: (number: number) => { missingKeyOnCall = number; },
		setSourceIdentity: (value: typeof sourceIdentity) => { sourceIdentity = value; },
		setRenamed: (value: boolean) => { renameVerified = value; },
		setReleaseList: (value: Promise<void> | null) => { releaseList = value; },
	};
}
test('two normal syncs retain the same document and business version; settings and queue survive', async () => {
	const h = await harness();
	h.changeContent('abc changed');
	for (let i = 0; i < 2; i++) {
		const result = await h.workflow.submit(h.ctx, intent());
		assert.equal(result.kind, 'verified');
		assert.equal(h.disk().publishBindings?.[0]?.pending, null);
	}
	assert.equal(h.sent(), 2);
	assert.equal(h.record(), 6);
	assert.equal(h.business(), 2);
	assert.equal(h.disk().oldSetting?.keep, 'yes');
	assert.equal(h.disk().publishShortcut, true);
	assert.equal(h.disk().publishBindings?.[0]?.documentId, 'doc-1');
});
test('one explicitly described business publication advances exactly one version', async () => {
	const h = await harness();
	const result = await h.workflow.submit(h.ctx, intent('publish'));
	assert.equal(result.kind, 'verified');
	if (result.kind === 'verified') {
		assert.equal(result.action, 'publish');
		if (result.action === 'publish') assert.equal(result.publishedVersionNo, 3);
	}
	assert.equal(h.business(), 3);
	assert.equal(h.sent(), 1);
	assert.equal(h.disk().publishBindings?.[0]?.currentVersionNo, 3);
	assert.equal(h.disk().publishBindings?.[0]?.pending, null);
});
test('simultaneous same-file dialogs acquire one synchronous lock', async () => {
	const h = await harness();
	let release!: () => void;
	h.setReleaseList(new Promise<void>(resolve => { release = resolve; }));
	const a = h.workflow.submit(h.ctx, intent('publish'));
	const b = await h.workflow.submit(h.ctx, intent('publish'));
	assert.equal(b.kind, 'conflict');
	release();
	assert.equal((await a).kind, 'verified');
	assert.equal(h.sent(), 1);
});
test('editing file or changing credential identity during authorization prevents send', async () => {
	for (const mutation of ['source', 'credential'] as const) {
		const h = await harness();
		let release!: () => void;
		h.setReleaseList(new Promise<void>(resolve => { release = resolve; }));
		const pending = h.workflow.submit(h.ctx, intent());
		await new Promise<void>(resolve => setImmediate(resolve)); // list_products is now blocked
		if (mutation === 'source') h.changeContent('new text');
		else h.rotate();
		release();
		assert.equal((await pending).kind, 'not-sent');
		assert.equal(h.sent(), 0);
		assert.equal(h.disk().publishBindings?.[0]?.pending, null);
	}
});
test('unknown timeout preserves original pending and blocks a second new ID', async () => {
	const h = await harness();
	h.setDelivery('unknown');
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'unknown');
	const state = h.disk().publishBindings?.[0]?.pending;
	assert.equal(typeof state.operationId, 'string');
	assert.equal(state.action, 'publish');
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'unknown');
	assert.equal(h.sent(), 1);
	const review = await h.workflow.review(h.ctx, PRODUCT);
	assert.equal(review.cleared, false);
	assert.equal(h.disk().publishBindings?.[0]?.pending?.operationId, state.operationId);
});
test('matched ACK with invalid independent remote hash does not falsely complete', async () => {
	const h = await harness();
	h.setDelivery('bad-read');
	const result = await h.workflow.submit(h.ctx, intent('publish'));
	assert.equal(result.kind, 'acknowledged');
	assert.equal(h.sent(), 1);
	assert.notEqual(h.disk().publishBindings?.[0]?.pending, null);
	assert.equal(h.disk().publishBindings?.[0]?.pending?.ackCandidate?.currentVersionNo, 3);
});
test('remote CAS drift, absent credential and stopped workflow never dispatch body', async () => {
	const conflict = await harness();
	conflict.setRemoteVersion(5);
	assert.equal((await conflict.workflow.submit(conflict.ctx, intent())).kind, 'conflict');
	assert.equal(conflict.sent(), 0);
	const noKey = await harness();
	noKey.setCredential(null);
	assert.equal((await noKey.workflow.submit(noKey.ctx, intent())).kind, 'not-sent');
	assert.equal(noKey.sent(), 0);
	const stopped = await harness();
	stopped.workflow.stop();
	assert.equal((await stopped.workflow.submit(stopped.ctx, intent())).kind, 'not-sent');
	assert.equal(stopped.sent(), 0);
});
test('settings queue save error before staging does not send or mutate binding', async () => {
	// Use a queue adapter whose save fails on the *first workflow persistence*.
	const h = await harness();
	const before = h.disk();
	let calls = 0;
	const faulty = new PublishSettings({
		loadData: async () => before,
		saveData: async () => { calls++; throw new Error('fake disk failure'); },
	});
	await faulty.load();
	const broken = new PublishWorkflow(faulty, {
		availability: () => 'ready', credentialIdentity: () => 'fake',
		observe: async () => ({
			note: { gvid: h.gvid, path: FILE, identity: 'verified', pathProof: 'unverified' },
			legacy: { inventory: 'checked', fields: {} }, content: 'abc', title: '文章',
		}),
		client: () => new ZhouyouClient(URL, () => 'fake-key-not-real', async request => {
			const action = (JSON.parse(request.body) as Record<string, unknown>).action;
			if (action === 'list_products') return { status: 200, body: { code: 0, data: { products: [{ id: PRODUCT, name: '游戏一' }] } } };
			if (action === 'read_current') return { status: 200, body: { code: 0, data: {
				sourceId: h.gvid, productId: PRODUCT, documentId: 'doc-1', recordVersion: 4,
				title: '文章', content: 'abc', contentHash: await sha256Utf8('abc'),
				documentStatus: 'active', currentVersionNo: 2 } } };
			throw Error('body must not be sent');
		}),
	});
	// URL is read from persisted settings and the original harness saved it.
	assert.equal((await broken.submit(h.ctx, intent())).kind, 'not-sent');
	assert.equal(calls, 1);
	assert.equal(broken.availability(), 'ready');
});
test('dialog reads pure remote state without sending a document or increasing business version', async () => {
	const h = await harness();
	assert.equal((await h.workflow.listProducts()).kind, 'acknowledged');
	const status = await h.workflow.readStatus(h.ctx, PRODUCT);
	assert.equal(status.kind, 'linked');
	assert.equal(h.sent(), 0);
	assert.equal(h.business(), 2);
});
test('source copies, unknown legacy inventory and path substitution are blocked before send', async () => {
	const h = await harness();
	h.file.path = '故事/副本.md';
	assert.equal((await h.workflow.submit(h.ctx, intent())).kind, 'not-sent');
	assert.equal(h.sent(), 0);
});

test('fake proven-absent first sync creates one mapping with V0; explicit publish becomes V1', async () => {
	const h = await harness({ preset: false });
	assert.equal((await h.workflow.readStatus(h.ctx, PRODUCT)).kind, 'unlinked');
	assert.equal(h.sent(), 0);
	assert.equal((await h.workflow.submit(h.ctx, intent('sync'))).kind, 'verified');
	assert.equal(h.record(), 1);
	assert.equal(h.business(), 0);
	assert.equal(h.disk().publishBindings?.[0]?.documentId, 'doc-1');
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'verified');
	assert.equal(h.business(), 1);
	assert.equal(h.disk().publishBindings?.[0]?.pending, null);
});

test('production API resolver: first sync, edited sync and explicit publish retain one document', async () => {
	const h = await harness({ preset: false, resolveThroughApi: true });
	assert.equal((await h.workflow.readStatus(h.ctx, PRODUCT)).kind, 'unlinked');
	assert.equal(h.sent(), 0);
	assert.equal((await h.workflow.submit(h.ctx, intent())).kind, 'verified');
	h.changeContent('第二稿');
	assert.equal((await h.workflow.submit(h.ctx, intent())).kind, 'verified');
	assert.equal(h.business(), 0);
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'verified');
	assert.equal(h.business(), 1);
	assert.equal(h.record(), 3);
	const bindings = h.disk().publishBindings as Array<{ documentId: string; sourceId: string; pending: unknown }>;
	assert.equal(bindings.length, 1);
	assert.equal(bindings[0]!.documentId, 'doc-1');
	assert.equal(bindings[0]!.sourceId, h.gvid);
	assert.equal(bindings[0]!.pending, null);
});
test('an observed same-file rename retains source and mapping; an unproven copy is refused', async () => {
	const h = await harness();
	h.file.path = '故事/改名.md';
	h.setRenamed(true);
	const renamed = { ...intent(), sourcePath: h.file.path };
	assert.equal((await h.workflow.submit(h.ctx, renamed)).kind, 'verified');
	assert.equal(h.disk().publishBindings?.[0]?.pathHint, '故事/改名.md');
	assert.equal(h.disk().publishBindings?.[0]?.documentId, 'doc-1');
	h.setSourceIdentity('duplicate');
	assert.equal((await h.workflow.submit(h.ctx, renamed)).kind, 'unknown');
	assert.equal(h.sent(), 1);
});

test('minimal documented ACK plus independent exact readback verifies sync and release', async () => {
	const h = await harness({ minimumAck: true });
	assert.equal((await h.workflow.submit(h.ctx, intent('sync'))).kind, 'verified');
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'verified');
	assert.equal(h.sent(), 2);
	assert.equal(h.business(), 3);
	assert.equal(h.disk().publishBindings?.[0]?.pending, null);
});
test('deployed write capability unknown blocks upload while permitting authorized product list/read', async () => {
	const h = await harness({ writesAllowed: false });
	assert.equal((await h.workflow.listProducts()).kind, 'acknowledged');
	assert.equal((await h.workflow.readStatus(h.ctx, PRODUCT)).kind, 'linked');
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'not-sent');
	assert.equal(h.sent(), 0);
	assert.equal(h.disk().publishBindings?.[0]?.pending, null);
});

test('staged source mutation before any write call clears only its own pending after saving', async () => {
	const h = await harness();
	h.onStageSaved(() => h.changeContent('new source'));
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'not-sent');
	assert.equal(h.sent(), 0);
	assert.equal(h.record(), 4);
	assert.equal(h.business(), 2);
	assert.equal(h.disk().publishBindings?.[0]?.pending, null);
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'verified');
	assert.equal(h.sent(), 1);
	assert.equal(h.business(), 3);
});
test('actual client local not-sent after persisted stage safely unlocks next explicit operation', async () => {
	const h = await harness();
	h.withholdKeyOnCall(3); // listProducts and readCurrent succeed; sendWrite credential is missing
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'not-sent');
	assert.equal(h.sent(), 0);
	assert.equal(h.disk().publishBindings?.[0]?.pending, null);
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'verified');
	assert.equal(h.sent(), 1);
	assert.equal(h.business(), 3);
});
test('rotation of same-reference credential after stage aborts before transport, and can retry', async () => {
	const h = await harness();
	h.onStageSaved(() => h.rotate());
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'not-sent');
	assert.equal(h.sent(), 0);
	assert.equal(h.disk().publishBindings?.[0]?.pending, null);
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'verified');
});
test('generic server rejection cannot be treated as definitely not sent', async () => {
	const h = await harness();
	h.setDelivery('rejected');
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'unknown');
	assert.equal(h.sent(), 1);
	const held = h.disk().publishBindings?.[0]?.pending;
	assert.equal(typeof held.operationId, 'string');
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'unknown');
	assert.equal(h.sent(), 1);
	assert.equal(h.disk().publishBindings?.[0]?.pending?.operationId, held.operationId);
});


/** Real module combination, but the reference adapter and HTTP are in-memory fakes. */
async function oldRelationFixture(
	options: { old?: 'valid' | 'pending' | 'partial' | 'different-product' | 'none' | 'unknown';
		remote?: 'valid' | 'wrong-source' | 'wrong-product' | 'wrong-doc' | 'wrong-hash'
			| 'higher-version' | 'lower-version' | 'not-found' | 'archived' } = {},
) {
	const oldType = options.old ?? 'valid';
	const remoteMode = options.remote ?? 'valid';
	const gvid = uuidv7();
	const oldSource = '00000000-0000-4000-8000-000000000001';
	const documentId = 'old-doc-1';
	const oldFields: Record<string, unknown> = {
		zhou_source_id: oldSource, zhou_document_id: documentId,
		zhou_product_id: oldType === 'different-product' ? 'other-product' : PRODUCT,
		zhou_record_version: 4,
	};
	if (oldType === 'pending') {
		oldFields.zhou_operation_id = '00000000-0000-4000-8000-000000000002';
		oldFields.zhou_operation_hash = 'a'.repeat(64);
		oldFields.zhou_operation_record_version = 4;
		oldFields.zhou_operation_document_id = documentId;
	}
	if (oldType === 'partial') delete oldFields.zhou_record_version;
	const fakeRaw = JSON.stringify({
		token: 'FAKE_PRIVATE_TOKEN_NEVER_EXPOSED', syncUrl: 'FAKE_OLD_URL',
		noteBindings: oldType === 'none' ? {} : { [FILE]: oldFields },
	});
	let configReads = 0;
	let remoteVersionOverride: number | null = null;
	let saveHold: Promise<void> | null = null;
	let saveEntered: (() => void) | null = null;
	const legacy = oldType === 'unknown' ? { inventory: 'unknown' as const, fields: {} }
		: await observeLegacyForCurrentNote({ path: FILE, frontmatter: {} }, {
			configDir: '.obsidian', verifiedRenamedFrom: [],
			existsConfigFile: async path =>
				path === '.obsidian/plugins/zhouyou-producer-sync/data.json',
			readConfigFile: async path => {
				assert.equal(path, '.obsidian/plugins/zhouyou-producer-sync/data.json');
				configReads++;
				return fakeRaw;
			},
			nativePath: async path => path === FILE ? 'current-file' : 'absent',
		});
	let saved: Record<string, unknown> = { existing: { keep: 'yes' }, publishShortcut: true };
	const settings = new PublishSettings({
		loadData: async () => structuredClone(saved),
		saveData: async value => {
			if (saveHold) { saveEntered?.(); await saveHold; saveHold = null; saveEntered = null; }
			saved = structuredClone(value);
		},
	});
	await settings.load();
	await settings.setZhouyouUrl(URL);
	const file = { path: FILE };
	let revision = 1;
	let localContent = 'abc';
	let editorContent = localContent;
	let localTitle = '文章';
	let credentialRevision = 1;
	const context = { file, view: { editor: { getValue: () => editorContent } },
		leaf: {}, isCurrent: () => true } as unknown as PublishDocumentContext;
	const queries: Array<Record<string, unknown>> = [];
	const client = () => new ZhouyouClient(URL, () => 'FAKE_NEW_DEVICE_KEY', async request => {
		const payload = JSON.parse(request.body) as Record<string, unknown>;
		if (payload.action === 'list_products') return { status: 200, body: { code: 0,
			data: { products: [{ id: PRODUCT, name: '游戏一' }] } } };
		queries.push(payload);
		if (payload.action !== 'read_current') throw Error('only fake read_current permitted');
		if (remoteMode === 'not-found') return { status: 404, body: { code: 'NOT_FOUND' } };
		const sourceId = String(payload.sourceId);
		const queriedDocumentId = sourceId === gvid ? 'new-gvid-doc' : documentId;
		const content = 'abc';
		return { status: 200, body: { code: 0, data: {
			sourceId: remoteMode === 'wrong-source' ? 'not-this-source' : sourceId,
			productId: remoteMode === 'wrong-product' ? 'not-this-product' : PRODUCT,
			documentId: remoteMode === 'wrong-doc' ? 'not-this-document' : queriedDocumentId,
			recordVersion: remoteVersionOverride ?? (remoteMode === 'higher-version' ? 5 : remoteMode === 'lower-version' ? 3 : 4),
			title: '文章', content,
			contentHash: remoteMode === 'wrong-hash' ? 'f'.repeat(64) : await sha256Utf8(content),
			documentStatus: remoteMode === 'archived' ? 'archived' : 'active', currentVersionNo: 2,
		} } };
	});
	const ports: WorkflowPorts = {
		availability: () => 'ready',
		credentialIdentity: () => String(credentialRevision),
		observe: async (_context: PublishDocumentContext, productId?: string) => ({
			note: { gvid, path: file.path, identity: 'verified' as const, pathProof: 'unverified' as const },
			legacy, title: localTitle, content: localContent, sourceRevision: String(revision),
		}),
		currentSourceRevision: () => String(revision),
		client: () => client(),
		resolveRemote: (observation: WorkflowObservation, productId: string) =>
			resolveExistingRemoteByRead(observation, productId, client()),
		contracts: () => ({ stableSourceVerified: true,
			atomicFirstCreateVerified: false, multiProductVerified: false }),
		writePermitted: () => false,
	};
	const workflow = new PublishWorkflow(settings, ports);
	return { workflow, settings, context, queries, gvid, oldSource, documentId,
		restart: () => new PublishWorkflow(settings, ports),
		legacy, configReads: () => configReads, disk: () => structuredClone(saved), fakeRaw,
		changeContent: (value: string) => { localContent = value; editorContent = value; revision++; },
		changeEditorOnly: (value: string) => { editorContent = value; },
		changeTitle: (value: string) => { localTitle = value; revision++; },
		rotate: () => { credentialRevision++; },
		changeRevision: () => { revision++; },
		setRemoteVersion: (value: number) => { remoteVersionOverride = value; },
		holdNextSave: (hold: Promise<void>, entered: () => void) => { saveHold = hold; saveEntered = entered; } };
}
test('old UUIDv4 path is only a read-only candidate until the user confirms its exact relation', async () => {
	const h = await oldRelationFixture();
	assert.equal(h.legacy.inventory, 'checked');
	assert.equal(h.configReads(), 1);
	const result = await h.workflow.readStatus(h.context, PRODUCT);
	assert.equal(result.kind, 'legacy-candidate');
	if (result.kind === 'legacy-candidate') {
		assert.equal(result.documentId, h.documentId);
		assert.equal(result.recordVersion, 4);
		assert.equal(result.currentVersionNo, 2);
		assert.equal(result.localContent, 'abc');
		assert.equal(result.remoteContent, 'abc');
		assert.equal(h.disk().publishBindings, undefined, 'opening a candidate never installs it');
		assert.equal((await h.workflow.confirmLegacy(h.context, PRODUCT, result.reviewId)).kind, 'linked');
	}
	assert.equal(h.queries.length, 3, 'candidate, fresh confirmation read, then linked status read');
	assert.deepEqual(h.queries[0], {
		action: 'read_current', sourceId: h.oldSource, productId: PRODUCT, documentId: h.documentId,
	});
	assert.equal(h.disk().publishBindings?.[0]?.sourceId, h.oldSource);
	assert.equal(h.disk().publishBindings?.[0]?.gvid, h.gvid);
	assert.equal(h.disk().publishBindings?.[0]?.documentId, h.documentId);
	assert.equal(h.disk().publishBindings?.[0]?.recordVersion, 4);
	assert.equal(h.disk().publishBindings?.[0]?.currentVersionNo, 2);
	assert.equal(h.disk().publishBindings?.[0]?.ownershipProof?.kind, 'legacy-user-confirmed');
	assert.equal(h.disk().existing?.keep, 'yes');
	assert.equal(JSON.stringify(h.disk()).includes('FAKE_PRIVATE_TOKEN_NEVER_EXPOSED'), false);
	assert.equal(JSON.stringify(h.disk()).includes('FAKE_OLD_URL'), false);
	assert.equal(h.fakeRaw.includes('FAKE_PRIVATE_TOKEN_NEVER_EXPOSED'), true);
	assert.equal((await h.workflow.readStatus(h.context, PRODUCT)).kind, 'linked');
	assert.equal(h.queries.length, 4, 'trusted GVKit binding reuses only its original remote ID');
	assert.equal((await h.workflow.submit(h.context, intent('publish'))).kind, 'not-sent');
	assert.equal(h.queries.length, 4, 'real writes remain gated off');
});
test('different body is still reviewable; cancel and new-document choice never claim the UUIDv4', async () => {
	const h = await oldRelationFixture();
	h.changeContent('这是新文件 B 的正文');
	const candidate = await h.workflow.readStatus(h.context, PRODUCT);
	assert.equal(candidate.kind, 'legacy-candidate');
	if (candidate.kind !== 'legacy-candidate') return;
	assert.notEqual(candidate.localContent, candidate.remoteContent);
	assert.equal(h.disk().publishBindings, undefined, 'cancel simply leaves the review unsubmitted');
	const beforeNewQueries = h.queries.length;
	const asNew = await h.workflow.readAsNewDocument(h.context, PRODUCT, candidate.reviewId);
	assert.equal(asNew.kind, 'linked', 'fake backend positively identifies a separate GVID document');
	assert.equal(h.queries[beforeNewQueries]?.sourceId, h.gvid);
	assert.equal(h.queries[beforeNewQueries]?.documentId, null);
	assert.ok(h.queries.slice(beforeNewQueries).every(query => query.sourceId === h.gvid));
	assert.equal(h.disk().publishBindings?.[0]?.sourceId, h.gvid);
	assert.equal(h.disk().publishBindings?.[0]?.documentId, 'new-gvid-doc');
	assert.notEqual(h.disk().publishBindings?.[0]?.documentId, h.documentId);
	const restarted = h.restart();
	const again = await restarted.readStatus(h.context, PRODUCT);
	assert.equal(again.kind, 'legacy-candidate', 'a new session rechecks the old claim');
	if (again.kind === 'legacy-candidate')
		assert.equal((await restarted.readAsNewDocument(h.context, PRODUCT, again.reviewId)).kind,
			'linked');
});
test('a displayed old candidate becomes stale after local, credential or remote changes', async () => {
	for (const change of ['content', 'title', 'revision', 'credential', 'remote'] as const) {
		const h = await oldRelationFixture();
		const candidate = await h.workflow.readStatus(h.context, PRODUCT);
		assert.equal(candidate.kind, 'legacy-candidate');
		if (candidate.kind !== 'legacy-candidate') continue;
		if (change === 'content') h.changeContent('new body');
		if (change === 'title') h.changeTitle('new title');
		if (change === 'revision') h.changeRevision();
		if (change === 'credential') h.rotate();
		if (change === 'remote') h.setRemoteVersion(5);
		assert.equal((await h.workflow.confirmLegacy(h.context, PRODUCT, candidate.reviewId)).kind,
			'unknown', change);
		assert.equal(h.disk().publishBindings, undefined, change);
	}
});
test('a queued old confirmation aborts if the native file revision changes while waiting', async () => {
	const h = await oldRelationFixture();
	const candidate = await h.workflow.readStatus(h.context, PRODUCT);
	assert.equal(candidate.kind, 'legacy-candidate');
	if (candidate.kind !== 'legacy-candidate') return;
	let release!: () => void;
	let entered!: () => void;
	const hold = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { entered = resolve; });
	h.holdNextSave(hold, entered);
	const earlier = h.settings.updateNonSecret(data => { data.unrelated = 'keep'; });
	await started;
	const confirming = h.workflow.confirmLegacy(h.context, PRODUCT, candidate.reviewId);
	for (let i = 0; i < 20 && h.queries.length < 2; i++)
		await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(h.queries.length, 2, 'fresh authorized remote read happened before queue entry');
	h.changeRevision();
	release();
	await earlier;
	assert.equal((await confirming).kind, 'unknown');
	assert.equal(h.disk().publishBindings, undefined);
});
test('queued old confirmation rejects unsaved editor changes at the final save callback', async () => {
	const h = await oldRelationFixture();
	const candidate = await h.workflow.readStatus(h.context, PRODUCT);
	assert.equal(candidate.kind, 'legacy-candidate');
	if (candidate.kind !== 'legacy-candidate') return;
	let release!: () => void;
	let entered!: () => void;
	let queued!: () => void;
	const hold = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { entered = resolve; });
	const confirmationQueued = new Promise<void>(resolve => { queued = resolve; });
	h.holdNextSave(hold, entered);
	const earlier = h.settings.updateNonSecret(data => { data.unrelated = 'keep'; });
	await started;
	const originalUpdate = h.settings.updateNonSecret.bind(h.settings);
	h.settings.updateNonSecret = change => { queued(); return originalUpdate(change); };
	const confirming = h.workflow.confirmLegacy(h.context, PRODUCT, candidate.reviewId);
	await confirmationQueued;
	assert.equal(h.queries.length, 2, 'fresh remote review finished before confirmation entered the queue');
	h.changeEditorOnly('unsaved editor body changed while queue waits');
	release();
	await earlier;
	const result = await confirming;
	assert.equal(h.disk().publishBindings, undefined, 'must not persist binding after editor change');
	assert.equal(result.kind, 'unknown');
});
test('queued old confirmation still saves once when the editor body is unchanged', async () => {
	const h = await oldRelationFixture();
	const candidate = await h.workflow.readStatus(h.context, PRODUCT);
	assert.equal(candidate.kind, 'legacy-candidate');
	if (candidate.kind !== 'legacy-candidate') return;
	let release!: () => void;
	let entered!: () => void;
	let queued!: () => void;
	const hold = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { entered = resolve; });
	const confirmationQueued = new Promise<void>(resolve => { queued = resolve; });
	h.holdNextSave(hold, entered);
	const earlier = h.settings.updateNonSecret(data => { data.unrelated = 'keep'; });
	await started;
	const originalUpdate = h.settings.updateNonSecret.bind(h.settings);
	h.settings.updateNonSecret = change => { queued(); return originalUpdate(change); };
	const confirming = h.workflow.confirmLegacy(h.context, PRODUCT, candidate.reviewId);
	await confirmationQueued;
	assert.equal(h.queries.length, 2);
	release();
	await earlier;
	assert.equal((await confirming).kind, 'linked');
	assert.equal(h.disk().publishBindings?.[0]?.ownershipProof?.kind, 'legacy-user-confirmed');
});
test('a prior trusted GVID keeps its source and document when another GVID confirms the same candidate', async () => {
	const h = await oldRelationFixture();
	const ownerGvid = uuidv7();
	const legacy = h.legacy;
	const owner = confirmLegacyBinding([], { gvid: ownerGvid, path: '项目/原主.md',
		identity: 'verified', pathProof: 'unverified' }, PRODUCT, legacy, {
			evidence: 'server-verified-existing', sourceId: h.oldSource, productId: PRODUCT,
			documentId: h.documentId, recordVersion: 4,
			contentHash: await sha256Utf8('abc'), currentVersionNo: 2,
		}, { stableSourceVerified: true, atomicFirstCreateVerified: false, multiProductVerified: false });
	await h.settings.updateNonSecret(data => { data.publishBindings = owner; });
	const candidate = await h.workflow.readStatus(h.context, PRODUCT);
	assert.equal(candidate.kind, 'legacy-candidate');
	if (candidate.kind !== 'legacy-candidate') return;
	assert.equal((await h.workflow.confirmLegacy(h.context, PRODUCT, candidate.reviewId)).kind, 'unknown');
	assert.deepEqual(h.disk().publishBindings, owner);
});
test('an old persisted UUIDv4 row without proof is reviewable but never silently upgraded', async () => {
	const h = await oldRelationFixture({ old: 'none' });
	const oldRow = { gvid: h.gvid, sourceId: h.oldSource, productId: PRODUCT,
		documentId: h.documentId, recordVersion: 4, contentHash: await sha256Utf8('abc'),
		currentVersionNo: 2, pathHint: FILE, pending: null };
	await h.settings.updateNonSecret(data => { data.publishBindings = [oldRow]; });
	const candidate = await h.workflow.readStatus(h.context, PRODUCT);
	assert.equal(candidate.kind, 'legacy-candidate');
	assert.deepEqual(h.disk().publishBindings?.[0], oldRow);
	if (candidate.kind !== 'legacy-candidate') return;
	const newLookupStart = h.queries.length;
	assert.equal((await h.workflow.readAsNewDocument(h.context, PRODUCT, candidate.reviewId)).kind,
		'unknown', 'the old unconfirmed row cannot be replaced by a GVID result');
	assert.ok(h.queries.slice(newLookupStart).every(query => query.sourceId === h.gvid));
	assert.deepEqual(h.disk().publishBindings?.[0], oldRow,
		'new GVID lookup must not overwrite the unconfirmed old row');
	const again = await h.workflow.readStatus(h.context, PRODUCT);
	assert.equal(again.kind, 'legacy-candidate');
	if (again.kind !== 'legacy-candidate') return;
	assert.equal((await h.workflow.confirmLegacy(h.context, PRODUCT, again.reviewId)).kind, 'linked');
	assert.equal(h.disk().publishBindings?.[0]?.ownershipProof?.kind, 'legacy-user-confirmed');
});
test('old invalid, different-product, pending and unknown inventories never authorize remote queries', async () => {
	for (const old of ['pending', 'partial', 'different-product', 'unknown'] as const) {
		const h = await oldRelationFixture({ old });
		assert.equal((await h.workflow.readStatus(h.context, PRODUCT)).kind, 'unknown', old);
		assert.equal(h.queries.length, 0, old);
		assert.equal(h.disk().publishBindings, undefined, old);
	}
});
test('incorrect remote identity, content hash, archive, version or unconfirmed absence never installs binding', async () => {
	for (const remote of [
		'wrong-source', 'wrong-product', 'wrong-doc', 'wrong-hash',
		'lower-version', 'not-found', 'archived',
	] as const) {
		const h = await oldRelationFixture({ remote });
		assert.equal((await h.workflow.readStatus(h.context, PRODUCT)).kind, 'unknown', remote);
		assert.equal(h.disk().publishBindings, undefined, remote);
		assert.equal(h.queries.length, 1, remote);
	}
});
test('verified old identity permits monotonic remote record update without losing original UUIDv4 source', async () => {
	const h = await oldRelationFixture({ remote: 'higher-version' });
	const candidate = await h.workflow.readStatus(h.context, PRODUCT);
	assert.equal(candidate.kind, 'legacy-candidate');
	if (candidate.kind === 'legacy-candidate')
		assert.equal((await h.workflow.confirmLegacy(h.context, PRODUCT, candidate.reviewId)).kind, 'linked');
	assert.equal(h.disk().publishBindings?.[0]?.sourceId, h.oldSource);
	assert.equal(h.disk().publishBindings?.[0]?.recordVersion, 5);
	assert.equal(h.disk().publishBindings?.[0]?.documentId, h.documentId);
});
test('no legacy relation may recover only positively identified existing gvid record; never infer absence from 404', async () => {
	const yes = await oldRelationFixture({ old: 'none' });
	assert.equal((await yes.workflow.readStatus(yes.context, PRODUCT)).kind, 'linked');
	assert.equal(yes.queries[0]?.sourceId, yes.gvid);
	assert.equal(yes.queries[0]?.documentId, null);
	assert.equal(yes.disk().publishBindings?.[0]?.sourceId, yes.gvid);
	const no = await oldRelationFixture({ old: 'none', remote: 'not-found' });
	assert.equal((await no.workflow.readStatus(no.context, PRODUCT)).kind, 'unknown');
	assert.equal(no.disk().publishBindings, undefined);
});
test('native same-TFile consecutive rename trail proves exact old hint only, not unrelated rename', async () => {
	const original = '故事/旧名.md';
	const middle = '故事/中间名.md';
	const current = '故事/现在名.md';
	const trail = recordNativeRename(recordNativeRename(undefined, original, middle), middle, current);
	assert.equal(matchesNativeRename(trail, current, original), true);
	assert.equal(matchesNativeRename(trail, current, middle), true);
	assert.equal(matchesNativeRename(trail, current, '故事/无关.md'), false);
	assert.equal(matchesNativeRename(trail, '故事/另一个.md', original), false);
	const interrupted = recordNativeRename(trail, '故事/无关.md', '故事/最终.md');
	assert.equal(matchesNativeRename(interrupted, '故事/最终.md', original), false);
	const gvid = uuidv7();
	const binding = installVerifiedBinding([], {
		gvid, path: original, identity: 'verified', pathProof: 'unverified',
	}, PRODUCT, { inventory: 'checked', fields: {} }, {
		evidence: 'server-verified-existing', sourceId: gvid, productId: PRODUCT,
		documentId: 'old-doc-1', recordVersion: 4, contentHash: await sha256Utf8('abc'), currentVersionNo: 2,
	}, { stableSourceVerified: true, atomicFirstCreateVerified: false, multiProductVerified: false });
	const note = { gvid, path: current, identity: 'verified' as const,
		pathProof: matchesNativeRename(trail, current, original) ? 'same-file-rename' as const : 'unverified' as const };
	assert.equal(inspectBinding(binding, note, PRODUCT, { inventory: 'checked', fields: {} })?.documentId, 'old-doc-1');
	assert.throws(() => inspectBinding(binding, { ...note, pathProof: 'unverified' }, PRODUCT,
		{ inventory: 'checked', fields: {} }));
	const reference = JSON.stringify({ noteBindings: {
		[original]: { zhou_source_id: 'old-v4', zhou_document_id: 'old-doc-1',
			zhou_product_id: PRODUCT, zhou_record_version: 4 },
	} });
	const legacy = await observeLegacyForCurrentNote({ path: current, frontmatter: {} }, {
		configDir: '.obsidian', verifiedRenamedFrom: trail.earlierPaths,
		existsConfigFile: async () => true, readConfigFile: async () => reference,
		nativePath: async path => path === current ? 'current-file' : 'absent',
	});
	assert.equal(legacy.inventory, 'checked');
	assert.equal((legacy.fields as Record<string, unknown>).zhou_source_id, 'old-v4');
	const bad = await observeLegacyForCurrentNote({ path: current, frontmatter: {} }, {
		configDir: '.obsidian', verifiedRenamedFrom: ['故事/无关.md'],
		existsConfigFile: async () => true, readConfigFile: async () => reference,
		nativePath: async path => path === current ? 'current-file' : 'absent',
	});
	assert.deepEqual(bad, { inventory: 'checked', fields: {}, origin: 'none', unresolvedOrphan: true });
});

test('credential rotation after an applied write cannot attach old ACK to the new account', async () => {
	const h = await harness();
	h.onRemoteApplied(() => h.rotate());
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'unknown');
	assert.equal(h.sent(), 1);
	assert.equal(h.business(), 3); // remote may have accepted it
	const pending = h.disk().publishBindings?.[0]?.pending;
	assert.ok(pending);
	assert.equal(pending.ackCandidate, null);
	assert.equal((await h.workflow.submit(h.ctx, intent('publish'))).kind, 'unknown');
	assert.equal(h.sent(), 1);
});
