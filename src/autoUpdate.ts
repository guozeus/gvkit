import { Notice, Platform, requestUrl, requireApiVersion, type App, type Plugin } from 'obsidian';
import { version as runningVersion } from '../manifest.json';

export { runningVersion };
/** A live GVKit IME composition must finish before its editor can be replaced. */
export class GvkitUpdateDeferred extends Error {}
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
type Host = App & { plugins?: Manager };
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

/** Prepare only GVKit's local state. A cancelled switch must leave the old instance usable. */
export function registerAutoUpdate(plugin: LoadedPlugin, prepareReload: () => Promise<void>, cancelReload: () => void, canSwitch: () => boolean): void {
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
	let deferredIme = false;

	function current(): boolean { return !disposed && manager!.getPlugin(id) === plugin && manager!.enabledPlugins.has(id); }

	async function readFiles(): Promise<Record<FileName, string | null>> {
		const entries = await Promise.all(files.map(async name => {
			const path = dir + '/' + name;
			return [name, await adapter.exists(path) ? await adapter.read(path) : null];
		}));
		return Object.fromEntries(entries);
	}

	async function load(version: string): Promise<void> {
		await manager!.loadManifest(dir!);
		// disablePlugin removes the id from enabledPlugins on current Obsidian.
		// enablePlugin must be invoked, rather than silently returning here.
		if (!await manager!.enablePlugin(id)) throw Error('Failed to enable GVKit ' + version);
		const loaded = manager!.getPlugin(id);
		if (!loaded || loaded.runningVersion !== version || loaded.manifest.version !== version)
			throw Error('Failed to load GVKit ' + version);
	}

	async function install(version: string, target: Bundle, previous: Bundle): Promise<void> {
		const before = await readFiles();
		const completeOld = files.every(name => before[name] === previous[name]);
		const completeNew = files.every(name => before[name] === target[name]);
		// BRAT/Sync may be installing concurrently. Never adopt or overwrite a mixed package.
		if (!completeOld && !completeNew) throw Error('GVKit files changed by another installer');
		if (!current()) return;
		let disabled = false;
		try {
			await prepareReload();
			if (!current()) { cancelReload(); return; }
			const ready = await readFiles();
			if (files.some(name => ready[name] !== before[name])) { cancelReload(); return; }
			if (!canSwitch()) throw new GvkitUpdateDeferred('GVKit editor composition in progress');
			await manager!.disablePlugin(id);
			disabled = true;
			if (manager!.getPlugin(id)) throw Error('GVKit still loaded after disable');
			for (const name of files) {
					const path = dir + '/' + name;
					const disk = await adapter.read(path);
					if (disk !== before[name] && disk !== target[name]) throw Error('GVKit external install conflict: ' + name);
					if (disk !== target[name]) await adapter.write(path, target[name]);
			}
			const installed = await readFiles();
			if (files.some(name => installed[name] !== target[name])) throw Error('GVKit package changed during installation');
			await load(version);
		} catch (error) {
			if (!disabled && manager!.getPlugin(id) !== plugin) disabled = true;
			if (!disabled) cancelReload();
			if (disabled) {
				let recovered = false;
				try {
					const disk = await readFiles();
					if (files.every(name => disk[name] === before[name] || disk[name] === target[name])) {
						// Only restore our own known bytes; never overwrite a third installer.
						if (manager!.getPlugin(id)) await manager!.disablePlugin(id);
						for (const name of files) {
							if (disk[name] === previous[name]) continue;
							const path = dir + '/' + name;
							if (await adapter.read(path) !== disk[name]) throw Error('Package changed while restoring GVKit');
							await adapter.write(path, previous[name]);
						}
						await load(runningVersion);
						recovered = true;
					} else if (disk['manifest.json']) {
						// A third installer may have completed a different official release.
						// Verify the entire package before loading it without writing any bytes.
						const externalVersion: unknown = JSON.parse(disk['manifest.json']).version;
						if (typeof externalVersion === 'string' && stable(externalVersion)) {
							const external = await download(await getRelease('tags/' + externalVersion));
							const unchanged = await readFiles();
							if (files.every(name => disk[name] === external[name] && unchanged[name] === disk[name])) {
								if (manager!.getPlugin(id)) await manager!.disablePlugin(id);
								await load(externalVersion);
								recovered = true;
							}
						}
					}
				} catch (recoveryError) {
					console.error('gvkit: automatic update recovery failed', recoveryError);
				}
				if (!recovered) {
					console.error('gvkit: package conflict left GVKit disabled', error);
					new Notice('GVKit 自动更新中断，插件无法自动恢复。请在 Obsidian 设置 → 第三方插件中通过 BRAT 或手动重新安装完整正式版，再启用 GVKit。', 20000);
				}
			}
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
			const remaining = (app[lastCheck] ?? 0) + cooldown - Date.now();
			if (remaining > 0) { later(remaining); return; }
			app[lastCheck] = Date.now();
			const latest = await getRelease('latest');
			if (!current() || newer(runningVersion, latest.tag_name)) return;
			if (latest.tag_name === runningVersion && plugin.manifest.version === runningVersion) return;
			const prior = await getRelease('tags/' + runningVersion);
			if (prior.tag_name !== runningVersion) throw Error('Missing previous release');
			const [target, backup] = await Promise.all([download(latest), download(prior)]);
			if (current()) await install(latest.tag_name, target, backup);
		} catch (error) {
			if (error instanceof GvkitUpdateDeferred) {
				deferredIme = true;
				app[lastCheck] = Date.now() - cooldown;
				return; // Resume on this input's compositionend, not on general host activity.
			}
			console.warn('gvkit: automatic update failed', error);
			later(5 * cooldown);
		} finally { checking = false; }
	}

	function listen(d: Document): void {
		plugin.registerDomEvent(d, 'visibilitychange', () => { if (!d.hidden) void check(); });
		plugin.registerDomEvent(d, 'compositionend', () => {
			if (deferredIme) { deferredIme = false; later(100); }
		}, true);
	}
	listen(doc);
	plugin.registerEvent(app.workspace.on('window-open', (_window, w) => listen(w.document)));
	plugin.registerDomEvent(win, 'online', check);
	plugin.registerDomEvent(win, 'pageshow', check);
	plugin.registerInterval(win.setInterval(check, hour));
	plugin.register(() => { disposed = true; win.clearTimeout(retry); });
	app.workspace.onLayoutReady(() => later(1500));
}
