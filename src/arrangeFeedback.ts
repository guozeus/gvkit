/** Short, local completion feedback. No media download or native bridge. */
export class ArrangeFeedback {
	private context: AudioContext | null = null;
	private ready: Promise<void> = Promise.resolve();

	/** Call synchronously in the checkbox gesture, before any Vault awaits. */
	prepare(): void {
		try {
			const host = window as Window & { webkitAudioContext?: typeof AudioContext };
			const Audio = window.AudioContext ?? host.webkitAudioContext;
			if (!Audio) return;
			this.context ??= new Audio();
			if (this.context.state !== 'running') this.ready = this.context.resume().catch(() => {});
		} catch { /* Audio availability must never block completing an item. */ }
	}

	/** Only after a real, successful transition to completed. */
	play(): void {
		try { navigator.vibrate?.(18); } catch { /* Unsupported or denied. */ }
		const context = this.context;
		void this.ready.then(() => {
			if (!context || this.context !== context || context.state !== 'running') return;
			try {
				// A quiet ascending chime with a short attack and smooth decay.
				for (const [frequency, delay] of [[880, 0], [1320, 0.045]] as const) {
					const tone = context.createOscillator(), volume = context.createGain();
					const start = context.currentTime + delay;
					tone.type = 'sine'; tone.frequency.value = frequency;
					volume.gain.setValueAtTime(0, start);
					volume.gain.linearRampToValueAtTime(0.075, start + 0.004);
					volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
					tone.connect(volume); volume.connect(context.destination);
					tone.onended = () => { tone.disconnect(); volume.disconnect(); };
					tone.start(start); tone.stop(start + 0.14);
				}
			} catch { /* Completion has already been saved; feedback is optional. */ }
		});
	}

	close(): void {
		const context = this.context;
		this.context = null;
		if (context) void context.close().catch(() => {});
	}
}
