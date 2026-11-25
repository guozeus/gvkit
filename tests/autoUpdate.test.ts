import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const code = (await build({ entryPoints: ['src/autoUpdate.ts'], bundle: true, format: 'cjs',
	external: ['obsidian'], write: false })).outputFiles[0]!.text;

// Use a deterministic clock, public-release responses and a host with an actual
// enabled-instance slot. Keep simulated files separate from the running instance.
function fixture(fault = '') {
	let ticks = 3_600_000;
	const clock = { now: () => ticks };
	const requests: string[] = [], writes: string[] = [];
	let busy = false, sync = 'paused', fail = fault;
	const scheduled = new Map<number, () => Promise<void>>();
	const events = new Map<string, () => Promise<void>>();
	const win = { navigator: { onLine: true },
		setTimeout(fn: () => Promise<void>, delay: number) { scheduled.set(delay, fn); return delay; },
		setInterval(fn: () => Promise<void>, delay: number) { scheduled.set(delay, fn); return delay; },
		clearTimeout(delay: number) { scheduled.delete(delay); },
	};
	const doc = { defaultView: win, hidden: false, querySelector: () => null };
	const mod = { exports: {} as any };
	let latest: string;
	function files(version: string): Record<string, string> {
		return { 'main.js': 'js-' + version, 'styles.css': 'css-' + version,
			'manifest.json': JSON.stringify({ id: 'gvkit', version, minAppVersion: '1.13.0' }) };
	}
	async function requestUrl(url: string) {
		requests.push(url);
		if (url.includes('api.github.com')) {
			const version = url.endsWith('latest') ? latest : url.split('/').pop()!;
			return { json: { tag_name: version, draft: false, prerelease: fail === 'prerelease',
				assets: Object.entries(files(version)).map(([name, text]) => ({ name, size: text.length, state: 'uploaded' })) } };
		}
		const [version, name] = url.split('/').slice(-2);
		const text = files(version!)[name!]!;
		return { text, arrayBuffer: new ArrayBuffer(fail === 'partial' ? 1 : text.length), status: 200 };
	}
	new Function('module', 'exports', 'require', 'Date', code)(mod, mod.exports,
		() => ({ requestUrl, Platform: {}, requireApiVersion: () => true }), clock);
	const old = mod.exports.runningVersion;
	const target = (Number(old.split('.')[0]) + 1) + '.2.10';
	latest = target;
	const disk = files(old);
	let loaded: any;
	let dispose: () => void;
	const manager = { enabledPlugins: new Set(['gvkit']), getPlugin: () => loaded, loadManifest: async () => {},
		async disablePlugin(id: string) { assert.equal(id, 'gvkit'); dispose(); loaded = null; },
		async enablePlugin(id: string) {
			assert.equal(id, 'gvkit');
			const manifest = JSON.parse(disk['manifest.json']!);
			loaded = { manifest, runningVersion: manifest.version };
			return !(fail === 'load' && manifest.version === latest);
		},
	};
	const adapter = { exists: async (p: string) => p.split('/').pop()! in disk, read: async (p: string) => disk[p.split('/').pop()!]!,
		write: async (p: string, text: string) => {
			assert.ok(p.startsWith('config/plugins/gvkit/'));
			const name = p.split('/').pop()!;
			writes.push(name);
			if (fail === 'write' && name === 'styles.css') { fail = ''; throw Error('write interrupted'); }
			disk[name] = text;
		} };
	const plugin = { manifest: { id: 'gvkit', version: old, dir: 'config/plugins/gvkit' }, runningVersion: old,
		app: { plugins: manager, vault: { adapter }, internalPlugins: { getEnabledPluginById: () => ({ getStatus: () => sync }) },
			workspace: { containerEl: { ownerDocument: doc }, onLayoutReady: (f: () => void) => f(),
				on: () => {}, iterateAllLeaves: () => {} } },
		registerDomEvent(_target: unknown, name: string, fn: () => Promise<void>) { events.set(name, fn); },
		register(f: () => void) { dispose = f; }, registerEvent() {}, registerInterval() {} };
	loaded = plugin;
	mod.exports.registerAutoUpdate(plugin, () => busy, () => {});
	return { old, target, disk, files, requests, writes, scheduled, events, win, doc, plugin,
		loaded: () => loaded, busy: (v: boolean) => { busy = v; }, sync: (v: string) => { sync = v; },
		latest: (v: string) => { latest = v; }, advance: (v: number) => { ticks += v; } };
}

test('startup, visible resume and reconnect coalesce; hourly check activates a newer stable package', async () => {
	const f = fixture();
	f.latest(f.old);
	await f.scheduled.get(1500)!();
	await Promise.all([f.events.get('visibilitychange')!(), f.events.get('online')!()]);
	assert.equal(f.requests.length, 1);
	f.win.navigator.onLine = false;
	f.advance(3_600_000);
	await f.scheduled.get(3_600_000)!();
	assert.equal(f.requests.length, 1);
	f.win.navigator.onLine = true;
	f.latest(f.target);
	await f.events.get('online')!();
	assert.equal(f.loaded().runningVersion, f.target);
	assert.deepEqual(f.disk, f.files(f.target));
});
test('wait for pending work and Sync; an externally delivered complete package needs no writes', async () => {
	const f = fixture();
	f.busy(true);
	await f.scheduled.get(1500)!();
	assert.deepEqual(f.writes, []);
	f.busy(false); f.sync('syncing');
	await f.scheduled.get(15_000)!();
	assert.equal(f.loaded(), f.plugin);
	Object.assign(f.disk, f.files(f.target));
	f.sync('paused');
	await f.scheduled.get(15_000)!();
	assert.deepEqual(f.writes, []);
	assert.equal(f.loaded().runningVersion, f.target);
});
for (const fault of ['partial', 'prerelease', 'write', 'load']) {
	test('old version survives ' + fault, async () => {
		const f = fixture(fault);
		await f.scheduled.get(1500)!();
		assert.equal(f.loaded().runningVersion, f.old);
		assert.deepEqual(f.disk, f.files(f.old));
		if (fault === 'partial' || fault === 'prerelease') assert.deepEqual(f.writes, []);
	});
}
test('skip downgrades of running code and of a newer synchronized installation', async () => {
	const f = fixture();
	f.latest('0.0.1');
	await f.scheduled.get(1500)!();
	f.latest(f.target);
	Object.assign(f.disk, f.files(f.target.split('.')[0] + '.3.0'));
	f.advance(3_600_000);
	await f.scheduled.get(3_600_000)!();
	assert.deepEqual(f.writes, []);
	assert.equal(f.loaded(), f.plugin);
});
test('hourly timer completes a partial Sync delivery before switching the active instance', async () => {
	const f = fixture();
	f.latest(f.old);
	await f.scheduled.get(1500)!();
	f.latest(f.target);
	f.disk['manifest.json'] = f.files(f.target)['manifest.json']!;
	delete f.disk['styles.css'];
	f.advance(3_600_000);
	await f.scheduled.get(3_600_000)!();
	assert.deepEqual(f.writes, ['main.js', 'styles.css']);
	assert.deepEqual(f.disk, f.files(f.target));
	assert.equal(f.loaded().runningVersion, f.target);
});
