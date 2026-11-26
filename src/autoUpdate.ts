import { Platform, requestUrl, requireApiVersion, type App, type Plugin } from 'obsidian';
import { version as runningVersion } from '../manifest.json';
import { syncState, type NativeSync } from './syncStatus';

export { runningVersion };
const id = 'gvkit';
const releases = 'https://api.github.com/repos/guozeus/gvkit/releases/';
const files = ['main.js', 'styles.css', 'manifest.json'] as const;
type FileName = typeof files[number];
type Bundle = Record<FileName, string>;
interface Release {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	assets: { name: string; size: number; state: string }[];
}
type LoadedPlugin = Plugin & { runningVersion?: string };
interface Manager {
	getPlugin(id: string): LoadedPlugin | null;
	loadManifest(dir: string): Promise<void>;
	disablePlugin(id: string): Promise<void>;
	enablePlugin(id: string): Promise<boolean>;
	enabledPlugins: Set<string>;
}
type Host = App & {
	plugins?: Manager;
	internalPlugins?: { getEnabledPluginById(id: string): NativeSync | null };
};
const hour = 3_600_000;
const cooldown = 60_000;
// A failed reload can create a fresh instance of the old plugin in the same app.
const lastCheck = Symbol.for('gvkit.lastReleaseCheck');
const stable = (v: string) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
export function newer(a: string, b: string): boolean {
	const previous = b.split('.').map(Number);
	for (const [i, n] of a.split('.').map(Number).entries()) {
		if (n !== previous[i]) return n > previous[i]!;
	}
	return false;
}

async function getRelease(path: string): Promise<Release> {
	const release: Release = (await requestUrl(releases + path)).json;
	if (release.draft !== false || release.prerelease !== false || !stable(release.tag_name))
		throw Error('Invalid stable release');
	return release;
}

export async function getLatestReleaseVersion(): Promise<string> {
	return (await getRelease('latest')).tag_name;
}

async function download(release: Release): Promise<Bundle> {
	const bundle = {} as Bundle;
	await Promise.all(files.map(async name => {
		const asset = release.assets.find(a => a.name === name && a.state === 'uploaded');
		if (!asset || !(asset.size > 0)) throw Error('Missing release file: ' + name);
		const url = 'https://github.com/guozeus/gvkit/releases/download/' + release.tag_name + '/' + name;
		const response = await requestUrl(url);
		if (response.status !== 200 || response.arrayBuffer.byteLength !== asset.size)
			throw Error('Incomplete release file: ' + name);
		bundle[name] = response.text;
	}));
	const manifest = JSON.parse(bundle['manifest.json']);
	if (manifest.id !== id || manifest.version !== release.tag_name || !stable(manifest.minAppVersion)
		|| !requireApiVersion(manifest.minAppVersion) || (Platform.isMobileApp && manifest.isDesktopOnly))
		throw Error('Invalid or incompatible GVKit manifest');
	return bundle;
}

export function registerAutoUpdate(plugin: LoadedPlugin, busy: () => boolean, beforeReload: () => void): void {
	const app = plugin.app as Host & { [lastCheck]?: number };
	const manager = app.plugins;
	const dir = plugin.manifest.dir;
	if (!dir || !manager?.getPlugin || !manager.loadManifest || !manager.disablePlugin
		|| !manager.enablePlugin || !manager.enabledPlugins) return;
	const doc = app.workspace.containerEl.ownerDocument;
	const win = doc.defaultView!;
	const adapter = app.vault.adapter;
	let disposed = false;
	let checking = false;
	let retry: number | undefined;
	let lastInput = 0;
	let pending: { version: string; target: Bundle; previous: Bundle; fetched: number } | undefined;

	function current(): boolean { return !disposed && manager!.getPlugin(id) === plugin; }
	function safe(): boolean {
		if (busy() || Date.now() - lastInput < 3000) return false;
		let modal = false;
		app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view.containerEl.ownerDocument.querySelector('.modal-container, .menu')) modal = true;
		});
		if (modal || doc.querySelector('.modal-container, .menu')) return false;
		const sync = syncState(app.internalPlugins?.getEnabledPluginById('sync'));
		return sync !== 'syncing' && sync !== 'connecting';
	}

	async function readFiles(): Promise<Record<FileName, string | null>> {
		const entries = await Promise.all(files.map(async name => {
			const path = dir + '/' + name;
			return [name, await adapter.exists(path) ? await adapter.read(path) : null];
		}));
		return Object.fromEntries(entries);
	}

	async function load(version: string): Promise<void> {
		await manager!.loadManifest(dir!);
		if (!manager!.enabledPlugins.has(id)) return;
		if (!await manager!.enablePlugin(id) || manager!.getPlugin(id)?.runningVersion !== version
			|| manager!.getPlugin(id)?.manifest.version !== version) throw Error('Failed to load GVKit ' + version);
	}

	async function install(update: NonNullable<typeof pending>): Promise<void> {
		if (!safe()) return;
		const before = await readFiles();
		const disk = before['manifest.json'] && JSON.parse(before['manifest.json']);
		if (disk && (disk.id !== id || !stable(disk.version) || newer(disk.version, update.version))) {
			pending = undefined;
			return;
		}
		if (!current() || !safe()) return;
		let switching = false;
		try {
			for (const name of files) {
				if (!current()) return;
				if (before[name] !== update.target[name]) await adapter.write(dir + '/' + name, update.target[name]);
			}
			// Sync or BRAT can deliver the same files independently. Only a complete,
			// matching set is eligible for activation, including an already-synced set.
			const installed = await readFiles();
			if (!current() || !safe() || files.some(n => installed[n] !== update.target[n])) return;
			beforeReload();
			switching = true;
			await manager!.disablePlugin(id);
			if (manager!.getPlugin(id)) throw Error('GVKit still loaded');
			await load(update.version);
			pending = undefined;
		} catch (error) {
			if (!switching && !current()) return;
			// The previous official package stays in memory: a Sync-mixed on-disk
			// snapshot would not be a reliable rollback source.
			if (switching && manager!.getPlugin(id) && manager!.getPlugin(id) !== plugin)
				await manager!.disablePlugin(id);
			for (const name of files) await adapter.write(dir + '/' + name, update.previous[name]);
			if (switching && !manager!.getPlugin(id)) await load(runningVersion);
			throw error;
		}
	}

	function later(delay: number): void {
		win.clearTimeout(retry);
		if (!disposed) retry = win.setTimeout(check, delay);
	}
	async function check(): Promise<void> {
		if (!current() || checking || win.navigator.onLine === false) return;
		checking = true;
		try {
			if (!pending || Date.now() - pending.fetched >= hour) {
				const remaining = (app[lastCheck] ?? 0) + cooldown - Date.now();
				if (remaining > 0) { later(remaining); return; }
				app[lastCheck] = Date.now();
				pending = undefined;
				const latest = await getRelease('latest');
				if (!current() || newer(runningVersion, latest.tag_name)) return;
				if (latest.tag_name === runningVersion && plugin.manifest.version === runningVersion) return;
				const previous = await getRelease('tags/' + runningVersion);
				if (previous.tag_name !== runningVersion) throw Error('Missing previous release');
				const [target, backup] = await Promise.all([download(latest), download(previous)]);
				pending = { version: latest.tag_name, target, previous: backup, fetched: Date.now() };
			}
			if (current()) await install(pending);
			if (pending && current()) later(15_000);
		} catch (error) {
			console.warn('gvkit: automatic update deferred', error);
			pending = undefined;
			later(5 * cooldown);
		} finally { checking = false; }
	}

	function listen(d: Document): void {
		const activity = () => { lastInput = Date.now(); };
		plugin.registerDomEvent(d, 'pointerdown', activity, true);
		plugin.registerDomEvent(d, 'keydown', activity, true);
		plugin.registerDomEvent(d, 'visibilitychange', () => { if (!d.hidden) void check(); });
	}
	listen(doc);
	plugin.registerEvent(app.workspace.on('window-open', (_window, w) => listen(w.document)));
	plugin.registerDomEvent(win, 'online', check);
	plugin.registerDomEvent(win, 'pageshow', check);
	plugin.registerInterval(win.setInterval(check, hour));
	plugin.register(() => { disposed = true; win.clearTimeout(retry); pending = undefined; });
	app.workspace.onLayoutReady(() => later(1500));
}
