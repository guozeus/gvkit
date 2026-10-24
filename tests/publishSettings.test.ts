import assert from 'node:assert/strict';
import test from 'node:test';
import { PublishSettings } from '../src/publishSettings.ts';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test('default shortcut is enabled and unrelated settings survive every save', async () => {
	const saved: Record<string, unknown>[] = [];
	const p = new PublishSettings({
		loadData: async () => ({ oldSetting: { version: 7 }, enabledElsewhere: false }),
		saveData: async (data) => { saved.push(structuredClone(data)); },
	});
	await p.load();
	assert.equal(p.getPublishShortcut(), true);
	await p.setPublishShortcut(false);
	assert.equal(p.getPublishShortcut(), false);
	assert.deepEqual(saved[0], {
		oldSetting: { version: 7 }, enabledElsewhere: false, publishShortcut: false,
	});
});

test('loads persisted false on restart and preserves true after another restart', async () => {
	let storage: Record<string, unknown> = {};
	const store = {
		loadData: async () => structuredClone(storage),
		saveData: async (data: Record<string, unknown>) => { storage = structuredClone(data); },
	};
	const one = new PublishSettings(store);
	await one.load();
	await one.setPublishShortcut(false);
	const two = new PublishSettings(store);
	await two.load();
	assert.equal(two.getPublishShortcut(), false);
	await two.setPublishShortcut(true);
	const three = new PublishSettings(store);
	await three.load();
	assert.equal(three.getPublishShortcut(), true);
});

test('all concurrent preference and future non-secret writes are serialized, never clobbered', async () => {
	const gate = deferred();
	const saved: Record<string, unknown>[] = [];
	let inFlight = 0;
	let peak = 0;
	const store = {
		loadData: async () => ({ existing: 'keep' }),
		saveData: async (data: Record<string, unknown>) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			if (saved.length === 0) await gate.promise;
			saved.push(structuredClone(data));
			inFlight -= 1;
		},
	};
	const p = new PublishSettings(store);
	await p.load();
	const first = p.setPublishShortcut(false);
	const second = p.updateNonSecret((data) => { data.nonSecretBinding = { id: 'local-placeholder' }; });
	const third = p.setPublishShortcut(true);
	gate.resolve();
	await Promise.all([first, second, third]);
	assert.equal(peak, 1);
	assert.equal(saved.length, 3);
	assert.deepEqual(saved.at(-1), {
		existing: 'keep', publishShortcut: true,
		nonSecretBinding: { id: 'local-placeholder' },
	});
});

test('a rejected save does not poison the queue and retry can persist', async () => {
	let attempt = 0;
	let storage: Record<string, unknown> = {};
	const p = new PublishSettings({
		loadData: async () => ({}),
		saveData: async (data) => {
			attempt += 1;
			if (attempt === 1) throw new Error('synthetic storage interruption');
			storage = { ...data };
		},
	});
	await p.load();
	await assert.rejects(p.setPublishShortcut(false));
	assert.equal(p.getPublishShortcut(), true);
	await p.setPublishShortcut(false);
	assert.equal(storage.publishShortcut, false);
});

test('late rejected older false request never overrides newer false after true', async () => {
	let rejectFirst!: (error: Error) => void;
	const firstGate = new Promise<void>((_, reject) => { rejectFirst = reject; });
	let signalFirstStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
	let calls = 0;
	let inFlight = 0;
	let peak = 0;
	let persisted: Record<string, unknown> = {};
	const preferences = new PublishSettings({
		loadData: async () => ({}),
		saveData: async (data) => {
			calls += 1;
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			try {
				if (calls === 1) {
					signalFirstStarted();
					await firstGate;
				}
				persisted = { ...data };
			} finally {
				inFlight -= 1;
			}
		},
	});
	await preferences.load();
	const first = preferences.setPublishShortcut(false);
	const second = preferences.setPublishShortcut(true);
	const third = preferences.setPublishShortcut(false);
	await firstStarted;
	rejectFirst(new Error('synthetic interruption'));
	const outcomes = await Promise.allSettled([first, second, third]);
	assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'fulfilled', 'fulfilled']);
	assert.equal(calls, 3);
	assert.equal(peak, 1);
	assert.equal(preferences.getPublishShortcut(), false, 'latest user intent stays false');
	assert.equal(persisted.publishShortcut, false, 'latest successful save is false');
});

test('latest rejected choice rolls back to last successfully persisted choice', async () => {
	let calls = 0;
	let persisted: Record<string, unknown> = {};
	const preferences = new PublishSettings({
		loadData: async () => ({}),
		saveData: async (data) => {
			calls += 1;
			if (calls === 2) throw new Error('synthetic last-save interruption');
			persisted = { ...data };
		},
	});
	await preferences.load();
	const first = preferences.setPublishShortcut(false);
	const last = preferences.setPublishShortcut(true);
	const outcomes = await Promise.allSettled([first, last]);
	assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'rejected']);
	assert.equal(persisted.publishShortcut, false);
	assert.equal(preferences.getPublishShortcut(), false, 'roll back to confirmed disk state, not previous optimistic choice');
});


test('URL setting serializes with shortcut and binding writes', async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let running = 0; let peak = 0; let calls = 0;
	let disk: Record<string, unknown> = {};
	const settings = new PublishSettings({
		loadData: async () => ({ binding: { version: 3 } }),
		saveData: async data => {
			calls += 1; running += 1; peak = Math.max(peak, running);
			try {
				if (calls === 1) await gate;
				disk = structuredClone(data);
			} finally { running -= 1; }
		},
	});
	await settings.load();
	const a = settings.setZhouyouUrl('https://one.test/api/producer-documents/obsidian-sync');
	const b = settings.setPublishShortcut(false);
	const c = settings.updateNonSecret(row => { row.binding = { version: 4 }; });
	const d = settings.setZhouyouUrl('https://two.test/api/producer-documents/obsidian-sync');
	release();
	await Promise.all([a, b, c, d]);
	assert.equal(peak, 1);
	assert.equal(disk.zhouyouSyncUrl, 'https://two.test/api/producer-documents/obsidian-sync');
	assert.equal(disk.publishShortcut, false);
	assert.deepEqual(disk.binding, { version: 4 });
});

test('latest URL interruption rolls back only to confirmed saved value', async () => {
	let attempts = 0; let disk: Record<string, unknown> = {};
	const settings = new PublishSettings({
		loadData: async () => ({}),
		saveData: async data => {
			attempts += 1;
			if (attempts === 2) throw Error('MOCK_STORAGE_INTERRUPTION');
			disk = structuredClone(data);
		},
	});
	await settings.load();
	const first = settings.setZhouyouUrl('https://one.test/api/producer-documents/obsidian-sync');
	const second = settings.setZhouyouUrl('https://two.test/api/producer-documents/obsidian-sync');
	const outcomes = await Promise.allSettled([first, second]);
	assert.deepEqual(outcomes.map(x => x.status), ['fulfilled', 'rejected']);
	assert.equal(settings.getZhouyouUrl(), disk.zhouyouSyncUrl);
	assert.equal(settings.getZhouyouUrl(), 'https://one.test/api/producer-documents/obsidian-sync');
});
