import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarkdownView, Menu, TFile, WorkspaceLeaf } from 'obsidian';
import { DocumentActions, isPublishableMarkdownPath } from '../src/documentActions.ts';
import { PublishSettings } from '../src/publishSettings.ts';

type Click = (event: MouseEvent | KeyboardEvent) => unknown;

class FakeItem {
	title = '';
	disabled = false;
	checked: boolean | null = null;
	click: Click = () => undefined;
	setTitle(value: string): this { this.title = value; return this; }
	setIcon(_icon: string): this { return this; }
	setDisabled(value: boolean): this { this.disabled = value; return this; }
	setChecked(value: boolean | null): this { this.checked = value; return this; }
	onClick(click: Click): this { this.click = click; return this; }
	fire(): void {
		if (!this.disabled) this.click({ clientX: 110, clientY: 44 } as MouseEvent);
	}
}
class FakeMenu {
	items: FakeItem[] = [];
	opened = false;
	position: { x: number; y: number } | null = null;
	addItem(callback: (item: FakeItem) => unknown): this {
		const item = new FakeItem();
		callback(item);
		this.items.push(item);
		return this;
	}
	showAtPosition(pos: { x: number; y: number }): this {
		this.opened = true;
		this.position = pos;
		return this;
	}
	item(title: string): FakeItem {
		const match = this.items.find((entry) => entry.title === title);
		assert.ok(match, 'missing menu item ' + title);
		return match;
	}
}
function file(path: string): TFile {
	return { path, extension: path.split('.').pop() } as unknown as TFile;
}
function makeLeaf(initial: TFile) {
	const buttons: Array<{ callback: (event: MouseEvent) => void; removed: boolean }> = [];
	const doc = { defaultView: { innerWidth: 320, innerHeight: 700 } };
	const view = {
		file: initial,
		getViewType: () => 'markdown',
		containerEl: {
			ownerDocument: doc,
			getBoundingClientRect: () => ({ right: 315, top: 8, bottom: 300 }),
		},
		addAction: (_icon: string, _title: string, callback: (event: MouseEvent) => void) => {
			const button = { callback, removed: false };
			buttons.push(button);
			return { remove() { button.removed = true; } } as HTMLElement;
		},
	} as unknown as MarkdownView;
	const leaf = { view } as WorkspaceLeaf;
	return { leaf, view, buttons };
}

function harness(paths = ['项目/游戏/A.md'], withHandler = true, suppliedPreferences?: {
	getPublishShortcut(): boolean;
	setPublishShortcut(value: boolean): Promise<void>;
}) {
	let leaves = paths.map((path) => makeLeaf(file(path)));
	let enabled = true;
	let saves = 0;
	const notices: string[] = [];
	const delivered: TFile[] = [];
	const menus: FakeMenu[] = [];
	const host = {
		getMarkdownLeaves: () => leaves.map(({ leaf }) => leaf),
		isMarkdownFile: (value: unknown): value is TFile =>
			!!value && typeof value === 'object' && (value as TFile).extension === 'md',
		createMenu: () => {
			const menu = new FakeMenu();
			menus.push(menu);
			return menu as unknown as Menu;
		},
		notify: (value: string) => notices.push(value),
		onZhouyouTarget: withHandler ? (context: { file: TFile; isCurrent(): boolean }) => {
			if (context.isCurrent()) delivered.push(context.file);
		} : undefined,
	};
	const preferences = {
		getPublishShortcut: () => enabled,
		setPublishShortcut: async (value: boolean) => { enabled = value; saves += 1; },
	};
	const actions = new DocumentActions(host, suppliedPreferences ?? preferences);
	const menu = (target: TFile, source = 'more-options', leaf?: WorkspaceLeaf) => {
		const result = new FakeMenu();
		actions.onFileMenu(result as unknown as Menu, target, source, leaf);
		return result;
	};
	return {
		actions, menu, menus, notices, delivered, preferences, get leaves() { return leaves; },
		setLeaves(value: typeof leaves) { leaves = value; },
		get enabled() { return enabled; }, get saves() { return saves; },
	};
}

test('publishability is independent of the broader gvid assignment path rule', () => {
	const allowed = ['项目/游戏/开发日志/记录.md', '安排/待执行/A.md', '资料/普通.md', '日志.md'];
	for (const path of allowed) assert.equal(isPublishableMarkdownPath(path), true, path);
	for (const path of [
		'日志/今天.md', '日志/子目录/a.md', '.obsidian/plugins/a.md',
		'settings/gvkit/prefs.md', 'settings/模板/a.md',
		'项目/.secret/A.md', '.private.md', 'a.canvas', '../A.md',
		'项目//A.md', '项目\\A.md', '/A.md',
	]) assert.equal(isPublishableMarkdownPath(path), false, path);
});

test('only more-options of a matching Markdown view gets both native items', () => {
	const h = harness();
	const entry = h.leaves[0]!;
	h.actions.refresh();
	assert.deepEqual(h.menu(entry.view.file!, 'file-explorer', entry.leaf).items, []);
	assert.deepEqual(h.menu(file('项目/游戏/A.md'), 'more-options', entry.leaf).items, []);
	assert.deepEqual(h.menu(entry.view.file!, 'more-options', entry.leaf).items.map((v) => v.title),
		['发布', 'GVKit功能项']);
	const other = makeLeaf(file('项目/游戏/B.md'));
	assert.equal(h.menu(entry.view.file!, 'more-options', other.leaf).items.length, 0);
});

test('missing leaf accepts exactly one live matching view but refuses ambiguous or unrelated files', () => {
	const h = harness();
	const a = h.leaves[0]!;
	assert.equal(h.menu(a.view.file!).items.length, 2);
	assert.equal(h.menu(file('项目/游戏/B.md')).items.length, 0);
	h.setLeaves([a, makeLeaf(a.view.file!)]);
	assert.equal(h.menu(a.view.file!).items.length, 0);
	h.setLeaves([a]);
	assert.equal(h.menu(a.view.file!).items.length, 2);
});

test('target selection uses captured file, never another active document', () => {
	const h = harness(['项目/游戏/A.md', '项目/游戏/B.md']);
	const a = h.leaves[0]!, b = h.leaves[1]!;
	const source = h.menu(b.view.file!, 'more-options', b.leaf);
	source.item('发布').fire();
	const target = h.menus.at(-1)!;
	assert.equal(target.opened, true);
	assert.equal(target.position?.x, 110);
	assert.equal(target.item('发布到协作板').disabled, false);
	target.item('发布到协作板').fire();
	assert.deepEqual(h.delivered, []);
	target.item('发布到宙游文档中心').fire();
	assert.deepEqual(h.delivered, [b.view.file]);
	assert.notEqual(h.delivered[0], a.view.file);
});

test('switch, close and old menu callbacks cannot publish another file', () => {
	const h = harness();
	const a = h.leaves[0]!;
	const old = h.menu(a.view.file!, 'more-options', a.leaf);
	a.view.file = file('项目/游戏/B.md');
	old.item('发布').fire();
	assert.equal(h.menus.length, 0);
	h.actions.refresh();
	const fresh = h.menu(a.view.file!, 'more-options', a.leaf);
	fresh.item('发布').fire();
	const selected = h.menus.at(-1)!;
	h.setLeaves([]);
	selected.item('发布到宙游文档中心').fire();
	assert.deepEqual(h.delivered, []);
});

test('switch away and back invalidates old callbacks after lifecycle refresh', () => {
	const h = harness();
	const a = h.leaves[0]!;
	const original = a.view.file!;
	const old = h.menu(original, 'more-options', a.leaf);
	a.view.file = file('项目/游戏/B.md');
	h.actions.refresh();
	a.view.file = original;
	h.actions.refresh();
	old.item('发布').fire();
	assert.equal(h.menus.length, 0);
});

test('checkbox defaults on, hides only own action and keeps native three-dot entry', async () => {
	const h = harness();
	const a = h.leaves[0]!;
	h.actions.refresh();
	assert.equal(a.buttons.length, 1);
	const menu = h.menu(a.view.file!, 'more-options', a.leaf);
	menu.item('GVKit功能项').fire();
	const feature = h.menus.at(-1)!;
	assert.equal(feature.item('发布').checked, true);
	feature.item('发布').fire();
	await Promise.resolve();
	assert.equal(h.enabled, false);
	assert.equal(h.saves, 1);
	assert.equal(a.buttons[0]?.removed, true);
	assert.equal(h.menu(a.view.file!, 'more-options', a.leaf).items.length, 2);
	h.actions.refresh();
	assert.equal(a.buttons.length, 1);
	h.menu(a.view.file!, 'more-options', a.leaf).item('GVKit功能项').fire();
	h.menus.at(-1)!.item('发布').fire();
	await Promise.resolve();
	assert.equal(h.enabled, true);
	assert.equal(a.buttons.length, 2);
	h.actions.refresh();
	assert.equal(a.buttons.length, 2);
});

test('existing/new views, disposal and hot reload clean buttons and callbacks', () => {
	const h = harness();
	const a = h.leaves[0]!;
	h.actions.refresh();
	const callback = a.buttons[0]!.callback;
	h.setLeaves([a, makeLeaf(file('项目/游戏/C.md'))]);
	h.actions.refresh();
	assert.equal(h.leaves[1]!.buttons.length, 1);
	h.actions.destroy();
	assert.equal(a.buttons[0]?.removed, true);
	assert.equal(h.leaves[1]!.buttons[0]?.removed, true);
	callback({ clientX: 100, clientY: 30 } as MouseEvent);
	assert.equal(h.menus.length, 0);
	h.actions.refresh();
	assert.equal(a.buttons.length, 1);
	const next = harness();
	next.actions.refresh();
	assert.equal(next.leaves[0]!.buttons.length, 1);
});

test('forbidden path has no top action, menu, or target invocation', () => {
	const h = harness(['日志/私密.md', 'settings/模板/系统.md', '项目/开发日志/允许.md']);
	h.actions.refresh();
	assert.equal(h.leaves[0]!.buttons.length, 0);
	assert.equal(h.leaves[1]!.buttons.length, 0);
	assert.equal(h.leaves[2]!.buttons.length, 1);
	for (const entry of h.leaves.slice(0, 2)) {
		assert.equal(h.menu(entry.view.file!, 'more-options', entry.leaf).items.length, 0);
	}
	assert.deepEqual(h.delivered, []);
});

test('without an injected target handler, the UI only reports local configuration needed', () => {
	const h = harness(['项目/游戏/A.md'], false);
	const a = h.leaves[0]!;
	h.menu(a.view.file!, 'more-options', a.leaf).item('发布').fire();
	h.menus.at(-1)!.item('发布到宙游文档中心').fire();
	assert.deepEqual(h.delivered, []);
	assert.deepEqual(h.notices, ['请先配置宙游文档中心。']);
});

test('latest save rejection restores the top icon to the persisted preference', async () => {
	let attempts = 0;
	const settings = new PublishSettings({
		loadData: async () => ({ publishShortcut: true }),
		saveData: async () => {
			attempts += 1;
			throw new Error('synthetic write interruption');
		},
	});
	await settings.load();
	const h = harness(['项目/游戏/A.md'], true, settings);
	const current = h.leaves[0]!;
	h.actions.refresh();
	assert.equal(current.buttons.length, 1);
	assert.equal(current.buttons[0]?.removed, false);
	h.menu(current.view.file!, 'more-options', current.leaf).item('GVKit功能项').fire();
	h.menus.at(-1)!.item('发布').fire();
	assert.equal(settings.getPublishShortcut(), false);
	assert.equal(current.buttons[0]?.removed, true, 'optimistic choice hides the top icon immediately');

	// The real save queue and menu rejection handler settle before the next event-loop turn.
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(attempts, 1);
	assert.equal(settings.getPublishShortcut(), true, 'reverted to persisted value');
	assert.equal(current.buttons.length, 2, 'top icon restored when latest save is rejected');
	assert.equal(current.buttons[1]?.removed, false);
	assert.deepEqual(h.notices, ['快捷图标设置未保存，请重试。']);
	assert.equal(h.menu(current.view.file!, 'more-options', current.leaf).items.length, 2);
});
