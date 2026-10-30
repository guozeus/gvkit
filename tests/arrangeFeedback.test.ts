import assert from 'node:assert/strict';
import test from 'node:test';
import { ArrangeFeedback } from '../src/arrangeFeedback.ts';

test('completion sound choices keep the original chime and produce distinct local notes', async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const tones: number[] = [];
	class Audio {
		state = 'running'; currentTime = 0; destination = {};
		createOscillator() { return { frequency: { set value(n: number) { tones.push(n); } }, connect() {}, disconnect() {}, start() {}, stop() {} }; }
		createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
		async close() {}
	}
	try {
		Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: Audio } });
		const feedback = new ArrangeFeedback(); feedback.prepare();
		feedback.play(); await Promise.resolve(); assert.deepEqual(tones.splice(0), [880, 1320]);
		feedback.play('bell'); await Promise.resolve(); assert.deepEqual(tones.splice(0), [1046.5, 1568]);
		feedback.play('bright'); await Promise.resolve(); assert.deepEqual(tones.splice(0), [784, 1046.5, 1568]);
		feedback.close();
	} finally { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('feedback unlocks in the gesture and waits for audio readiness; cleanup cancels late sound', async () => {
	const originals = new Map(['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	const vibrations: number[] = [], tones: any[] = [];
	let release!: () => void, context: any;
	class Audio {
		state = 'suspended'; currentTime = 1; destination = {}; closed = false;
		constructor() { context = this; }
		resume() { return new Promise<void>(resolve => { release = () => { this.state = 'running'; resolve(); }; }); }
		createOscillator() { const tone = { frequency: { value: 0 }, connect() {}, disconnect() {}, start() {}, stop() {} }; tones.push(tone); return tone; }
		createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
		async close() { this.closed = true; this.state = 'closed'; }
	}
	try {
		Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: Audio } });
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { vibrate: (ms: number) => { vibrations.push(ms); return true; } } });
		const feedback = new ArrangeFeedback(); feedback.prepare();
		assert.ok(release, 'resume was called synchronously before the first await');
		assert.equal(tones.length, 0); assert.deepEqual(vibrations, []);
		feedback.play(); assert.deepEqual(vibrations, [18]); assert.equal(tones.length, 0);
		release(); await Promise.resolve(); await Promise.resolve();
		assert.deepEqual(tones.map(t => t.frequency.value), [880, 1320]);
		feedback.close(); assert.equal(context.closed, true);
		const late = new ArrangeFeedback(); late.prepare(); late.play(); late.close(); release();
		await Promise.resolve(); await Promise.resolve(); assert.equal(tones.length, 2);
	} finally {
		for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});

test('unavailable audio or denied vibration never rejects completion feedback', async () => {
	const originals = new Map(['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	try {
		Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
		const feedback = new ArrangeFeedback(); feedback.prepare(); feedback.play(); feedback.close();
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { vibrate: () => { throw Error('denied'); } } });
		feedback.play(); await Promise.resolve();
	} finally {
		for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
