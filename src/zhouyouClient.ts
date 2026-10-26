/** Zhouyou's four-action API client. No live transport or credential storage.
 * Caller must prove redirect safety, persist pending before writes and verify
 * service-side atomicity/permissions before enabling real traffic. */
export const ZHOUYOU_API_PATH = '/api/producer-documents/obsidian-sync';
export type ZhouyouAction = 'list_products' | 'read_current' | 'sync' | 'publish';
export type WriteAction = 'sync' | 'publish';

export interface ZhouyouHttpRequest {
	url: string;
	method: 'POST';
	headers: Readonly<Record<string, string>>;
	body: string;
}
export interface ZhouyouHttpResponse { status: number; body: unknown }
export type ZhouyouTransport = (request: ZhouyouHttpRequest) => Promise<ZhouyouHttpResponse>;
export type ZhouyouCredential = () => string | null | undefined | Promise<string | null | undefined>;
export type ZhouyouResult<T> =
	| { kind: 'acknowledged'; data: T }
	| { kind: 'not-found'; reason: 'document-not-found' }
	| { kind: 'not-sent'; reason: 'missing-credential' | 'credential-unavailable' | 'invalid-credential' | 'invalid-request' | 'crypto-unavailable' }
	| { kind: 'rejected'; reason: 'authorization' | 'business' | 'http-rejection' }
	| { kind: 'conflict'; reason: 'record-version-conflict' }
	| { kind: 'unknown'; reason: 'transport-failure' | 'operation-unconfirmed' | 'server-failure' | 'protocol-response' | 'identity-mismatch' | 'content-mismatch' };

export interface ZhouyouProduct { id: string; name: string }
export interface ZhouyouCurrent {
	sourceId: string;
	productId: string;
	documentId: string;
	recordVersion: number;
	title: string;
	content: string;
	contentHash: string;
	currentVersionNo: number;
	documentStatus: 'active' | 'archived';
}
export interface ReadCurrentQuery { sourceId: string; productId: string; documentId: string | null }
export interface WriteInput {
	action: WriteAction;
	sourceId: string;
	documentId: string | null;
	recordVersion: number | null;
	productId: string;
	title: string;
	content: string;
	changeSummary: string;
	operationId: string;
}
export interface PreparedWrite extends WriteInput {
	readonly sourceRevision: string;
	/** SHA256(JSON.stringify({action,...requestFieldsWithoutOperationId})) */
	readonly payloadHash: string;
}
export interface ZhouyouWriteAck {
	documentId: string;
	recordVersion: number;
	/** ACK field is not independent evidence of version history. */
	currentVersionNo?: number;
	documentStatus?: 'active' | 'archived';
	outcome?: 'already-applied';
}
export class ZhouyouInputError extends Error {
	readonly code: 'invalid-endpoint' | 'invalid-request' | 'crypto-unavailable';
	constructor(code: 'invalid-endpoint' | 'invalid-request' | 'crypto-unavailable') {
		super(code); this.name = 'ZhouyouInputError'; this.code = code;
	}
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256
		&& value === value.trim() && !/\s|[\u0000-\u001f\u007f]/u.test(value);
}
function version(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
function versionNo(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function sha(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
function operationUuid(value: unknown): value is string {
	return typeof value === 'string'
		&& /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
function hasSha256(): boolean {
	return typeof TextEncoder !== 'undefined' && typeof globalThis.crypto?.subtle?.digest === 'function';
}
/** Hash exact UTF-8 bytes. Preserve every frontmatter/CRLF/trailing character. */
export async function sha256Utf8(content: string): Promise<string> {
	if (typeof content !== 'string') throw new ZhouyouInputError('invalid-request');
	if (!hasSha256()) throw new ZhouyouInputError('crypto-unavailable');
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
	return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}
/** New explicit operation ONLY, never sourceId/gvid or implicit retry. */
export function newZhouyouOperationId(): string {
	const crypto = globalThis.crypto;
	if (!crypto || typeof crypto.randomUUID !== 'function') throw new ZhouyouInputError('crypto-unavailable');
	const value = crypto.randomUUID();
	if (!operationUuid(value)) throw new ZhouyouInputError('crypto-unavailable');
	return value;
}
/** Accept HTTP and HTTPS at the supported route, including device-configured LAN endpoints. */
export function validateZhouyouEndpoint(input: string): string {
	if (typeof input !== 'string' || !input || input !== input.trim()) throw new ZhouyouInputError('invalid-endpoint');
	let url: URL;
	try { url = new URL(input); } catch { throw new ZhouyouInputError('invalid-endpoint'); }
	if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
		|| url.search || url.hash || url.pathname !== ZHOUYOU_API_PATH || url.href !== input)
		throw new ZhouyouInputError('invalid-endpoint');
	return url.href;
}
function validateInput(input: WriteInput): void {
	if (!object(input) || (input.action !== 'sync' && input.action !== 'publish')
		|| !id(input.sourceId) || !id(input.productId)
		|| (input.documentId !== null && !id(input.documentId))
		|| (input.recordVersion !== null && !version(input.recordVersion))
		|| typeof input.title !== 'string' || !input.title.trim()
		|| typeof input.content !== 'string'
		|| typeof input.changeSummary !== 'string'
		|| (input.action === 'sync' && input.changeSummary !== '')
		|| (input.action === 'publish' && !input.changeSummary.trim())
		|| !operationUuid(input.operationId)) throw new ZhouyouInputError('invalid-request');
}
function requestFields(input: WriteInput, sourceRevision: string) {
	return {
		sourceId: input.sourceId, documentId: input.documentId, recordVersion: input.recordVersion,
		productId: input.productId, title: input.title, content: input.content,
		sourceRevision, changeSummary: input.changeSummary,
	};
}
/** Prepare once. Caller must durably save operationId/request/hash before sendWrite. */
export async function prepareZhouyouWrite(input: WriteInput): Promise<PreparedWrite> {
	validateInput(input);
	const sourceRevision = await sha256Utf8(input.content);
	const fields = requestFields(input, sourceRevision);
	const payloadHash = await sha256Utf8(JSON.stringify({ action: input.action, ...fields }));
	return Object.freeze({ action: input.action, ...fields, operationId: input.operationId, payloadHash });
}
function parseBody(body: unknown): unknown {
	if (typeof body !== 'string') return body;
	try { return JSON.parse(body) as unknown; } catch { return null; }
}
/** Every action is exactly one attempt; nothing is retried automatically. */
export class ZhouyouClient {
	private readonly endpoint: string;
	private readonly credential: ZhouyouCredential;
	private readonly transport: ZhouyouTransport;
	constructor(endpoint: string, credential: ZhouyouCredential, transport: ZhouyouTransport) {
		this.endpoint = validateZhouyouEndpoint(endpoint);
		if (typeof credential !== 'function' || typeof transport !== 'function') throw new ZhouyouInputError('invalid-request');
		this.credential = credential;
		this.transport = transport;
	}
	private async call(action: ZhouyouAction, payload: Record<string, unknown> = {}): Promise<ZhouyouResult<unknown>> {
		let key: string | null | undefined;
		try { key = await this.credential(); }
		catch { return { kind: 'not-sent', reason: 'credential-unavailable' }; }
		if (typeof key !== 'string' || !key.trim()) return { kind: 'not-sent', reason: 'missing-credential' };
		key = key.trim();
		// No newline, spaces, or untrusted server/error echo in Authorization.
		if (!/^[A-Za-z0-9._~+/-]+={0,}$/u.test(key)) return { kind: 'not-sent', reason: 'invalid-credential' };
		let response: ZhouyouHttpResponse;
		try {
			response = await this.transport({
				url: this.endpoint, method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
				body: JSON.stringify({ action, ...payload }),
			});
		} catch { return { kind: 'unknown', reason: 'transport-failure' }; }
		if (!object(response) || !Number.isInteger(response.status) || response.status < 100 || response.status > 599)
			return { kind: 'unknown', reason: 'protocol-response' };
		const envelope = parseBody(response.body);
		if (response.status >= 500) return { kind: 'unknown', reason: 'server-failure' };
		if (response.status >= 300 && response.status < 400) return { kind: 'unknown', reason: 'protocol-response' };
		if (object(envelope) && envelope.code === 'OBSIDIAN_SYNC_OPERATION_UNCONFIRMED')
			return { kind: 'unknown', reason: 'operation-unconfirmed' };
		if (object(envelope) && envelope.code === 'OBSIDIAN_SYNC_RECORD_VERSION_CONFLICT')
			return { kind: 'conflict', reason: 'record-version-conflict' };
		if (response.status === 401 || response.status === 403) return { kind: 'rejected', reason: 'authorization' };
		if (action === 'read_current' && response.status === 404 && object(envelope)
			&& envelope.code === 'PRODUCER_DOCUMENT_NOT_FOUND')
			return { kind: 'not-found', reason: 'document-not-found' };
		if (response.status >= 400) return { kind: 'rejected', reason: 'http-rejection' };
		if (!object(envelope) || envelope.code === undefined) return { kind: 'unknown', reason: 'protocol-response' };
		if (envelope.code !== 0) return { kind: 'rejected', reason: 'business' };
		if (!('data' in envelope)) return { kind: 'unknown', reason: 'protocol-response' };
		return { kind: 'acknowledged', data: envelope.data };
	}
	async listProducts(): Promise<ZhouyouResult<ZhouyouProduct[]>> {
		const result = await this.call('list_products');
		if (result.kind !== 'acknowledged') return result;
		if (!object(result.data) || !Array.isArray(result.data.products))
			return { kind: 'unknown', reason: 'protocol-response' };
		const products: ZhouyouProduct[] = [];
		const seen = new Set<string>();
		for (const entry of result.data.products) {
			if (!object(entry) || !id(entry.id) || typeof entry.name !== 'string'
				|| !entry.name.trim() || seen.has(entry.id)) return { kind: 'unknown', reason: 'protocol-response' };
			seen.add(entry.id);
			products.push({ id: entry.id, name: entry.name });
		}
		return { kind: 'acknowledged', data: products };
	}
	async readCurrent(query: ReadCurrentQuery): Promise<ZhouyouResult<ZhouyouCurrent>> {
		if (!object(query) || !id(query.sourceId) || !id(query.productId)
			|| (query.documentId !== null && !id(query.documentId))) return { kind: 'not-sent', reason: 'invalid-request' };
		if (!hasSha256()) return { kind: 'not-sent', reason: 'crypto-unavailable' };
		const result = await this.call('read_current', {
			sourceId: query.sourceId, productId: query.productId, documentId: query.documentId,
		});
		if (result.kind !== 'acknowledged') return result;
		const current = result.data;
		if (!object(current) || current.sourceId !== query.sourceId || current.productId !== query.productId
			|| !id(current.documentId) || (query.documentId !== null && current.documentId !== query.documentId))
			return { kind: 'unknown', reason: 'identity-mismatch' };
		if (!version(current.recordVersion) || typeof current.content !== 'string' || !sha(current.contentHash)
			|| typeof current.title !== 'string' || !versionNo(current.currentVersionNo)
			|| (current.documentStatus !== 'active' && current.documentStatus !== 'archived'))
			return { kind: 'unknown', reason: 'protocol-response' };
		let digest: string;
		try { digest = await sha256Utf8(current.content); }
		catch { return { kind: 'unknown', reason: 'content-mismatch' }; }
		if (digest !== current.contentHash) return { kind: 'unknown', reason: 'content-mismatch' };
		return { kind: 'acknowledged', data: {
			sourceId: query.sourceId, productId: query.productId, documentId: current.documentId,
			recordVersion: current.recordVersion, title: current.title, content: current.content,
			contentHash: digest, currentVersionNo: current.currentVersionNo, documentStatus: current.documentStatus,
		} };
	}
	/** Caller rechecks identity/content and durable pending first. This returns
	 * ACK candidate, not independent proof of publication or a cleared pending. */
	async sendWrite(prepared: PreparedWrite): Promise<ZhouyouResult<ZhouyouWriteAck>> {
		let check: PreparedWrite;
		try { check = await prepareZhouyouWrite(prepared); }
		catch (error) {
			return { kind: 'not-sent', reason: error instanceof ZhouyouInputError && error.code === 'crypto-unavailable'
				? 'crypto-unavailable' : 'invalid-request' };
		}
		if (check.sourceRevision !== prepared.sourceRevision || check.payloadHash !== prepared.payloadHash)
			return { kind: 'not-sent', reason: 'invalid-request' };
		const result = await this.call(prepared.action, {
			...requestFields(prepared, prepared.sourceRevision), operationId: prepared.operationId,
		});
		if (result.kind !== 'acknowledged') return result;
		const ack = result.data;
		// The existing reference ACK requires documentId/recordVersion (and publish version).
		// Source/product/op echoes are OPTIONAL, but reject each mismatched echo.
		// Full identity/body/record/version is independently readCurrent-verified by workflow.
		if (!object(ack) || (ack.sourceId !== undefined && ack.sourceId !== prepared.sourceId)
			|| (ack.productId !== undefined && ack.productId !== prepared.productId)
			|| (ack.operationId !== undefined && ack.operationId !== prepared.operationId)
			|| !id(ack.documentId)
			|| (prepared.documentId !== null && ack.documentId !== prepared.documentId))
			return { kind: 'unknown', reason: 'identity-mismatch' };
		if (!version(ack.recordVersion)
			|| (prepared.recordVersion !== null && ack.recordVersion < prepared.recordVersion)
			|| (ack.contentHash !== undefined && ack.contentHash !== prepared.sourceRevision)
			|| (ack.sourceRevision !== undefined && ack.sourceRevision !== prepared.sourceRevision))
			return { kind: 'unknown', reason: 'content-mismatch' };
		if ((ack.currentVersionNo !== undefined && !versionNo(ack.currentVersionNo))
			|| (prepared.action === 'publish' && !version(ack.currentVersionNo))
			|| (ack.documentStatus !== undefined && ack.documentStatus !== 'active' && ack.documentStatus !== 'archived')
			|| (ack.outcome !== undefined && ack.outcome !== 'already-applied'))
			return { kind: 'unknown', reason: 'protocol-response' };
		const data: ZhouyouWriteAck = { documentId: ack.documentId, recordVersion: ack.recordVersion };
		if (versionNo(ack.currentVersionNo)) data.currentVersionNo = ack.currentVersionNo;
		if (ack.documentStatus === 'active' || ack.documentStatus === 'archived') data.documentStatus = ack.documentStatus;
		if (ack.outcome === 'already-applied') data.outcome = 'already-applied';
		return { kind: 'acknowledged', data };
	}
}

/** Obsidian's native HTTP API works on desktop and mobile without browser CORS.
 * Inject the public requestUrl function so this client remains runtime-independent. */
export function createZhouyouRequestUrlTransport(requestUrl: (request: {
	url: string; method: string; headers: Record<string, string>; body: string; throw: boolean;
}) => Promise<{ status: number; text: string }>, timeoutMs = 20000): ZhouyouTransport {
	return async request => {
		const url = validateZhouyouEndpoint(request.url);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const response = await Promise.race([
				requestUrl({ url, method: request.method, headers: { ...request.headers },
					body: request.body, throw: false }),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('transport-timeout')), timeoutMs);
				}),
			]);
			return { status: response.status, body: response.text };
		} catch {
			// A timeout cannot cancel native HTTP: the workflow retains its pending operation.
			throw new Error('transport-unavailable');
		} finally { if (timer !== undefined) clearTimeout(timer); }
	};
}

/** Mobile-compatible Fetch transport. A redirect is rejected before Bearer/body
 * can be forwarded to a second hop. No error text, URL or request is logged.
 * Actual device CORS/Fetch availability remains subject to real-device tests. */
export function createZhouyouFetchTransport(
	fetcher: typeof fetch = globalThis.fetch, timeoutMs = 20000,
): ZhouyouTransport {
	return async (request) => {
		const url = validateZhouyouEndpoint(request.url);
		if (request.method !== 'POST' || typeof fetcher !== 'function'
			|| !Number.isFinite(timeoutMs) || timeoutMs <= 0
			|| request.headers['content-type'] !== 'application/json'
			|| typeof request.headers.authorization !== 'string'
			|| !/^Bearer [A-Za-z0-9._~+/-]+={0,}$/u.test(request.headers.authorization))
			throw new Error('transport-unavailable');
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetcher(url, {
				method: 'POST', body: request.body,
				headers: { 'content-type': 'application/json',
					authorization: request.headers.authorization },
				redirect: 'error', credentials: 'omit', mode: 'cors',
				cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
			});
			if (response.redirected || (response.url && response.url !== url))
				throw new Error('unexpected-response-location');
			return { status: response.status, body: await response.text() };
		} catch {
			throw new Error('transport-failure'); // Never echo raw network/credential errors.
		} finally {
			clearTimeout(timer);
		}
	};
}
