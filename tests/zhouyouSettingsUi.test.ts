import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

// Run the production settings handlers and client with DOM/Obsidian storage adapters.
const shim = `
export const notices = [];
export class Notice { constructor(message) { notices.push(message); } }
export class Modal {}
export class PluginSettingTab {
  constructor(app) { this.app = app; this.containerEl = document.createElement('div'); }
  hide() {}
}
export const Platform = { isIosApp: false };
export class Setting {
  constructor(root) { this.settingEl = root.createDiv({cls:'setting-item'}); }
  setName(name) { this.settingEl.createEl('label', {text:name}); return this; }
  setDesc(text) { this.settingEl.createEl('p', {text}); return this; }
  addText(fn) {
    const inputEl = this.settingEl.createEl('input');
    const control = { inputEl, setValue(v) { inputEl.value=v; return this; }, getValue() { return inputEl.value; },
      setPlaceholder(v) { inputEl.placeholder=v; return this; }, setDisabled(v) { inputEl.disabled=v; return this; } };
    fn(control); return this;
  }
  addButton(fn) {
    const buttonEl = this.settingEl.createEl('button');
    const control = { buttonEl, setButtonText(v) { buttonEl.textContent=v; return this; },
      setDisabled(v) { buttonEl.disabled=v; return this; }, onClick(fn) { buttonEl.onclick=fn; return this; } };
    fn(control); return this;
  }
}
`;

test('two explicit saves persist, reload and feed HTTP publishing without exposing or changing other secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gvkit-zhouyou-settings-'));
  const win = new Window();
  const previousDocument = globalThis.document;
  globalThis.document = win.document as any;
  const proto = win.HTMLElement.prototype as any;
  proto.createEl = function(tag: string, options: any = {}) {
    const el = win.document.createElement(tag);
    el.textContent = options.text ?? ''; el.className = options.cls ?? ''; this.appendChild(el); return el;
  };
  proto.createDiv = function(options: any) { return this.createEl('div', options); };
  try {
    const outfile = join(dir, 'settings.mjs');
    await build({ stdin: { contents: `
      export {GvkitSettingTab} from './src/fileIdSettings';
      export {PublishSettings,DEFAULT_ZHOUYOU_SECRET_REF} from './src/publishSettings';
      export {DeviceZhouyouSecret,LOCAL_SECRET_SELECTION} from './src/publishSecretSettings';
      export {ZhouyouClient,createZhouyouRequestUrlTransport} from './src/zhouyouClient';
      export {notices} from 'obsidian';`, resolveDir: process.cwd() },
      bundle: true, platform: 'node', format: 'esm', outfile,
      plugins: [{ name: 'obsidian-test', setup(b) {
        b.onResolve({filter:/^obsidian$/}, () => ({path:'obsidian', namespace:'shim'}));
        b.onLoad({filter:/.*/, namespace:'shim'}, () => ({contents:shim, loader:'js'}));
      } }],
    });
    const m = await import(pathToFileURL(outfile).href);
    let disk: any = { publishShortcut: false, zhouyouAutoBindings: { note: {documentId:'keep'} } };
    let failSave = false, failSecret = false;
    const store = { loadData: async () => structuredClone(disk), saveData: async (data: any) => {
      if (failSave) throw new Error('test save failure'); disk = structuredClone(data);
    } };
    const local: any = { [m.LOCAL_SECRET_SELECTION]: {enabled:true, ref:'other-plugin-secret'} };
    const secrets = new Map([['other-plugin-secret', 'FAKE_OLD_KEY']]);
    const app = {
      loadLocalStorage: (key: string) => local[key],
      saveLocalStorage: (key: string, value: unknown) => { local[key] = structuredClone(value); },
      secretStorage: {
        getSecret: (key: string) => secrets.get(key) ?? null, listSecrets: () => [...secrets.keys()],
        setSecret: (key: string, value: string) => { if (failSecret) throw new Error('test secret failure'); secrets.set(key, value); },
      },
    };
    const prefs = new m.PublishSettings(store); await prefs.load();
    const tab = new m.GvkitSettingTab(app, {}, {}, {}, () => prefs);
    const render = () => { tab.containerEl.innerHTML = ''; tab.renderZhouyou(prefs); };
    render();
    const root = tab.containerEl;
    assert.deepEqual([...root.querySelectorAll('label')].map((el: any) => el.textContent), ['地址', 'Key']);
    assert.deepEqual([...root.querySelectorAll('button')].map((el: any) => el.textContent), ['保存', '保存']);
    assert.equal(root.querySelectorAll('a,select').length, 0);
    let [urlInput, keyInput] = root.querySelectorAll('input');
    let [urlSave, keySave] = root.querySelectorAll('button');
    assert.equal(keyInput.type, 'password'); assert.equal(keyInput.value, '');
    assert.ok(keyInput.placeholder.includes('已保存'));
    const endpoint = 'http://192.0.2.5:18769/api/producer-documents/obsidian-sync';
    urlInput.value = endpoint;
    urlInput.dispatchEvent(new win.Event('change'));
    assert.equal(prefs.getZhouyouUrl(), '', 'editing alone does not save');
    await urlSave.onclick();
    assert.equal(disk.zhouyouSyncUrl, endpoint); assert.equal(m.notices.at(-1), '地址已保存');
    failSave = true; urlInput.value = endpoint.replace('18769', '18770');
    await urlSave.onclick();
    assert.equal(prefs.getZhouyouUrl(), endpoint); assert.equal(disk.zhouyouSyncUrl, endpoint);
    assert.ok(m.notices.at(-1).includes('未能保存')); assert.equal(urlSave.disabled, false);
    assert.ok(urlInput.value.includes('18770'), 'failed draft remains editable'); failSave = false;
    keyInput.value = ' FAKE_NEW_KEY ';
    keyInput.dispatchEvent(new win.Event('change'));
    assert.equal(secrets.size, 1, 'typing never writes a secret');
    keySave.onclick();
    assert.equal(secrets.get(m.DEFAULT_ZHOUYOU_SECRET_REF), 'FAKE_NEW_KEY');
    assert.equal(secrets.get('other-plugin-secret'), 'FAKE_OLD_KEY');
    assert.equal(keyInput.value, ''); assert.equal(m.notices.at(-1), 'Key 已保存');
    keySave.onclick(); assert.equal(secrets.get(m.DEFAULT_ZHOUYOU_SECRET_REF), 'FAKE_NEW_KEY');
    assert.equal(m.notices.at(-1), '请先填写 Key');
    failSecret = true; keyInput.value = 'FAKE_REPLACEMENT'; keySave.onclick();
    assert.ok(m.notices.at(-1).includes('未能保存')); failSecret = false;
    tab.dispose(); assert.equal(keyInput.value, ''); render();
    [urlInput, keyInput] = root.querySelectorAll('input');
    [urlSave, keySave] = root.querySelectorAll('button');
    assert.equal(urlInput.value, endpoint); assert.equal(keyInput.value, '');
    const reloaded = new m.PublishSettings(store); await reloaded.load();
    const runtime = new m.DeviceZhouyouSecret(app, () => reloaded.getZhouyouSecretReference());
    const requests: any[] = [];
    const client = new m.ZhouyouClient(reloaded.getZhouyouUrl(), () => runtime.runtimeCredential(),
      m.createZhouyouRequestUrlTransport(async (request: any) => {
        requests.push(request); return {status:200, text:JSON.stringify({code:0,data:{products:[]}})};
      }));
    assert.equal((await client.listProducts()).kind, 'acknowledged');
    assert.equal(requests[0].url, endpoint);
    assert.equal(requests[0].headers.authorization, 'Bearer FAKE_NEW_KEY');
    assert.deepEqual(disk.zhouyouAutoBindings, {note:{documentId:'keep'}});
    assert.equal(disk.publishShortcut, false);
    assert.ok(!JSON.stringify({disk,local,notices:m.notices,html:root.outerHTML}).includes('FAKE_'));
    tab.dispose();
  } finally {
    globalThis.document = previousDocument;
    await win.happyDOM.close(); await rm(dir, {recursive:true,force:true});
  }
});
