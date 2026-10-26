import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { DeviceZhouyouSecret, guardIosSettingsInputs, LOCAL_SECRET_SELECTION, validSecretReference, type LocalPort } from '../src/publishSecretSettings.ts';
import { DEFAULT_ZHOUYOU_SECRET_REF, PublishSettings, checkZhouyouUrl } from '../src/publishSettings.ts';

function mock(values = new Map<string, string>(), local: Record<string, unknown> = {}) {
	const port: LocalPort = {
		secretStorage: {
			getSecret: id => values.get(id) ?? null,
			listSecrets: () => [...values.keys()],
			setSecret: (id, secret) => { values.set(id, secret); },
		},
		loadLocalStorage: key => local[key] ?? null,
		saveLocalStorage: (key, value) => {
			if (value === null) delete local[key];
			else local[key] = structuredClone(value);
		},
	};
	return { port, values, local };
}

test('endpoint accepts complete credential-free HTTP and HTTPS targets', () => {
	assert.deepEqual(checkZhouyouUrl(' http://192.0.2.5:18769/api/producer-documents/obsidian-sync '), {
		ok: true, value: 'http://192.0.2.5:18769/api/producer-documents/obsidian-sync',
	});
	assert.deepEqual(checkZhouyouUrl(' https://example.test/api/producer-documents/obsidian-sync '), {
		ok: true, value: 'https://example.test/api/producer-documents/obsidian-sync',
	});
	assert.deepEqual(checkZhouyouUrl(''), { ok: true, value: '' });
	const bad = [
		'ftp://example.test/api/producer-documents/obsidian-sync',
		'https://user:pwd@example.test/api/producer-documents/obsidian-sync',
		'https://example.test/api/producer-documents/obsidian-sync?key=secret',
		'https://example.test/api/producer-documents/obsidian-sync?',
		'https://example.test/api/producer-documents/obsidian-sync#x',
		'https://example.test/api/producer-documents/obsidian-sync/extra',
		'https://example.test/api/producer-documents/other',
		'https://example.test/api/producer-documents/../producer-documents/obsidian-sync',
	];
	for (const value of bad) assert.equal(checkZhouyouUrl(value).ok, false, value);
});

test('reference is not a Key: no fake secret leaks to status or local preference', () => {
	const fake = 'FAKE_KEY_FOR_MOCK_ONLY';
	const x = mock(new Map([[DEFAULT_ZHOUYOU_SECRET_REF, fake]]));
	const secret = new DeviceZhouyouSecret(x.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	assert.equal(secret.status(), 'configured');
	assert.equal(secret.reference(), DEFAULT_ZHOUYOU_SECRET_REF);
	assert.equal(JSON.stringify({ state: secret.status(), local: x.local }).includes(fake), false);
});

test('missing official API refuses setup and never downgrades to plain settings', () => {
	const x = mock();
	const secret = new DeviceZhouyouSecret({ ...x.port, secretStorage: { getSecret: () => 'FAKE' } }, () => DEFAULT_ZHOUYOU_SECRET_REF);
	assert.equal(secret.status(), 'unsupported');
	assert.throws(() => secret.select('local-secret'));
	assert.deepEqual(x.local, {});
	assert.equal(new DeviceZhouyouSecret({ ...x.port, secretStorage: null }, () => DEFAULT_ZHOUYOU_SECRET_REF).status(), 'unsupported');
});

test('same shared non-secret config does not grant a new device a secret', () => {
	const one = mock(new Map([[DEFAULT_ZHOUYOU_SECRET_REF, 'FAKE_A']]));
	const two = mock();
	const a = new DeviceZhouyouSecret(one.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	const b = new DeviceZhouyouSecret(two.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	assert.equal(a.status(), 'configured');
	assert.equal(b.status(), 'unconfigured');
});

test('clear only stops this device; original secret and another device survive', () => {
	const a = mock(new Map([[DEFAULT_ZHOUYOU_SECRET_REF, 'FAKE_A']]));
	const b = mock(new Map([[DEFAULT_ZHOUYOU_SECRET_REF, 'FAKE_B']]));
	const one = new DeviceZhouyouSecret(a.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	const two = new DeviceZhouyouSecret(b.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	one.stop();
	assert.equal(one.status(), 'stopped');
	assert.equal(two.status(), 'configured');
	assert.equal(a.values.has(DEFAULT_ZHOUYOU_SECRET_REF), true);
	assert.deepEqual(a.local[LOCAL_SECRET_SELECTION], { enabled: false, ref: DEFAULT_ZHOUYOU_SECRET_REF });
	one.enable();
	assert.equal(one.status(), 'configured');
});

test('device-level replacement changes no other device or shared reference', () => {
	const a = mock(new Map([['new-device-ref', 'FAKE_ROTATED']]));
	const b = mock(new Map([[DEFAULT_ZHOUYOU_SECRET_REF, 'FAKE_OLD']]));
	const one = new DeviceZhouyouSecret(a.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	const two = new DeviceZhouyouSecret(b.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	one.select('new-device-ref');
	assert.equal(one.status(), 'configured');
	assert.equal(two.status(), 'configured');
	assert.equal(two.reference(), DEFAULT_ZHOUYOU_SECRET_REF);
	one.stop();
	assert.equal(one.status(), 'stopped');
	assert.equal(two.status(), 'configured');
});

test('missing replaced value, invalid reference and unreadable opt-out deny access', () => {
	const x = mock();
	const secret = new DeviceZhouyouSecret(x.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	secret.select('new-secret');
	assert.equal(secret.status(), 'reconfigure');
	assert.equal(validSecretReference('NOT_VALID'), false);
	assert.throws(() => secret.select('NOT_VALID'));
	x.local[LOCAL_SECRET_SELECTION] = { broken: true };
	assert.equal(secret.status(), 'stopped');
	const unavailable = new DeviceZhouyouSecret({
		...x.port, loadLocalStorage: () => { throw Error('FAKE_LOCAL_IO'); },
	}, () => DEFAULT_ZHOUYOU_SECRET_REF);
	assert.equal(unavailable.status(), 'stopped');
});

test('local write interruption must not report a completed clear', () => {
	const x = mock(new Map([[DEFAULT_ZHOUYOU_SECRET_REF, 'FAKE_LOCAL']]));
	const secret = new DeviceZhouyouSecret({
		...x.port, saveLocalStorage: () => { throw Error('FAKE_LOCAL_WRITE'); },
	}, () => DEFAULT_ZHOUYOU_SECRET_REF);
	assert.throws(() => secret.stop());
	assert.equal(secret.status(), 'configured');
});

test('normal saveData never carries mocked secret value or per-device state', async () => {
	const fake = 'FAKE_VALUE_NOT_FOR_SETTINGS';
	const x = mock(new Map([[DEFAULT_ZHOUYOU_SECRET_REF, fake]]));
	const saves: Record<string, unknown>[] = [];
	let disk: Record<string, unknown> = { oldBinding: { documentId: 'doc42' }, publishShortcut: false };
	const settings = new PublishSettings({
		loadData: async () => structuredClone(disk),
		saveData: async data => { disk = structuredClone(data); saves.push(structuredClone(data)); },
	});
	await settings.load();
	const s = new DeviceZhouyouSecret(x.port, () => settings.getZhouyouSecretReference());
	assert.equal(s.status(), 'configured');
	await settings.setZhouyouUrl('https://example.test/api/producer-documents/obsidian-sync');
	s.stop();
	assert.equal(disk.zhouyouSecretRef, DEFAULT_ZHOUYOU_SECRET_REF);
	assert.deepEqual(disk.oldBinding, { documentId: 'doc42' });
	assert.equal(disk.publishShortcut, false);
	assert.equal(JSON.stringify(saves).includes(fake), false);
	assert.equal(JSON.stringify(saves).includes(LOCAL_SECRET_SELECTION), false);
});

/** An isolated real DOM fixture; restores process globals after each test. */
function iosDom() {
	const win = new Window();
	const oldDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const oldHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
	Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: win.document });
	Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, writable: true, value: win.HTMLElement });
	const meta = win.document.createElement('meta');
	meta.setAttribute('name', 'viewport');
	meta.setAttribute('content', 'width=device-width, initial-scale=1');
	win.document.head.appendChild(meta);
	const root = win.document.createElement('section');
	const input = win.document.createElement('input');
	const otherInput = win.document.createElement('input');
	const button = win.document.createElement('button');
	const outside = win.document.createElement('input');
	const nonEditableInput = win.document.createElement('input');
	nonEditableInput.type = 'button';
	root.append(input, otherInput, button, nonEditableInput);
	win.document.body.append(root, outside);
	const cleanup = () => {
		if (oldDoc) Object.defineProperty(globalThis, 'document', oldDoc);
		else Reflect.deleteProperty(globalThis, 'document');
		if (oldHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', oldHTMLElement);
		else Reflect.deleteProperty(globalThis, 'HTMLElement');
	};
	return { win, meta, root, input, otherInput, button, outside, nonEditableInput, cleanup };
}

test('iOS owned input pointerdown protects before focus and owned button focus releases viewport', async () => {
	const d = iosDom();
	let release: (() => void) | null = null;
	try {
		const initial = d.meta.content;
		release = guardIosSettingsInputs(d.root, true);
		d.input.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		assert.equal(d.win.document.activeElement === d.input, false, 'guard ran before focus');
		assert.equal(d.meta.content, initial + ', maximum-scale=1');
		d.input.focus();
		d.button.focus();
		await Promise.resolve();
		assert.equal(d.win.document.activeElement, d.button);
		assert.equal(d.meta.content, initial, 'own button is not editable and must release');
	} finally {
		release?.();
		d.cleanup();
	}
});

test('iOS input to another owned editable retains guard; leaving owned area restores exact host viewport', async () => {
	const d = iosDom();
	let release: (() => void) | null = null;
	try {
		d.meta.content = 'width=device-width, initial-scale=1, maximum-scale=2, user-scalable=yes';
		const initial = d.meta.content;
		release = guardIosSettingsInputs(d.root, true);
		d.input.dispatchEvent(new d.win.Event('touchstart', { bubbles: true }));
		d.input.focus();
		assert.equal(d.meta.content, 'width=device-width, initial-scale=1, user-scalable=yes, maximum-scale=1');
		d.otherInput.focus();
		await Promise.resolve();
		assert.equal(d.win.document.activeElement, d.otherInput);
		assert.equal(d.meta.content.includes('maximum-scale=1'), true, 'stay protected across own fields');
		d.outside.focus();
		await Promise.resolve();
		assert.equal(d.win.document.activeElement, d.outside);
		assert.equal(d.meta.content, initial, 'original host settings fully restored');
	} finally {
		release?.();
		d.cleanup();
	}
});

test('iOS scope avoids own non-editable and external controls; unload restores; host later changes are preserved', () => {
	const d = iosDom();
	let release: (() => void) | null = null;
	try {
		const initial = d.meta.content;
		release = guardIosSettingsInputs(d.root, true);
		d.outside.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		d.nonEditableInput.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		assert.equal(d.meta.content, initial, 'outside and button-type inputs must not activate');
		d.input.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		assert.equal(d.meta.content.includes('maximum-scale=1'), true);
		release();
		release = null;
		assert.equal(d.meta.content, initial, 'unload while active restores');
		d.input.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		assert.equal(d.meta.content, initial, 'destroyed listener no longer changes viewport');
		const disabled = guardIosSettingsInputs(d.root, false);
		d.input.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		assert.equal(d.meta.content, initial, 'non-iOS never changes viewport');
		disabled();
		release = guardIosSettingsInputs(d.root, true);
		d.input.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		const hostChanged = 'width=device-width, initial-scale=1, viewport-fit=cover';
		d.meta.content = hostChanged;
		release();
		release = null;
		assert.equal(d.meta.content, hostChanged, 'unload cannot overwrite another owner newer viewport');
	} finally {
		release?.();
		d.cleanup();
	}
});


test('cancelled iOS touch without focus must restore viewport', () => {
	const d = iosDom();
	const before = d.meta.content;
	const release = guardIosSettingsInputs(d.root, true);
	try {
		d.input.dispatchEvent(new d.win.Event('touchstart', { bubbles: true }));
		d.input.dispatchEvent(new d.win.Event('touchcancel', { bubbles: true }));
		assert.equal(d.win.document.activeElement === d.input, false);
		assert.equal(d.meta.content, before); // Original independent audit oracle, unchanged.
	} finally {
		release();
		d.cleanup();
	}
});

test('pointercancel without focus restores the viewport immediately', () => {
	const d = iosDom();
	const before = d.meta.content;
	const release = guardIosSettingsInputs(d.root, true);
	try {
		d.input.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		assert.equal(d.meta.content.includes('maximum-scale=1'), true);
		d.input.dispatchEvent(new d.win.Event('pointercancel', { bubbles: true }));
		assert.equal(d.meta.content, before);
	} finally {
		release();
		d.cleanup();
	}
});

test('unfocused touchend and pointerup restore after the native focus opportunity', async () => {
	for (const [start, end] of [['touchstart', 'touchend'], ['pointerdown', 'pointerup']]) {
		const d = iosDom();
		const before = d.meta.content;
		const release = guardIosSettingsInputs(d.root, true);
		try {
			d.input.dispatchEvent(new d.win.Event(start, { bubbles: true }));
			d.input.dispatchEvent(new d.win.Event(end, { bubbles: true }));
			assert.equal(d.meta.content.includes('maximum-scale=1'), true, 'end cannot prematurely drop focus protection');
			await new Promise(resolve => setTimeout(resolve, 380));
			assert.equal(d.win.document.activeElement === d.input, false);
			assert.equal(d.meta.content, before, end);
		} finally {
			release();
			d.cleanup();
		}
	}
});

test('focus arriving after touchend keeps protection across inputs until leaving editing', async () => {
	const d = iosDom();
	const before = d.meta.content;
	const release = guardIosSettingsInputs(d.root, true);
	try {
		d.input.dispatchEvent(new d.win.Event('touchstart', { bubbles: true }));
		d.input.dispatchEvent(new d.win.Event('touchend', { bubbles: true }));
		await new Promise(resolve => setTimeout(resolve, 30));
		d.input.focus();
		await new Promise(resolve => setTimeout(resolve, 380));
		assert.equal(d.meta.content.includes('maximum-scale=1'), true, 'late focus retains protection');
		d.otherInput.focus();
		await Promise.resolve();
		assert.equal(d.meta.content.includes('maximum-scale=1'), true, 'field switch retains protection');
		d.button.focus();
		await Promise.resolve();
		assert.equal(d.meta.content, before);
	} finally {
		release();
		d.cleanup();
	}
});

test('a later input gesture cancels an older unfocused-end restore', async () => {
	const d = iosDom();
	const before = d.meta.content;
	const release = guardIosSettingsInputs(d.root, true);
	try {
		d.input.dispatchEvent(new d.win.Event('touchstart', { bubbles: true }));
		d.input.dispatchEvent(new d.win.Event('touchend', { bubbles: true }));
		await new Promise(resolve => setTimeout(resolve, 200));
		d.otherInput.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		d.otherInput.dispatchEvent(new d.win.Event('pointerup', { bubbles: true }));
		await new Promise(resolve => setTimeout(resolve, 190));
		assert.equal(d.meta.content.includes('maximum-scale=1'), true, 'old timeout must not restore second gesture');
		await new Promise(resolve => setTimeout(resolve, 190));
		assert.equal(d.meta.content, before, 'second gesture eventually restores without focus');
	} finally {
		release();
		d.cleanup();
	}
});

test('unload cancels late restoration and host viewport edits survive a pending end', async () => {
	const d = iosDom();
	let release: (() => void) | null = null;
	try {
		const original = d.meta.content;
		release = guardIosSettingsInputs(d.root, true);
		d.input.dispatchEvent(new d.win.Event('touchstart', { bubbles: true }));
		d.input.dispatchEvent(new d.win.Event('touchend', { bubbles: true }));
		const hostChanged = 'width=device-width, initial-scale=1, viewport-fit=cover';
		d.meta.content = hostChanged;
		await new Promise(resolve => setTimeout(resolve, 380));
		assert.equal(d.meta.content, hostChanged, 'delayed check does not overwrite host');
		d.input.dispatchEvent(new d.win.Event('pointerdown', { bubbles: true }));
		d.input.dispatchEvent(new d.win.Event('pointerup', { bubbles: true }));
		release();
		release = null;
		assert.equal(d.meta.content, hostChanged, 'release restores only its own applied value');
		await new Promise(resolve => setTimeout(resolve, 380));
		assert.equal(d.meta.content, hostChanged, 'released timer must not run');
		assert.notEqual(d.meta.content, original);
	} finally {
		release?.();
		d.cleanup();
	}
});

test('device runtime revision detects same-reference replacement, stop/re-enable without exposing material', () => {
	const fake = mock(new Map([[DEFAULT_ZHOUYOU_SECRET_REF, 'FAKE_FIRST']]));
	const secret = new DeviceZhouyouSecret(fake.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	const before = secret.runtimeRevision();
	assert.equal(secret.runtimeRevision(), before);
	assert.equal(secret.runtimeCredential(), 'FAKE_FIRST');
	fake.values.set(DEFAULT_ZHOUYOU_SECRET_REF, 'FAKE_SECOND');
	const rotated = secret.runtimeRevision();
	assert.ok(rotated > before, 'same reference new Key invalidates prior operation');
	assert.equal(secret.runtimeRevision(), rotated);
	secret.stop();
	const stopped = secret.runtimeRevision();
	assert.ok(stopped > rotated);
	assert.equal(secret.runtimeCredential(), null);
	secret.enable();
	assert.ok(secret.runtimeRevision() > stopped);
	assert.equal(JSON.stringify(fake.local).includes('FAKE_FIRST'), false);
	assert.equal(JSON.stringify(fake.local).includes('FAKE_SECOND'), false);
	secret.disposeRuntime();
	assert.ok(secret.runtimeRevision() > 0);
});
test('runtime refuses missing/unsupported/local-revoked device secrets without affecting shared state', () => {
	const one = mock(new Map([[DEFAULT_ZHOUYOU_SECRET_REF, 'FAKE_A']]));
	const other = mock();
	const a = new DeviceZhouyouSecret(one.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	const b = new DeviceZhouyouSecret(other.port, () => DEFAULT_ZHOUYOU_SECRET_REF);
	assert.equal(a.runtimeCredential(), 'FAKE_A');
	assert.equal(b.runtimeCredential(), null);
	const fail = new DeviceZhouyouSecret({ ...one.port, loadLocalStorage: () => {
		throw Error('FAKE_LOCAL_IO_INCLUDING_CREDENTIAL');
	} }, () => DEFAULT_ZHOUYOU_SECRET_REF);
	assert.equal(fail.runtimeCredential(), null);
	assert.equal(a.status(), 'configured');
	assert.equal(b.status(), 'unconfigured');
});
