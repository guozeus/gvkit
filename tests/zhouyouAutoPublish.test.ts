import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';

const SOURCE_ID = '019a2f35-2048-7000-8000-000000000001';
const ENDPOINT = 'https://doc.example.test/api/producer-documents/obsidian-sync';
const TOKEN = 'FAKE_TEST_TOKEN';
let dir: string;
let Publisher: any;
let publishBody: (body: string) => string;
const g = globalThis as any;
const shim = [
  'export class Notice { constructor(message) { (globalThis.__notices ??= []).push(message); } setMessage() {} hide() {} }',
  'export const requestUrl = (req) => globalThis.__send(req);',
  'export function getFrontMatterInfo(content) {',
  '  const m = /^(?:\\uFEFF)?---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n/.exec(content);',
  '  return m ? { exists: true, frontmatter: m[1], contentStart: m[0].length } : { exists: false, frontmatter: \"\", contentStart: 0 };',
  '}',
  'export function parseYaml(content) { const obj = {}; for (const line of content.split(/\\r?\\n/)) {',
  '  const at = line.indexOf(\":\"); if (at > 0) obj[line.slice(0, at).trim()] = line.slice(at + 1).trim();',
  '} return obj; }',
].join('\n');

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gvkit-zhouyou-auto-'));
  const outfile = join(dir, 'auto.mjs');
  await build({ stdin: { contents: "export { ZhouyouAutoPublisher, publishBody } from './src/zhouyouAutoPublish';",
    resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'obsidian-shim', setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
      b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: shim, loader: 'js' }));
    } }],
  });
  const m = await import(pathToFileURL(outfile).href);
  Publisher = m.ZhouyouAutoPublisher;
  publishBody = m.publishBody;
  g.crypto ??= webcrypto;
  g.document = { querySelectorAll: () => [] };
});
after(async () => {
  delete g.__send;
  delete g.__notices;
  await rm(dir, { recursive: true, force: true });
});

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
function makeHarness(initialContent = '---\ngvid: ' + SOURCE_ID + '\n---\n第一段\r\n') {
  let raw = initialContent;
  const file = { path: '项目/研发/测试.md', basename: '测试', extension: 'md' };
  const notices: string[] = [];
  g.__notices = notices;
  let remote: any = null;
  const requests: any[] = [];
  let writes = 0;
  const receipts = new Map<string, { payload: any; ack: any }>();
  let beforeWrite: (body: any, disk: any) => any = () => undefined;
  let afterWrite: (body: any) => any = () => undefined;
  let responseForRead: (body: any) => any = () => undefined;
  let disk: any = {};
  let token = TOKEN;
  const files: Record<string, string> = {};
  const settings = {
    getZhouyouUrl: () => ENDPOINT,
    getAutoPublishBindings: () => structuredClone(disk.zhouyouAutoBindings ?? {}),
    getPublishBindingsSnapshot: () => [],
    updateNonSecret: async (fn: (value: any) => void) => {
      const next = structuredClone(disk); fn(next); disk = next;
    },
  };
  const app = {
    vault: {
      configDir: '.obsidian',
      read: async () => raw,
      adapter: { exists: async (p: string) => p in files, read: async (p: string) => {
        if (!(p in files)) throw Error('missing file'); return files[p];
      } },
    },
    metadataCache: { getFileCache: () => ({ frontmatter: { gvid: SOURCE_ID } }) },
    workspace: { getLeavesOfType: () => [] },
  };
  const secret = { runtimeCredential: () => token };
  const context = { file, view: { save: async () => undefined, editor: { getValue: () => raw } },
    isCurrent: () => true };
  const publisher = new Publisher(app, settings, secret);
  g.__send = async (request: any) => {
    assert.equal(request.url, ENDPOINT);
    assert.equal(request.headers.authorization, 'Bearer ' + TOKEN);
    const body = JSON.parse(request.body);
    requests.push(body);
    if (body.action === 'read_current') {
      const override = responseForRead(body);
      if (override) return override;
      if (!remote) return { status: 404, json: { code: 'PRODUCER_DOCUMENT_NOT_FOUND' }, headers: {} };
      return { status: 200, json: { code: 0, data: structuredClone(remote) }, headers: {} };
    }
    assert.equal(body.action, 'sync_smart', 'only the documented write action is permitted');
    assert.equal(body.sourceId, SOURCE_ID);
    assert.equal('sourceRevision' in body, false, 'undocumented fields are not transmitted');
    assert.equal('productId' in body, false);
    const pending = disk.zhouyouAutoBindings[SOURCE_ID].pending;
    assert.equal(pending.endpoint, ENDPOINT);
    assert.equal(pending.action, 'sync_smart');
    assert.deepEqual(pending.payload, (({ action, ...rest }) => rest)(body));
    const pre = beforeWrite(body, disk);
    if (pre) return pre;
    const receipt = receipts.get(body.operationId);
    if (receipt) {
      assert.deepEqual(body, receipt.payload, 'a retry must preserve the complete original request');
      return { status: 200, json: { code: 0, data: structuredClone(receipt.ack) }, headers: {} };
    }
    writes++;
    if (!remote) {
      assert.equal(body.documentId, null);
      assert.equal(body.recordVersion, null);
    } else {
      assert.equal(body.documentId, remote.documentId);
      assert.equal(body.recordVersion, remote.recordVersion);
    }
    const changed = !remote || remote.content !== body.content || remote.title !== body.title || remote.publishedContentHash !== hash(body.content);
    remote = { sourceId: body.sourceId, documentId: remote?.documentId ?? 'doc-1',
      recordVersion: (remote?.recordVersion ?? 0) + (changed ? 1 : 0),
      title: body.title, content: body.content, contentHash: hash(body.content), publishedContentHash: hash(body.content),
      productId: 'auto-product', productName: '自动项目', currentVersionNo: (remote?.currentVersionNo ?? 0) + (changed ? 1 : 0),
      documentStatus: 'active' };
    receipts.set(body.operationId, { payload: structuredClone(body), ack: {
      documentId: remote.documentId, recordVersion: remote.recordVersion,
    } });
    const post = afterWrite(body);
    if (post) return post;
    return { status: 200, json: { code: 0, data: {
      documentId: remote.documentId, recordVersion: remote.recordVersion,
    } }, headers: {} };
  };
  return {
    publisher, settings, app, context, file, requests, notices, files,
    set token(value: string) { token = value; },
    get raw() { return raw; },
    set raw(value: string) { raw = value; },
    get disk() { return disk; },
    set disk(value: any) { disk = value; },
    get remote() { return remote; },
    set remote(value: any) { remote = value; },
    get writes() { return writes; },
    set beforeWrite(fn: (b: any, d: any) => any) { beforeWrite = fn; },
    set afterWrite(fn: (b: any) => any) { afterWrite = fn; },
    set responseForRead(fn: (b: any) => any) { responseForRead = fn; },
    restart() { return new Publisher(app, settings, secret); },
  };
}
test('first click reads 404, creates via sync_smart and independently reads back; LF is normalized', async () => {
  const h = makeHarness();
  await h.publisher.publish(h.context);
  assert.deepEqual(h.requests.map(r => r.action), ['read_current', 'sync_smart', 'read_current']);
  assert.equal(h.requests[1].content, '---\ngvid: ' + SOURCE_ID + '\n---\n第一段\n');
  assert.equal(h.writes, 1);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].pending, undefined);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].documentId, 'doc-1');
  assert.ok(h.notices.some(s => s.includes('已发布到宙游文档中心')));
});
test('update sends current document ID/version; repeat and restart do not create duplicates', async () => {
  const h = makeHarness();
  await h.publisher.publish(h.context);
  const initialSourceId = h.disk.zhouyouAutoBindings[SOURCE_ID].sourceId;
  h.raw = h.raw.replace('第一段', '第二段');
  await h.publisher.publish(h.context);
  assert.equal(h.writes, 2);
  assert.equal(h.requests.at(-2).documentId, 'doc-1');
  assert.equal(h.requests.at(-2).recordVersion, 1, 'write uses the version obtained by pre-read');
  assert.equal(h.remote.recordVersion, 2, 'server advanced the version after the write');
  const publisherAfterRestart = h.restart();
  const priorCalls = h.requests.length;
  await publisherAfterRestart.publish(h.context);
  assert.equal(h.requests.length, priorCalls + 1);
  assert.equal(h.requests.at(-1).action, 'read_current');
  assert.equal(h.writes, 2);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].sourceId, initialSourceId);
  const oldPath = h.file.path;
  h.file.path = '项目/研发/已改名.md';
  await publisherAfterRestart.renamed(h.file, oldPath);
  await publisherAfterRestart.publish(h.context);
  assert.equal(h.writes, 2);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].documentId, 'doc-1');
});
test('lost response retains exact original request and next click retrieves the original receipt without duplicating the write', async () => {
  const h = makeHarness();
  let failOnce = true;
  h.afterWrite = () => {
    if (failOnce) { failOnce = false; throw Error('test connection dropped after write'); }
  };
  await h.publisher.publish(h.context);
  assert.equal(h.writes, 1);
  const pending = structuredClone(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
  assert.equal(pending.action, 'sync_smart');
  await h.restart().publish(h.context);
  assert.equal(h.writes, 1);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].pending, undefined);
  assert.equal(h.requests.filter(r => r.action === 'sync_smart').length, 2);
  assert.deepEqual(h.requests.filter(r => r.action === 'sync_smart')[1],
    { action: pending.action, ...pending.payload });
  assert.ok(h.notices.some(s => s.includes('已发布到宙游文档中心')));
});
test('retry after unconfirmed non-applied response reuses exact saved request and operation ID', async () => {
  const h = makeHarness();
  let rejectedOnce = true;
  h.beforeWrite = () => {
    if (rejectedOnce) { rejectedOnce = false; return { status: 503, json: { code: 'DOWN' }, headers: {} }; }
  };
  await h.publisher.publish(h.context);
  const pending = structuredClone(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
  assert.equal(h.writes, 0);
  assert.equal(pending.action, 'sync_smart');
  await h.restart().publish(h.context);
  assert.equal(h.writes, 1);
  const attempts = h.requests.filter(b => b.action === 'sync_smart');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].pending, undefined);
});
test('an old incomplete pending request is not changed or silently resent after 404', async () => {
  const h = makeHarness();
  h.disk = { zhouyouAutoBindings: { [SOURCE_ID]: { sourceId: SOURCE_ID, path: h.file.path,
    pending: { operationId: '00000000-0000-4000-8000-000000000001', content: '', title: '' } } } };
  await h.publisher.publish(h.context);
  assert.equal(h.writes, 0);
  assert.deepEqual(h.requests.map(x => x.action), ['read_current']);
  assert.ok(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
  assert.ok(h.notices.some(s => s.includes('旧版发布遗留待确认')));
});
test('unknown 404 is not treated as permission to create; missing known document is not recreated', async () => {
  const h = makeHarness();
  h.responseForRead = () => ({ status: 404, json: { code: 'SOMETHING_ELSE' }, headers: {} });
  await h.publisher.publish(h.context);
  assert.equal(h.writes, 0);
  assert.deepEqual(h.requests.map(x => x.action), ['read_current']);
  const other = makeHarness();
  other.disk = { zhouyouAutoBindings: { [SOURCE_ID]: { sourceId: SOURCE_ID, path: other.file.path,
    documentId: 'doc-old', recordVersion: 5 } } };
  await other.publisher.publish(other.context);
  assert.equal(other.writes, 0);
  assert.ok(other.notices.some(s => s.includes('原文档不存在')));
});
test('a definite version conflict retries with a fresh baseline, no more than 3 attempts', async () => {
  const h = makeHarness();
  let conflictOnce = true;
  h.beforeWrite = () => {
    if (conflictOnce) { conflictOnce = false;
      return { status: 409, json: { code: 'OBSIDIAN_SYNC_RECORD_VERSION_CONFLICT' }, headers: {} };
    }
  };
  await h.publisher.publish(h.context);
  assert.deepEqual(h.requests.map(x => x.action),
    ['read_current', 'sync_smart', 'read_current', 'sync_smart', 'read_current']);
  assert.notEqual(h.requests[1].operationId, h.requests[3].operationId);
  assert.equal(h.writes, 1);
});
test('oversize payload is rejected locally before a write', async () => {
  const h = makeHarness('X'.repeat(2 * 1024 * 1024));
  await h.publisher.publish(h.context);
  assert.equal(h.writes, 0);
  assert.deepEqual(h.requests.map(x => x.action), ['read_current']);
  assert.ok(h.notices.some(s => s.includes('2MB')));
});
test('publishBody strips only legacy metadata and normalizes CRLF', () => {
  const body = '---\r\ngvid: ' + SOURCE_ID + '\r\nzhou_source_id: former\r\nname: keep\r\n---\r\nhello\r\n';
  assert.equal(publishBody(body), '---\ngvid: ' + SOURCE_ID + '\nname: keep\n---\nhello\n');
});

const OLD_OP = '00000000-0000-4000-8000-000000000001';
const PRIVATE_ROOT = '.obsidian/plugins/gvkit/';
function approveRecovery(h: ReturnType<typeof makeHarness>) {
  const pending = { operationId: OLD_OP, title: '原始标题', content: '原始正文' };
  h.disk = { otherSetting: { retained: true }, zhouyouAutoBindings: { [SOURCE_ID]: {
    sourceId: SOURCE_ID, path: h.file.path, pending,
  } } };
  const backupPath = 'zhouyou-legacy-backup-fixture.json', backup = JSON.stringify(h.disk);
  h.files[PRIVATE_ROOT + backupPath] = backup;
  h.files[PRIVATE_ROOT + 'zhouyou-legacy-recovery.json'] = JSON.stringify([{
    sourceIdHash: hash('obsidian-sync-diagnostic:v1:' + SOURCE_ID).slice(0, 24),
    oldOperationIdHash: hash('obsidian-sync-diagnostic:v1:' + OLD_OP).slice(0, 24),
    endpoint: ENDPOINT, backupPath, backupSha256: hash(backup),
  }]);
  return { pending, backupPath, backup };
}
test('reviewed legacy recovery preserves full backup and evidence; update/repeat/restart stay on one document', async () => {
  const h = makeHarness(), evidence = approveRecovery(h);
  const raw = h.raw;
  h.beforeWrite = (body, disk) => {
    assert.notEqual(body.operationId, OLD_OP);
    assert.equal(body.sourceId, SOURCE_ID);
    assert.equal(body.documentId, null);
    assert.equal(body.recordVersion, null);
    assert.deepEqual(disk.zhouyouAutoBindings[SOURCE_ID].legacyEvidence.pending, evidence.pending);
    assert.equal(disk.zhouyouAutoBindings[SOURCE_ID].legacyEvidence.oldOutcome, 'unknown');
    assert.equal(disk.zhouyouAutoBindings[SOURCE_ID].legacyEvidence.newOperationId, body.operationId);
  };
  await h.publisher.publish(h.context);
  assert.equal(h.writes, 1);
  assert.equal(h.raw, raw);
  assert.equal(h.files[PRIVATE_ROOT + evidence.backupPath], evidence.backup);
  h.beforeWrite = () => undefined;
  await h.restart().publish(h.context);
  assert.equal(h.writes, 1);
  h.raw += '修改一次\n';
  await h.restart().publish(h.context);
  assert.equal(h.writes, 2);
  assert.equal(h.remote.documentId, 'doc-1');
  assert.equal(h.remote.currentVersionNo, 2);
  assert.deepEqual(h.disk.zhouyouAutoBindings[SOURCE_ID].legacyEvidence.pending, evidence.pending);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].legacyEvidence.oldOutcome, 'unknown');
  assert.deepEqual(h.disk.otherSetting, { retained: true });
});
test('legacy recovery refuses stale backup, unreviewed source, changed endpoint and prior success', async () => {
  for (const change of [
    (h: any) => { h.files[PRIVATE_ROOT + 'zhouyou-legacy-backup-fixture.json'] += ' '; },
    (h: any) => { h.disk.zhouyouAutoBindings[SOURCE_ID].pending.operationId = 'different'; },
    (h: any) => { const p = PRIVATE_ROOT + 'zhouyou-legacy-recovery.json';
      h.files[p] = h.files[p].replace(ENDPOINT, 'https://other.example.test/sync'); },
    (h: any) => { h.disk.zhouyouAutoBindings[SOURCE_ID].version = 1; },
  ]) {
    const h = makeHarness(); approveRecovery(h); change(h);
    const pending = structuredClone(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
    await h.publisher.publish(h.context);
    assert.equal(h.writes, 0);
    assert.deepEqual(h.disk.zhouyouAutoBindings[SOURCE_ID].pending, pending);
    assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].legacyEvidence, undefined);
  }
});
test('reviewed legacy recovery pauses if current document appears, even with identical content', async () => {
  const h = makeHarness(); approveRecovery(h);
  h.remote = { sourceId: SOURCE_ID, documentId: 'existing', recordVersion: 1, currentVersionNo: 1,
    title: '原始标题', content: '原始正文', documentStatus: 'active' };
  await h.publisher.publish(h.context);
  assert.equal(h.writes, 0);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].documentId, undefined);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].pending.operationId, OLD_OP);
});
test('recovery conflict stops permanently pending reconciliation, including across restart', async () => {
  for (const code of ['OBSIDIAN_SYNC_RECORD_VERSION_CONFLICT', 'SOURCE_ALREADY_EXISTS']) {
    const h = makeHarness(); approveRecovery(h);
    h.beforeWrite = () => ({ status: 409, json: { code }, headers: {} });
    await h.publisher.publish(h.context);
    const pending = structuredClone(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
    assert.equal(h.requests.filter(r => r.action === 'sync_smart').length, 1);
    assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].legacyEvidence.blocked, true);
    await h.restart().publish(h.context);
    assert.equal(h.requests.filter(r => r.action === 'sync_smart').length, 1);
    assert.deepEqual(h.disk.zhouyouAutoBindings[SOURCE_ID].pending, pending);
  }
});
test('recovery lost ACK retrieves its receipt and independently verifies publication; never reuses legacy key', async () => {
  const h = makeHarness(); approveRecovery(h);
  h.afterWrite = () => { throw Error('lost ACK'); };
  await h.publisher.publish(h.context);
  const pending = structuredClone(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
  assert.notEqual(pending.operationId, OLD_OP);
  await h.restart().publish(h.context);
  assert.equal(h.writes, 1);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].pending, undefined);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].legacyEvidence.pending.operationId, OLD_OP);
});
test('recovery unsaved response reuses exact new request; changed identity cannot retry or confirm', async () => {
  const h = makeHarness(); approveRecovery(h);
  h.beforeWrite = () => ({ status: 503, json: { code: 'DOWN' }, headers: {} });
  await h.publisher.publish(h.context);
  const pending = structuredClone(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
  h.token = 'ANOTHER_FAKE_TOKEN';
  const calls = h.requests.length;
  await h.restart().publish(h.context);
  assert.equal(h.requests.length, calls);
  h.token = TOKEN;
  h.beforeWrite = () => undefined;
  await h.restart().publish(h.context);
  assert.equal(h.writes, 1);
  assert.deepEqual(h.requests.filter(r => r.action === 'sync_smart').map(r => r.operationId),
    [pending.operationId, pending.operationId]);
});
test('identity change while reading stops recovery before any save request', async () => {
  const h = makeHarness(); approveRecovery(h);
  h.responseForRead = () => { h.token = 'ANOTHER_FAKE_TOKEN'; };
  await h.publisher.publish(h.context);
  assert.equal(h.writes, 0);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].pending.operationId, OLD_OP);
});
test('recovery rejects archived, forbidden, unknown 404 and content-hash mismatch', async () => {
  for (const reply of [
    { status: 403, json: { code: 'FORBIDDEN' }, headers: {} },
    { status: 404, json: { code: 'UNKNOWN' }, headers: {} },
    { status: 200, json: { code: 0, data: { sourceId: SOURCE_ID, documentId: 'old',
      recordVersion: 1, title: 'x', content: 'x', documentStatus: 'archived' } }, headers: {} },
  ]) {
    const h = makeHarness(); approveRecovery(h);
    h.responseForRead = () => reply;
    await h.publisher.publish(h.context);
    assert.equal(h.writes, 0);
    assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].pending.operationId, OLD_OP);
  }
  const h = makeHarness(); approveRecovery(h);
  h.afterWrite = () => { h.remote.contentHash = 'incorrect'; };
  await h.publisher.publish(h.context);
  assert.ok(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].documentId, undefined);
});

test('saved current draft matching local is published when the published snapshot is older', async () => {
  const h = makeHarness();
  await h.publisher.publish(h.context);
  h.raw += '新草稿\n';
  h.remote.content = publishBody(h.raw);
  h.remote.contentHash = hash(h.remote.content);
  h.remote.recordVersion++;
  const prior = h.requests.length;
  await h.publisher.publish(h.context);
  assert.deepEqual(h.requests.slice(prior).map(r => r.action), ['read_current', 'sync_smart', 'read_current']);
  assert.equal(h.remote.currentVersionNo, 2);
  assert.equal(h.remote.publishedContentHash, hash(publishBody(h.raw)));
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].pending, undefined);
});

test('complete recovery pending cannot be cleared merely because current draft matches', async () => {
  const h = makeHarness(); approveRecovery(h);
  h.beforeWrite = () => ({ status: 503, json: { code: 'DOWN' }, headers: {} });
  await h.publisher.publish(h.context);
  const pending = structuredClone(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
  h.remote = { sourceId: SOURCE_ID, documentId: 'doc-concurrent', recordVersion: 2,
    currentVersionNo: 1, title: pending.payload.title, content: pending.payload.content,
    contentHash: hash(pending.payload.content), publishedContentHash: hash('older publication'),
    documentStatus: 'active' };
  const notices = h.notices.length;
  await h.restart().publish(h.context);
  assert.deepEqual(h.disk.zhouyouAutoBindings[SOURCE_ID].pending, pending);
  assert.equal(h.requests.filter(r => r.action === 'sync_smart').length, 2, 'original receipt is queried by exact replay');
  assert.ok(!h.notices.slice(notices).some(s => /已发布|原操作成功/.test(s)));
});

test('fully published same content is a read-only no-op with no new version', async () => {
  const h = makeHarness(); await h.publisher.publish(h.context);
  const calls = h.requests.length;
  await h.restart().publish(h.context);
  assert.equal(h.requests.length, calls + 1);
  assert.equal(h.writes, 1);
  assert.equal(h.remote.currentVersionNo, 1);
});

test('ACK followed by an old or missing publication snapshot retains pending and does not claim success', async () => {
  for (const publishedContentHash of [hash('old'), undefined, null]) {
    const h = makeHarness();
    h.afterWrite = () => { h.remote.publishedContentHash = publishedContentHash; };
    await h.publisher.publish(h.context);
    assert.ok(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
    assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].version, undefined);
    assert.ok(!h.notices.some(s => s.includes('已发布到宙游文档中心')));
  }
});

test('lost ACK followed by local edits settles the original request then publishes latest on the same document', async () => {
  const h = makeHarness();
  let once = true;
  h.afterWrite = () => { if (once) { once = false; throw Error('lost ACK'); } };
  await h.publisher.publish(h.context);
  const pending = structuredClone(h.disk.zhouyouAutoBindings[SOURCE_ID].pending);
  assert.ok(h.restart().statusLabel(h.context).includes('待确认'));
  h.raw += '继续修改\n';
  await h.restart().publish(h.context);
  const sent = h.requests.filter(r => r.action === 'sync_smart');
  assert.deepEqual(sent[1], { action: pending.action, ...pending.payload });
  assert.notEqual(sent[2].operationId, pending.operationId);
  assert.equal(sent[2].documentId, 'doc-1');
  assert.equal(h.writes, 2);
  assert.equal(h.remote.currentVersionNo, 2);
  assert.equal(h.remote.publishedContentHash, hash(publishBody(h.raw)));
  assert.equal(h.disk.zhouyouAutoBindings[SOURCE_ID].pending, undefined);
});
