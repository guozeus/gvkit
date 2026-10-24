import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import type { PublishDocumentContext } from '../src/documentActions.ts';
import type { ZhouyouProduct, ZhouyouResult } from '../src/zhouyouClient.ts';
import { ZhouyouDialogController } from '../src/publishDialog.ts';
import type { DialogRemoteStatus, DialogSubmitIntent, DialogSubmitResult, ZhouyouDialogHost } from '../src/publishDialog.ts';

function deferred<T>() {
	let resolve!: (result: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const PRODUCTS: ZhouyouProduct[] = [
	{ id: 'p1', name: '游戏一' }, { id: 'p2', name: '另一款产品（测试长选项）' },
];
function linked(): DialogRemoteStatus {
	return { kind: 'linked', documentId: 'doc1', recordVersion: 2, currentVersionNo: 3,
		documentStatus: 'active', remoteContent: '远端测试正文', localContent: '本地测试正文' };
}
function harness(options?: { availability?: 'ready' | 'key-unconfigured'; status?: DialogRemoteStatus }) {
	let path = '项目/游戏/设计.md';
	let current = true;
	let availability = options?.availability ?? 'ready';
	const events: string[] = [];
	const submits: DialogSubmitIntent[] = [];
	const source = {
		file: { get path() { return path; } },
		isCurrent: () => current,
	} as unknown as PublishDocumentContext;
	let list = async (): Promise<ZhouyouResult<ZhouyouProduct[]>> =>
		({ kind: 'acknowledged', data: PRODUCTS });
	let read = async (_id: string): Promise<DialogRemoteStatus> => options?.status ?? linked();
	let submit = async (intent: DialogSubmitIntent): Promise<DialogSubmitResult> => {
		submits.push(intent); return { kind: 'acknowledged' };
	};
	let review: ZhouyouDialogHost['reviewAfterUncertain'];
	const host: ZhouyouDialogHost = {
		availability: () => availability,
		listProducts: () => { events.push('list'); return list(); },
		readStatus: (productId) => { events.push('read:' + productId); return read(productId); },
		submit: (intent) => { events.push('submit:' + intent.action); return submit(intent); },
		reviewAfterUncertain: (productId, observed) => {
			events.push('review:' + productId);
			return review ? review(productId, observed) :
				Promise.resolve({ cleared: false, status: observed });
		},
	};
	let paints = 0;
	const controller = new ZhouyouDialogController(source, host, () => { paints++; });
	return { controller, events, submits, host, get paints() { return paints; },
		setPath(value: string) { path = value; }, setCurrent(value: boolean) { current = value; },
		setAvailability(value: typeof availability) { availability = value; },
		setList(value: typeof list) { list = value; },
		setRead(value: typeof read) { read = value; },
		setSubmit(value: typeof submit) { submit = value; },
		setReview(value: NonNullable<typeof review>) { review = value; },
	};
}
async function selected(h: ReturnType<typeof harness>, id = 'p1') {
	await h.controller.loadProducts();
	await h.controller.chooseProduct(id);
}

test('opening, product selection, status inquiry and cancel never dispatch a document body', async () => {
	const h = harness();
	await selected(h);
	assert.deepEqual(h.events, ['list', 'read:p1']);
	assert.equal(h.controller.snapshot().path, '项目/游戏/设计.md');
	assert.equal(h.controller.snapshot().remote?.kind, 'linked');
	assert.equal(h.controller.startConfirmation('sync'), true);
	assert.equal(h.controller.snapshot().confirmation?.action, 'sync');
	assert.equal(h.controller.startConfirmation('publish'), false, 'a pending confirmation cannot be silently changed');
	assert.equal(h.events.length, 2);
	h.controller.cancelConfirmation();
	assert.equal(h.controller.snapshot().confirmation, null);
	assert.equal(h.submits.length, 0);
	await h.controller.refreshStatus();
	assert.deepEqual(h.events, ['list', 'read:p1', 'read:p1']);
});
test('legacy candidate uses its own explicit choice and never calls the body submission action', async () => {
	const candidate: DialogRemoteStatus = { kind: 'legacy-candidate', reviewId: 17,
		sourcePath: '项目/游戏/设计.md', gvid: 'current-gvid', candidatePath: '项目/旧名.md',
		sourceId: 'old-source', productId: 'p1', documentId: 'old-doc',
		recordVersion: 4, currentVersionNo: 2, localTitle: '新标题', remoteTitle: '旧标题',
		localContent: '本地正文', remoteContent: '远端正文' };
	const h = harness({ status: candidate });
	let claimed = 0;
	let queriedNew = 0;
	h.host.confirmLegacy = async (productId, reviewId) => {
		assert.equal(productId, 'p1'); assert.equal(reviewId, 17); claimed++;
		return linked();
	};
	h.host.readAsNewDocument = async (productId, reviewId) => {
		assert.equal(productId, 'p1'); assert.equal(reviewId, 17); queriedNew++;
		return { kind: 'unlinked' };
	};
	await selected(h);
	assert.equal(h.controller.snapshot().remote?.kind, 'legacy-candidate');
	assert.equal(h.controller.startConfirmation('sync'), false);
	assert.equal(h.controller.startConfirmation('publish'), false);
	assert.equal(claimed, 0);
	await h.controller.chooseLegacy(false);
	assert.equal(queriedNew, 1);
	assert.equal(claimed, 0);
	assert.equal(h.submits.length, 0);
	assert.equal(h.controller.snapshot().remote?.kind, 'unlinked');
	await h.controller.refreshStatus();
	await h.controller.chooseLegacy(true);
	assert.equal(claimed, 1);
	assert.equal(h.submits.length, 0);
});

test('sync and publish remain distinct with a second explicit confirmation; summary mandatory for publish', async () => {
	const h = harness();
	await selected(h);
	assert.equal(h.controller.startConfirmation('publish'), false);
	assert.match(h.controller.snapshot().notice, /必须填写/);
	h.controller.setSummary('阶段验收准备');
	assert.equal(h.controller.startConfirmation('publish'), true);
	assert.equal(h.submits.length, 0);
	const before = h.controller.snapshot().confirmation;
	assert.equal(before?.productName, '游戏一');
	assert.equal(before?.sourcePath, '项目/游戏/设计.md');
	await h.controller.confirm();
	assert.deepEqual(h.submits, [{ sourcePath: '项目/游戏/设计.md',
		productId: 'p1', action: 'publish', changeSummary: '阶段验收准备' }]);
	assert.equal(h.controller.snapshot().remote, null, 'an ACK is not a verified publish-history state');
	assert.match(h.controller.snapshot().notice, /查询发布历史/);
	await h.controller.refreshStatus();
	assert.equal(h.controller.startConfirmation('sync'), true);
	await h.controller.confirm();
	assert.deepEqual(h.submits[1], { sourcePath: '项目/游戏/设计.md',
		productId: 'p1', action: 'sync', changeSummary: '' });
	assert.equal(h.submits.length, 2);
});

test('one in-flight submission locks repeat confirm, product switching and extra requests; finally unlocks', async () => {
	const h = harness();
	const pending = deferred<DialogSubmitResult>();
	h.setSubmit((intent) => { h.submits.push(intent); return pending.promise; });
	await selected(h);
	h.controller.startConfirmation('sync');
	const write = h.controller.confirm();
	assert.equal(h.controller.snapshot().phase, 'submitting');
	await h.controller.confirm();
	await h.controller.chooseProduct('p2');
	await h.controller.loadProducts();
	assert.equal(h.controller.startConfirmation('publish'), false);
	assert.equal(h.submits.length, 1);
	assert.equal(h.controller.snapshot().productId, 'p1');
	pending.resolve({ kind: 'rejected' });
	await write;
	assert.equal(h.controller.snapshot().phase, 'idle');
	assert.match(h.controller.snapshot().notice, /未获接受/);
	assert.equal(h.controller.startConfirmation('sync'), true);
});

test('stale earlier product response does not replace a newer selection', async () => {
	const h = harness();
	const pending = deferred<DialogRemoteStatus>();
	h.setRead((id) => id === 'p1' ? pending.promise : Promise.resolve({ kind: 'unlinked' }));
	await h.controller.loadProducts();
	const old = h.controller.chooseProduct('p1');
	const newer = h.controller.chooseProduct('p2');
	await newer;
	assert.equal(h.controller.snapshot().productId, 'p2');
	assert.equal(h.controller.snapshot().remote?.kind, 'unlinked');
	pending.resolve(linked());
	await old;
	assert.equal(h.controller.snapshot().productId, 'p2');
	assert.equal(h.controller.snapshot().remote?.kind, 'unlinked');
});

test('source path/view changes block confirmation and late results cannot authorize stale document', async () => {
	const h = harness();
	await selected(h);
	h.controller.startConfirmation('sync');
	h.setPath('项目/游戏/更名.md');
	await h.controller.confirm();
	assert.equal(h.submits.length, 0);
	assert.equal(h.controller.snapshot().sourceValid, false);
	const h2 = harness();
	const pending = deferred<DialogSubmitResult>();
	h2.setSubmit((intent) => { h2.submits.push(intent); return pending.promise; });
	await selected(h2);
	h2.controller.startConfirmation('sync');
	const write = h2.controller.confirm();
	h2.setCurrent(false);
	pending.resolve({ kind: 'acknowledged' });
	await write;
	assert.equal(h2.controller.snapshot().needsReview, true);
	assert.equal(h2.controller.snapshot().remote?.kind, 'unknown');
	assert.equal(h2.submits.length, 1);
});

test('conflict/unknown and thrown callback never become a success or an automatic retry', async () => {
	for (const outcome of ['conflict', 'unknown'] as const) {
		const h = harness();
		h.setSubmit(async (intent) => {
			h.submits.push(intent);
			return { kind: outcome };
		});
		await selected(h);
		h.controller.startConfirmation('publish'); // empty summary must not be dispatched
		assert.equal(h.submits.length, 0);
		h.controller.startConfirmation('sync');
		await h.controller.confirm();
		assert.equal(h.controller.snapshot().needsReview, true);
		assert.equal(h.controller.snapshot().remote?.kind, outcome);
		assert.equal(h.controller.startConfirmation('sync'), false);
		await h.controller.chooseProduct('p2');
		assert.equal(h.controller.snapshot().productId, 'p1');
		assert.equal(h.submits.length, 1);
		h.setReview(async (_productId, _observed) => ({ cleared: false, status: linked() }));
		await h.controller.reviewUncertain();
		assert.equal(h.controller.snapshot().needsReview, true);
		h.setReview(async () => ({ cleared: true, status: linked() }));
		await h.controller.reviewUncertain();
		assert.equal(h.controller.snapshot().needsReview, false);
		assert.equal(h.controller.startConfirmation('sync'), true);
	}
	const h = harness();
	h.setSubmit(async () => { throw Error('hypothetical transport surprise includes fake-secret'); });
	await selected(h);
	h.controller.startConfirmation('sync');
	await h.controller.confirm();
	assert.equal(h.controller.snapshot().needsReview, true);
	assert.equal(JSON.stringify(h.controller.snapshot()).includes('fake-secret'), false);
});

test('absence of configuration blocks all loads and writes; close disposes and ignores late reads', async () => {
	const h = harness({ availability: 'key-unconfigured' });
	await h.controller.loadProducts();
	assert.equal(h.events.length, 0);
	assert.equal(h.controller.startConfirmation('sync'), false);
	h.setAvailability('ready');
	await h.controller.loadProducts();
	const late = deferred<DialogRemoteStatus>();
	h.setRead(async () => late.promise);
	const reading = h.controller.chooseProduct('p1');
	const previousPaints = h.paints;
	h.controller.dispose();
	late.resolve(linked());
	await reading;
	assert.equal(h.paints, previousPaints);
	assert.equal(h.submits.length, 0);
	assert.equal(h.controller.startConfirmation('sync'), false);
});

test('remote conflict on initial lookup offers the same safe manual-review handoff', async () => {
	const h = harness({ status: { kind: 'conflict', localContent: '本地草稿', remoteContent: '远端已有修改' } });
	await selected(h);
	assert.equal(h.controller.snapshot().needsReview, true);
	assert.equal(h.controller.snapshot().remote?.kind, 'conflict');
	assert.equal(h.controller.startConfirmation('sync'), false);
	assert.equal(h.submits.length, 0);
	h.setReview(async () => ({ cleared: true, status: linked() }));
	await h.controller.reviewUncertain();
	assert.equal(h.controller.startConfirmation('sync'), true);
});

test('matched workflow-verified sync and independently published version display exact state', async () => {
	for (const action of ['sync', 'publish'] as const) {
		const h = harness();
		h.setSubmit(async (intent) => {
			h.submits.push(intent);
			return action === 'sync'
				? { kind: 'verified', action: 'sync', sourcePath: intent.sourcePath,
					productId: intent.productId, status: linked() }
				: { kind: 'verified', action: 'publish', sourcePath: intent.sourcePath,
					productId: intent.productId, status: linked(), publishedVersionNo: 3 };
		});
		await selected(h);
		if (action === 'publish') h.controller.setSummary('正式版本说明');
		assert.equal(h.controller.startConfirmation(action), true);
		await h.controller.confirm();
		const state = h.controller.snapshot();
		assert.equal(state.needsReview, false);
		assert.equal(state.remote?.kind, 'linked');
		assert.equal(state.remote?.kind === 'linked' ? state.remote.recordVersion : -1, 2);
		if (action === 'publish') {
			assert.match(state.notice, /业务版本已确认发布：第 3 版/);
			assert.equal(state.remote?.kind === 'linked' ? state.remote.verifiedPublishedVersionNo : undefined, 3);
		} else {
			assert.match(state.notice, /当前内容已确认同步/);
			assert.equal(state.remote?.kind === 'linked' ? state.remote.verifiedPublishedVersionNo : undefined, undefined);
		}
		assert.equal(h.events.filter(e => e.startsWith('submit:')).length, 1);
	}
});

test('only ACK remains pending readback; unknown publish never promoted by equal bytes', async () => {
	const h = harness();
	await selected(h);
	h.controller.setSummary('此次正式发布');
	assert.equal(h.controller.startConfirmation('publish'), true);
	await h.controller.confirm(); // Only an ACK, not verified.
	assert.equal(h.controller.snapshot().remote, null);
	assert.match(h.controller.snapshot().notice, /查询发布历史/);
	const unknown = harness();
	unknown.setSubmit(async intent => {
		unknown.submits.push(intent);
		return { kind: 'unknown' };
	});
	await selected(unknown);
	unknown.controller.setSummary('此次正式发布');
	unknown.controller.startConfirmation('publish');
	await unknown.controller.confirm();
	assert.equal(unknown.controller.snapshot().needsReview, true);
	assert.equal(unknown.controller.snapshot().remote?.kind, 'unknown');
	assert.equal(unknown.controller.startConfirmation('publish'), false);
	assert.equal(unknown.submits.length, 1);
});

test('mismatched or unproven workflow attestation is unknown, never success', async () => {
	for (const bad of [
		{ kind: 'verified', action: 'sync', sourcePath: '项目/游戏/设计.md',
			productId: 'wrong', status: linked() },
		{ kind: 'verified', action: 'publish', sourcePath: '项目/游戏/设计.md',
			productId: 'p1', status: linked(), publishedVersionNo: 0 },
		{ kind: 'verified', action: 'publish', sourcePath: '项目/游戏/设计.md',
			productId: 'p1', status: linked(), publishedVersionNo: 5 },
	] as DialogSubmitResult[]) {
		const h = harness();
		h.setSubmit(async () => bad);
		await selected(h);
		h.controller.setSummary('业务说明');
		h.controller.startConfirmation('publish');
		await h.controller.confirm();
		assert.equal(h.controller.snapshot().remote?.kind, 'unknown');
		assert.equal(h.controller.snapshot().needsReview, true);
		assert.doesNotMatch(h.controller.snapshot().notice, /已确认发布/);
	}
});

test('CJS/external obsidian UI entry calls host require facade, Node pure import remains safe', async () => {
	// Mirrors the actual plugin format and external Obsidian module; no real device or credential.
	const result = await build({
		entryPoints: ['src/publishDialog.ts'], bundle: true, format: 'cjs',
		platform: 'browser', target: 'es2021', external: ['obsidian'],
		write: false, logLevel: 'silent',
	});
	const code = result.outputFiles[0]!.text;
	const calls: string[] = [];
	let opened = 0;
	class MockModal {
		constructor(_app: unknown) {}
		open(): void { opened++; }
		close(): void {}
	}
	const requireFacade = (name: string) => {
		calls.push(name);
		assert.equal(name, 'obsidian');
		return { Modal: MockModal, Platform: { isIosApp: false }, Setting: class {} };
	};
	const module = { exports: {} as Record<string, unknown> };
	new Function('require', 'module', 'exports', code)(requireFacade, module, module.exports);
	const entry = module.exports.openZhouyouPublishDialog as typeof import('../src/publishDialog.ts').openZhouyouPublishDialog;
	assert.equal(typeof entry, 'function');
	const source = { file: { path: '项目/测试.md' }, isCurrent: () => true } as unknown as PublishDocumentContext;
	const host = harness().host;
	const dialog = await entry({} as never, source, host);
	assert.equal(opened, 1);
	assert.ok(dialog);
	assert.ok(calls.includes('obsidian'), 'the Obsidian CJS facade must be called');
	dialog?.close();
});
