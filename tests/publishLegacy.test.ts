import assert from 'node:assert/strict';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';
import { observeLegacyForCurrentNote } from '../src/publishLegacy.ts';
import type { LegacyRuntimePort, NativeLegacyPath } from '../src/publishLegacy.ts';
import { BindingBlocked, inspectBinding, installVerifiedBinding } from '../src/publishBindings.ts';

const CURRENT = '项目/示例.md';
const ORIGINAL = '项目/原名.md';
const CONFIG = '.obsidian/plugins/zhouyou-producer-sync/data.json';
const OLD_SOURCE_V4 = '55c49585-5c6b-4a6d-8af3-2189e19d4d33';
const DOC = 'doc-existing-12';
const PRODUCT = 'game-1';
const HASH = 'a'.repeat(64);
const OP = '00000000-0000-4000-8000-000000000021';
const relation = {
	zhou_source_id: OLD_SOURCE_V4, zhou_product_id: PRODUCT,
	zhou_document_id: DOC, zhou_record_version: 4,
};
const note = (frontmatter: unknown = {}, path = CURRENT) => ({ path, frontmatter });
function fixture(options: {
	absent?: boolean; json?: string; renamed?: string[];
	paths?: Record<string, NativeLegacyPath>; provenDifferent?: boolean;
	fail?: 'exists' | 'read' | 'index';
} = {}) {
	const calls: string[] = [];
	const files = options.paths ?? {};
	const port: LegacyRuntimePort = {
		configDir: '.obsidian',
		verifiedRenamedFrom: options.renamed ?? [],
		unrelatedOrphansProven: options.provenDifferent,
		async existsConfigFile(path) {
			calls.push('exists:' + path);
			if (options.fail === 'exists') throw Error('private secret in diagnostic');
			assert.equal(path, CONFIG);
			return options.absent !== true;
		},
		async readConfigFile(path) {
			calls.push('read:' + path);
			if (options.fail === 'read') throw Error('private secret in diagnostic');
			assert.equal(path, CONFIG);
			return options.json ?? JSON.stringify({ noteBindings: {} });
		},
		async nativePath(path) {
			calls.push('index:' + path);
			if (options.fail === 'index') throw Error('private secret in diagnostic');
			return path === CURRENT ? 'current-file' : files[path] ?? 'absent';
		},
	};
	return { port, calls };
}
const jsonWithBindings = (bindings: Record<string, unknown>) => JSON.stringify({
	token: 'FAKE_SENTINEL_PRIVATE_TOKEN_123',
	syncUrl: 'https://fiction.invalid/private-address',
	privateSetting: { anotherKey: 'FAKE_SENTINEL_NESTED_456' },
	noteBindings: bindings,
});
function assertSafe(obs: Awaited<ReturnType<typeof observeLegacyForCurrentNote>>) {
	assert.ok(Object.keys(obs).every(key => ['fields', 'inventory', 'origin', 'candidatePath', 'unresolvedOrphan'].includes(key)));
	const serialized = JSON.stringify(obs);
	assert.doesNotMatch(serialized, /FAKE_SENTINEL|private-address|privateSetting|syncUrl|token/iu);
}
function rejects(reason: string, fn: () => unknown) {
	assert.throws(fn, (err: unknown) => err instanceof BindingBlocked && err.reason === reason);
}
test('verified absent plugin and valid empty inventory: no secret or write IO', async () => {
	const missing = fixture({ absent: true });
	const found = await observeLegacyForCurrentNote(note(), missing.port);
	assert.deepEqual(found, { inventory: 'checked', fields: {}, origin: 'none' });
	assert.deepEqual(missing.calls, ['index:' + CURRENT, 'exists:' + CONFIG]);
	const empty = fixture({ json: jsonWithBindings({}) });
	assert.deepEqual(await observeLegacyForCurrentNote(note(), empty.port), found);
	assert.deepEqual(empty.calls, ['index:' + CURRENT, 'exists:' + CONFIG, 'read:' + CONFIG]);
	assertSafe(found);
});
test('exact current-path old relation from private whitelist, retaining UUIDv4 source and version', async () => {
	const fx = fixture({ json: jsonWithBindings({ [CURRENT]: { ...relation, localOther: 'FAKE_SENTINEL_EXTRA_7' } }) });
	const obs = await observeLegacyForCurrentNote(note(), fx.port);
	assert.deepEqual(obs, { inventory: 'checked', fields: relation,
		origin: 'path-only', candidatePath: CURRENT });
	assertSafe(obs);
	const remote = {
		evidence: 'server-verified-existing' as const, sourceId: OLD_SOURCE_V4, productId: PRODUCT,
		documentId: DOC, recordVersion: 4, contentHash: HASH, currentVersionNo: 2,
	};
	const current = { gvid: uuidv7(), path: CURRENT, identity: 'verified' as const, pathProof: 'unverified' as const };
	rejects('legacy-conflict', () => inspectBinding([], current, PRODUCT, obs));
	rejects('ownership-unconfirmed', () => installVerifiedBinding([], current, PRODUCT, obs, remote,
		{ stableSourceVerified: true, atomicFirstCreateVerified: true, multiProductVerified: false }));
});
test('frontmatter-only legacy and exact matching private data; contradictions fail closed', async () => {
	const noPrivate = fixture({ absent: true });
	const front = await observeLegacyForCurrentNote(note(relation), noPrivate.port);
	assert.deepEqual(front, { inventory: 'checked', fields: relation, origin: 'note-fields' });
	const agree = fixture({ json: jsonWithBindings({ [CURRENT]: relation }) });
	assert.deepEqual(await observeLegacyForCurrentNote(note(relation), agree.port),
		{ inventory: 'checked', fields: relation, origin: 'path-only', candidatePath: CURRENT });
	const conflict = fixture({ json: jsonWithBindings({
		[CURRENT]: { ...relation, zhou_product_id: 'another-game' },
	}) });
	const result = await observeLegacyForCurrentNote(note(relation), conflict.port);
	assert.equal(result.inventory, 'unknown');
	assertSafe(result);
	const partial = fixture({ json: jsonWithBindings({ [CURRENT]: { zhou_source_id: OLD_SOURCE_V4 } }) });
	const partialObs = await observeLegacyForCurrentNote(note(), partial.port);
	assert.equal(partialObs.inventory, 'checked');
	rejects('legacy-invalid', () => inspectBinding([], {
		gvid: uuidv7(), path: CURRENT, identity: 'verified', pathProof: 'unverified',
	}, PRODUCT, partialObs));
});
test('old pending is not cleared or converted to a fresh relationship', async () => {
	const fx = fixture({ json: jsonWithBindings({
		[CURRENT]: { ...relation, zhou_operation_id: OP, zhou_operation_hash: HASH,
			zhou_operation_record_version: 4, zhou_operation_document_id: DOC },
	}) });
	const obs = await observeLegacyForCurrentNote(note(), fx.port);
	assertSafe(obs);
	assert.equal(obs.inventory, 'checked');
	rejects('legacy-pending', () => inspectBinding([], {
		gvid: uuidv7(), path: CURRENT, identity: 'verified', pathProof: 'unverified',
	}, PRODUCT, obs));
});
test('missing, corrupt, invalid private config and inaccessible native evidence remain unknown', async () => {
	for (const opts of [
		{ fail: 'read' as const }, { fail: 'exists' as const }, { fail: 'index' as const },
		{ json: '{ broken' }, { json: '[]' }, { json: '{"noteBindings":[]}' },
		{ json: jsonWithBindings({ [CURRENT]: { zhou_source_id: { forbidden: 'FAKE_SENTINEL' } } }) },
		{ json: jsonWithBindings({ '../escape': relation }) },
	]) {
		const fx = fixture(opts);
		const obs = await observeLegacyForCurrentNote(note(), fx.port);
		assert.deepEqual(obs, { inventory: 'unknown', fields: {} });
		assertSafe(obs);
	}
});
test('same TFile proven rename uses orphaned old-path record, never guesses name/content/gvid', async () => {
	const proven = fixture({
		json: jsonWithBindings({ [ORIGINAL]: relation }),
		renamed: [ORIGINAL], paths: { [ORIGINAL]: 'absent' },
	});
	const obs = await observeLegacyForCurrentNote(note(), proven.port);
	assert.deepEqual(obs, { inventory: 'checked', fields: relation,
		origin: 'native-rename-hint', candidatePath: ORIGINAL });
	assertSafe(obs);
	const unproven = fixture({ json: jsonWithBindings({ [ORIGINAL]: relation }) });
	assert.deepEqual(await observeLegacyForCurrentNote(note(), unproven.port),
		{ inventory: 'checked', fields: {}, origin: 'none', unresolvedOrphan: true });
	const reused = fixture({
		json: jsonWithBindings({ [ORIGINAL]: relation }),
		renamed: [ORIGINAL], paths: { [ORIGINAL]: 'other-file' },
	});
	assert.equal((await observeLegacyForCurrentNote(note(), reused.port)).inventory, 'unknown');
});
test('orphan ambiguity blocks only without independent native exclusion; other live files do not block fresh notes', async () => {
	const raw = jsonWithBindings({ [ORIGINAL]: relation });
	const ambiguous = fixture({ json: raw });
	assert.deepEqual(await observeLegacyForCurrentNote(note(), ambiguous.port),
		{ inventory: 'checked', fields: {}, origin: 'none', unresolvedOrphan: true });
	const excluded = fixture({ json: raw, provenDifferent: true });
	assert.deepEqual(await observeLegacyForCurrentNote(note(), excluded.port),
		{ inventory: 'checked', fields: {}, origin: 'none' });
	const indexedOther = fixture({ json: raw, paths: { [ORIGINAL]: 'other-file' } });
	assert.deepEqual(await observeLegacyForCurrentNote(note(), indexedOther.port),
		{ inventory: 'checked', fields: {}, origin: 'none' });
	const collision = fixture({ json: raw, paths: { [ORIGINAL]: 'other-file' } });
	assert.equal((await observeLegacyForCurrentNote(note({ zhou_source_id: OLD_SOURCE_V4 }),
		collision.port)).inventory, 'unknown');
});
test('an exact-path entry cannot hide another old path with the same source/product', async () => {
	const copied = fixture({
		json: jsonWithBindings({
			[CURRENT]: relation,
			[ORIGINAL]: { ...relation, zhou_document_id: 'different-doc' },
		}),
		paths: { [ORIGINAL]: 'other-file' },
	});
	assert.deepEqual(await observeLegacyForCurrentNote(note(), copied.port),
		{ inventory: 'unknown', fields: {} });
});
test('ambiguous duplicate rename bindings, private/fm conflicts and improper paths never yield checked', async () => {
	const first = fixture({ json: jsonWithBindings({
		[CURRENT]: relation, [ORIGINAL]: relation,
	}), renamed: [ORIGINAL] });
	assert.equal((await observeLegacyForCurrentNote(note(), first.port)).inventory, 'unknown');
	const two = fixture({ json: jsonWithBindings({
		[ORIGINAL]: relation, '项目/更旧名.md': relation,
	}), renamed: [ORIGINAL, '项目/更旧名.md'] });
	assert.equal((await observeLegacyForCurrentNote(note(), two.port)).inventory, 'unknown');
	const badPath = fixture({ json: jsonWithBindings({ [CURRENT]: relation }) });
	assert.equal((await observeLegacyForCurrentNote(note({}, '../unsafe.md'), badPath.port)).inventory, 'unknown');
});
