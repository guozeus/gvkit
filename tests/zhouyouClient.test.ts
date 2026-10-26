import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ZhouyouClient, ZhouyouInputError, ZHOUYOU_API_PATH, createZhouyouFetchTransport, createZhouyouRequestUrlTransport,
	sha256Utf8, newZhouyouOperationId, validateZhouyouEndpoint, prepareZhouyouWrite,
} from '../src/zhouyouClient.ts';
import type { ZhouyouHttpRequest, ZhouyouHttpResponse, WriteInput } from '../src/zhouyouClient.ts';

const URL_OK = 'https://doc.example.test' + ZHOUYOU_API_PATH;
const OP = '00000000-0000-4000-8000-000000000001';
const HASH_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('only the documented read_current 404 proves absence; other errors do not', async () => {
	const query = { sourceId: 'gvid-unchanged', productId: 'product-1', documentId: null };
	assert.deepEqual(await harness({ code: 'PRODUCER_DOCUMENT_NOT_FOUND' }, 404).client.readCurrent(query),
		{ kind: 'not-found', reason: 'document-not-found' });
	for (const [status, code] of [[404, 'OTHER'], [401, 'PRODUCER_DOCUMENT_NOT_FOUND'],
		[500, 'PRODUCER_DOCUMENT_NOT_FOUND'], [200, 'PRODUCER_DOCUMENT_NOT_FOUND']] as const) {
		assert.notEqual((await harness({ code }, status).client.readCurrent(query)).kind, 'not-found');
	}
	assert.notEqual((await harness({ code: 'PRODUCER_DOCUMENT_NOT_FOUND' }, 404).client.listProducts()).kind, 'not-found');
});

test('native requestUrl carries exact request, returns HTTP errors and never retries a timeout', async () => {
	const requests: unknown[] = [];
	const transport = createZhouyouRequestUrlTransport(async request => {
		requests.push(request);
		return { status: 404, text: JSON.stringify({ code: 'PRODUCER_DOCUMENT_NOT_FOUND' }) };
	});
	const client = new ZhouyouClient(URL_OK, () => 'fake-key', transport);
	assert.equal((await client.readCurrent({ sourceId: 'gvid-unchanged', productId: 'product-1', documentId: null })).kind, 'not-found');
	assert.deepEqual(requests, [{ url: URL_OK, method: 'POST', headers: {
		'content-type': 'application/json', authorization: 'Bearer fake-key',
	}, body: JSON.stringify({ action: 'read_current', sourceId: 'gvid-unchanged', productId: 'product-1', documentId: null }), throw: false }]);
	let count = 0;
	const timeout = createZhouyouRequestUrlTransport(() => { count++; return new Promise(() => {}); }, 5);
	const timed = new ZhouyouClient(URL_OK, () => 'fake-key', timeout);
	assert.deepEqual(await timed.listProducts(), { kind: 'unknown', reason: 'transport-failure' });
	assert.equal(count, 1);
});
function input(action: 'sync' | 'publish' = 'sync'): WriteInput {
	return { action, sourceId: 'gvid-unchanged', productId: 'product-1', documentId: 'doc-1',
		recordVersion: 4, title: '原文', content: 'abc', changeSummary: action === 'publish' ? '完成第一阶段' : '', operationId: OP };
}
function harness(body: unknown, status = 200, credential: () => string | null | Promise<string | null> = () => 'fake-key-not-real') {
	const requests: ZhouyouHttpRequest[] = [];
	const client = new ZhouyouClient(URL_OK, credential, async (request): Promise<ZhouyouHttpResponse> => {
		requests.push(request);
		return { status, body };
	});
	return { client, requests };
}
function ok(data: unknown) { return { code: 0, data }; }
function current() {
	return { sourceId: 'gvid-unchanged', productId: 'product-1', documentId: 'doc-1',
		title: '原文', content: 'abc', contentHash: HASH_ABC,
		recordVersion: 4, documentStatus: 'active', currentVersionNo: 2 };
}
function ack() {
	return { sourceId: 'gvid-unchanged', productId: 'product-1', operationId: OP,
		documentId: 'doc-1', recordVersion: 5, contentHash: HASH_ABC,
		documentStatus: 'active', currentVersionNo: 3 };
}

test('exact SHA-256 UTF-8 vectors; frontmatter, Unicode and CRLF are not normalized', async () => {
	assert.equal(await sha256Utf8('abc'), HASH_ABC);
	assert.equal(await sha256Utf8(''), SHA_EMPTY);
	assert.equal(await sha256Utf8('中文'), '72726d8818f693066ceb69afa364218b692e62ea92b385782363780f47529c21');
	assert.equal(await sha256Utf8('中文\r\n---\nname: A\n---\n正文\n'),
		'32adced9821af39a3f71722bcd5c415d3e3b4491c1bcac024c950f621b45fc29');
	assert.notEqual(await sha256Utf8('abc\r\n'), await sha256Utf8('abc\n'));
});
test('operation UUID is crypto v4 and never silently used to change source ID', () => {
	const uuid = newZhouyouOperationId();
	assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
});
test('HTTP and HTTPS API endpoints accepted; no redirect policy claimed', () => {
	assert.equal(validateZhouyouEndpoint(URL_OK), URL_OK);
	assert.equal(validateZhouyouEndpoint('http://192.0.2.5:18769' + ZHOUYOU_API_PATH), 'http://192.0.2.5:18769' + ZHOUYOU_API_PATH);
	for (const invalid of [
		'', 'ftp://doc.example.test' + ZHOUYOU_API_PATH,
		'https://u:p@doc.example.test' + ZHOUYOU_API_PATH,
		URL_OK + '?key=x', URL_OK + '#fragment', URL_OK + '/', URL_OK.replace('sync', 'other'),
		URL_OK.replace('https:', 'https: '), URL_OK.replace('doc.', 'DOC.'),
		'https://doc.example.test/a/../' + ZHOUYOU_API_PATH.slice(1),
		'https://doc.example.test', ' https://doc.example.test' + ZHOUYOU_API_PATH,
	]) assert.throws(() => validateZhouyouEndpoint(invalid), ZhouyouInputError, invalid);
});
test('list_products uses only action; rejects malformed and duplicate products', async () => {
	const h = harness(ok({ products: [{ id: 'p1', name: '项目 甲' }, { id: 'p2', name: '项目乙' }] }));
	assert.deepEqual(await h.client.listProducts(), { kind: 'acknowledged',
		data: [{ id: 'p1', name: '项目 甲' }, { id: 'p2', name: '项目乙' }] });
	assert.deepEqual(JSON.parse(h.requests[0]!.body), { action: 'list_products' });
	assert.equal(h.requests[0]!.url, URL_OK);
	assert.equal(h.requests[0]!.method, 'POST');
	assert.equal(h.requests[0]!.headers.authorization, 'Bearer fake-key-not-real');
	for (const products of [{}, { products: 'wrong' },
		{ products: [{ id: '', name: 'x' }] },
		{ products: [{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }] }]) {
		assert.deepEqual(await harness(ok(products)).client.listProducts(), { kind: 'unknown', reason: 'protocol-response' });
	}
});
test('read_current confirms source, product, known document, positive record and actual content bytes', async () => {
	const h = harness(ok(current()));
	const result = await h.client.readCurrent({ sourceId: 'gvid-unchanged', productId: 'product-1', documentId: 'doc-1' });
	assert.equal(result.kind, 'acknowledged');
	assert.deepEqual(JSON.parse(h.requests[0]!.body), { action: 'read_current',
		sourceId: 'gvid-unchanged', productId: 'product-1', documentId: 'doc-1' });
	for (const changed of [
		{ sourceId: 'other' }, { productId: 'another' }, { documentId: 'doc-other' },
		{ recordVersion: 0 }, { recordVersion: '4' }, { contentHash: SHA_EMPTY },
		{ content: 'abc\n' }, { documentStatus: 'unknown' }, { currentVersionNo: '2' },
	]) {
		const result = await harness(ok({ ...current(), ...changed })).client.readCurrent({
			sourceId: 'gvid-unchanged', productId: 'product-1', documentId: 'doc-1',
		});
		assert.notEqual(result.kind, 'acknowledged', JSON.stringify(changed));
	}
	assert.equal((await harness(ok({ ...current(), documentId: 'doc-other' })).client.readCurrent({
		sourceId: 'gvid-unchanged', productId: 'product-1', documentId: null,
	})).kind, 'acknowledged');
});
test('prepared sync and publish preserve exact content, separate action and summary, fixed operationId', async () => {
	const original = input();
	const sync = await prepareZhouyouWrite(original);
	assert.equal(sync.operationId, OP);
	assert.equal(sync.sourceId, original.sourceId);
	assert.equal(sync.sourceRevision, HASH_ABC);
	assert.equal(sync.changeSummary, '');
	assert.match(sync.payloadHash, /^[0-9a-f]{64}$/u);
	assert.equal(Object.isFrozen(sync), true);
	const publish = await prepareZhouyouWrite(input('publish'));
	assert.equal(publish.operationId, OP);
	assert.notEqual(sync.payloadHash, publish.payloadHash);
	const h = harness(ok(ack()));
	assert.equal((await h.client.sendWrite(sync)).kind, 'acknowledged');
	assert.equal((await h.client.sendWrite(publish)).kind, 'acknowledged');
	assert.equal(h.requests.length, 2); // only two explicit calls
	const syncBody = JSON.parse(h.requests[0]!.body);
	const pubBody = JSON.parse(h.requests[1]!.body);
	assert.deepEqual(syncBody, { action: 'sync', sourceId: 'gvid-unchanged', documentId: 'doc-1',
		recordVersion: 4, productId: 'product-1', title: '原文', content: 'abc',
		sourceRevision: HASH_ABC, changeSummary: '', operationId: OP });
	assert.equal(pubBody.action, 'publish');
	assert.equal(pubBody.changeSummary, '完成第一阶段');
	assert.equal(pubBody.operationId, OP);
	assert.equal('payloadHash' in pubBody, false);
});
test('empty publish summary and nonempty sync summary are refused before any send', async () => {
	for (const changes of [
		{ ...input('publish'), changeSummary: '   ' },
		{ ...input('sync'), changeSummary: 'actually publish' },
		{ ...input(), recordVersion: 0 },
		{ ...input(), operationId: 'non-uuid' },
	]) await assert.rejects(() => prepareZhouyouWrite(changes as WriteInput), ZhouyouInputError);
});
test('tampered request, content hash, action or payload hash cannot be dispatched', async () => {
	const h = harness(ok(ack()));
	const prepared = await prepareZhouyouWrite(input());
	for (const changed of [
		{ ...prepared, content: 'abc\n' }, { ...prepared, payloadHash: SHA_EMPTY },
		{ ...prepared, action: 'publish' }, { ...prepared, changeSummary: 'notice' },
	]) {
		assert.deepEqual(await h.client.sendWrite(changed as typeof prepared),
			{ kind: 'not-sent', reason: 'invalid-request' });
	}
	assert.equal(h.requests.length, 0);
});
test('present write ACK echo mismatching source/product/document/opId/hash/version is unknown, not success', async () => {
	const prepared = await prepareZhouyouWrite(input());
	for (const altered of [
		{ sourceId: 'other' }, { productId: 'other' }, { documentId: 'other' },
		{ operationId: '00000000-0000-4000-8000-000000000002' },
		{ contentHash: SHA_EMPTY }, { recordVersion: 0 }, { recordVersion: 3 },
	]) {
		const result = await harness(ok({ ...ack(), ...altered })).client.sendWrite(prepared);
		assert.notEqual(result.kind, 'acknowledged', JSON.stringify(altered));
	}
	assert.deepEqual(await harness(ok({ documentId: 'doc-1', recordVersion: 5 })).client.sendWrite(prepared),
		{ kind: 'acknowledged', data: { documentId: 'doc-1', recordVersion: 5 } }); // reference minimum
});
test('publish needs real version field in ACK but ACK never asserts independent publish history', async () => {
	const prepared = await prepareZhouyouWrite(input('publish'));
	assert.equal((await harness(ok({ ...ack(), currentVersionNo: undefined })).client.sendWrite(prepared)).kind, 'unknown');
	const result = await harness(ok({ ...ack(), outcome: 'already-applied' })).client.sendWrite(prepared);
	assert.deepEqual(result, { kind: 'acknowledged', data: { documentId: 'doc-1',
		recordVersion: 5, currentVersionNo: 3, documentStatus: 'active', outcome: 'already-applied' } });
	assert.equal(JSON.stringify(result).includes('完成第一阶段'), false);
});
test('HTTP business rejection, record conflict and unconfirmed are distinct and sanitized', async () => {
	for (const [status, body, expected] of [
		[403, { code: 'DENIED', message: 'fake-secret-in-error' }, { kind: 'rejected', reason: 'authorization' }],
		[422, { code: 'BUSINESS_DENIED', message: 'fake-secret-in-error' }, { kind: 'rejected', reason: 'http-rejection' }],
		[200, { code: 'DENIED', message: 'fake-secret-in-error' }, { kind: 'rejected', reason: 'business' }],
		[409, { code: 'OBSIDIAN_SYNC_RECORD_VERSION_CONFLICT' }, { kind: 'conflict', reason: 'record-version-conflict' }],
		[200, { code: 'OBSIDIAN_SYNC_OPERATION_UNCONFIRMED' }, { kind: 'unknown', reason: 'operation-unconfirmed' }],
		[500, { code: 'DENIED', message: 'fake-secret-in-error' }, { kind: 'unknown', reason: 'server-failure' }],
		[302, 'redirect-to-evil', { kind: 'unknown', reason: 'protocol-response' }],
		[200, '<html>not-json</html>', { kind: 'unknown', reason: 'protocol-response' }],
	] as const) {
		const result = await harness(body, status).client.listProducts();
		assert.deepEqual(result, expected);
		assert.equal(JSON.stringify(result).includes('fake-secret-in-error'), false);
	}
});
test('missing, malformed or throwing credential never invokes transport', async () => {
	for (const getKey of [
		() => null, () => '', () => 'fake\nheader-injection',
		() => { throw new Error('never echo fake-secret-in-error'); },
	]) {
		const h = harness(ok({ products: [] }), 200, getKey);
		const result = await h.client.listProducts();
		assert.equal(result.kind, 'not-sent');
		assert.equal(h.requests.length, 0);
		assert.equal(JSON.stringify(result).includes('fake-secret-in-error'), false);
	}
});
test('unknown transport timeout retains same operationId and does not retry automatically', async () => {
	const prepared = await prepareZhouyouWrite(input('publish'));
	const bodies: Array<Record<string, unknown>> = [];
	const client = new ZhouyouClient(URL_OK, () => 'fake-key-not-real', async (request) => {
		bodies.push(JSON.parse(request.body));
		throw new Error('timeout including fake-key-not-real');
	});
	const result = await client.sendWrite(prepared);
	assert.deepEqual(result, { kind: 'unknown', reason: 'transport-failure' });
	assert.equal(bodies.length, 1);
	assert.equal(bodies[0]!.operationId, OP);
	assert.equal(JSON.stringify(result).includes('fake-key-not-real'), false);
	assert.equal((await prepareZhouyouWrite(input('publish'))).operationId, OP);
});
test('no crypto capability refuses hash, UUID and sending without substituting Node API', async () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
	try {
		Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
		await assert.rejects(() => sha256Utf8('abc'), ZhouyouInputError);
		assert.throws(() => newZhouyouOperationId(), ZhouyouInputError);
		const h = harness(ok(current()));
		assert.deepEqual(await h.client.readCurrent({
			sourceId: 'gvid-unchanged', productId: 'product-1', documentId: 'doc-1',
		}), { kind: 'not-sent', reason: 'crypto-unavailable' });
		assert.equal(h.requests.length, 0);
	} finally {
		if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
		else Reflect.deleteProperty(globalThis, 'crypto');
	}
});


test('reference-minimum ACK enters candidate path; publish requires exact version number', async () => {
	const sync = await prepareZhouyouWrite(input('sync'));
	assert.deepEqual(await harness(ok({ documentId: 'doc-1', recordVersion: 5 })).client.sendWrite(sync),
		{ kind: 'acknowledged', data: { documentId: 'doc-1', recordVersion: 5 } });
	const publish = await prepareZhouyouWrite(input('publish'));
	assert.deepEqual(await harness(ok({ documentId: 'doc-1', recordVersion: 5, currentVersionNo: 3 })).client.sendWrite(publish),
		{ kind: 'acknowledged', data: { documentId: 'doc-1', recordVersion: 5, currentVersionNo: 3 } });
	assert.equal((await harness(ok({ documentId: 'doc-1', recordVersion: 5 })).client.sendWrite(publish)).kind, 'unknown');
	for (const changed of [
		{ sourceId: 'wrong' }, { productId: 'wrong' },
		{ operationId: '00000000-0000-4000-8000-000000000002' },
		{ sourceRevision: 'f'.repeat(64) }, { contentHash: 'f'.repeat(64) },
	]) assert.equal((await harness(ok({ documentId: 'doc-1', recordVersion: 5, currentVersionNo: 3, ...changed }))
		.client.sendWrite(publish)).kind, 'unknown');
});
test('fetch transport rejects automatic redirection and never logs raw response/errors', async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fakeFetch: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init! });
		return { status: 200, redirected: false, url: URL_OK, text: async () => JSON.stringify(ok({ products: [] })) } as Response;
	}) as typeof fetch;
	const transport = createZhouyouFetchTransport(fakeFetch, 200);
	const client = new ZhouyouClient(URL_OK, () => 'fake-only-key', transport);
	assert.equal((await client.listProducts()).kind, 'acknowledged');
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, URL_OK);
	assert.equal(calls[0]!.init.redirect, 'error');
	assert.equal(calls[0]!.init.credentials, 'omit');
	assert.equal(calls[0]!.init.mode, 'cors');
	assert.equal(calls[0]!.init.referrerPolicy, 'no-referrer');
	assert.equal(calls[0]!.init.cache, 'no-store');
	assert.equal(calls[0]!.init.headers && (calls[0]!.init.headers as Record<string,string>).authorization,
		'Bearer fake-only-key');
	assert.equal((await new ZhouyouClient(URL_OK, () => 'fake-only-key',
		createZhouyouFetchTransport((async () => {
			throw Error('mock exception contains fake-only-key');
		}) as typeof fetch)).listProducts()).kind, 'unknown');
	const redirected = new ZhouyouClient(URL_OK, () => 'fake-only-key',
		createZhouyouFetchTransport((async () => ({
			status: 200, redirected: true, url: 'https://other.example',
			text: async () => 'never-trust',
		} as Response)) as typeof fetch));
	const result = await redirected.listProducts();
	assert.equal(result.kind, 'unknown');
	assert.equal(JSON.stringify(result).includes('fake-only-key'), false);
});
test('timeout aborts Fetch without falling back to a redirect-capable request', async () => {
	let aborted = false;
	const fetcher = (async (_: RequestInfo | URL, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('fake cancelled')); });
		})) as typeof fetch;
	const transport = createZhouyouFetchTransport(fetcher, 5);
	const result = await new ZhouyouClient(URL_OK, () => 'fake-only-key', transport).listProducts();
	assert.equal(result.kind, 'unknown');
	assert.equal(aborted, true);
});
