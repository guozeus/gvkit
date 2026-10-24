import test from 'node:test';
import assert from 'node:assert/strict';
import { validCollabPath, safeCurrent } from '../src/collabBoardCore.ts';
test('only exact eligible source paths may be published', () => {
    for (const p of ['项目/家园特快/设计.md','安排/策划/下周.md','项目/家园/开发日志/会议.md']) assert.equal(validCollabPath(p),true,p);
    for (const p of ['日志/私人.md','其他/私人.md','项目/.private.md','项目/模板/a.md','项目/a.txt','项目/../日志/a.md','项目/a%2Fb.md','项目\\a.md','项目/a.md/','项目//a.md']) assert.equal(validCollabPath(p),false,p);
});
test('confirmed current must be actual server shape', () => {
  const good = {server_doc_uuid:'ac025f15-0728-4254-b8e7-d915c188b618',active:true,epoch:1,revision:1,source_locator_revision:1,content_sha256:'a'.repeat(64)};
  assert.deepEqual(safeCurrent(good),good);
  assert.equal(safeCurrent({...good,revision:'1'}),null);
  assert.equal(safeCurrent({...good,content_sha256:'abc'}),null);
  assert.equal(safeCurrent({...good,server_doc_uuid:'not-uuid'}),null);
});
