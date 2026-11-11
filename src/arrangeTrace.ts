// Device-local bounded diagnostics for the Arrange configuration only.
// Do not store YAML, note text, UUIDs, exception messages, or secrets.
const LIMIT = 240;

export interface ArrangeTraceDetail {
  run?: number;
  trigger?: string;
  stage?: string;
  chars?: number;
  fingerprint?: string;
  mtime?: number;
  size?: number;
  origin?: string;
  kind?: string;
  line?: number;
  column?: number;
}

interface TraceEntry {
  time: string;
  offsetMinutes: number;
  session: string;
  seq: number;
  version: string;
  platform: string;
  event: string;
  detail: ArrangeTraceDetail;
}

export function configFingerprint(source: string): Pick<ArrangeTraceDetail, 'chars' | 'fingerprint'> {
  // Quick correlation token, NOT a cryptographic hash or proof of origin.
  let value = 2166136261;
  for (let i = 0; i < source.length; i++) value = Math.imul(value ^ source.charCodeAt(i), 16777619);
  return { chars: source.length, fingerprint: 'fnv32:' + (value >>> 0).toString(16).padStart(8, '0') };
}

export class ArrangeTrace {
  private readonly events: TraceEntry[] = [];
  private readonly session = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  private seq = 0;
  private run = 0;
  private persistence: 'available' | 'failed' = 'available';

  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly key: string;
  private readonly version: string;
  private readonly platform: string;

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | null, key: string, version: string, platform: string) {
    this.storage = storage; this.key = key; this.version = version; this.platform = platform;
    try {
      if (!storage) throw new Error('storage unavailable');
      const saved: unknown = JSON.parse(storage.getItem(key) ?? '[]');
      if (Array.isArray(saved)) this.events.push(...saved.slice(-LIMIT) as TraceEntry[]);
    } catch {
      this.persistence = 'failed';
    }
  }

  nextRun(): number { return ++this.run; }

  record(event: string, detail: ArrangeTraceDetail = {}): void {
    try {
      const now = new Date();
      this.events.push({
        time: now.toISOString(), offsetMinutes: -now.getTimezoneOffset(), session: this.session,
        seq: ++this.seq, version: this.version, platform: this.platform, event, detail,
      });
      if (this.events.length > LIMIT) this.events.splice(0, this.events.length - LIMIT);
      if (!this.storage) throw new Error('storage unavailable');
      this.storage.setItem(this.key, JSON.stringify(this.events));
      this.persistence = 'available';
    } catch {
      // Diagnostic storage must never prevent reading or writing the user's notes.
      this.persistence = 'failed';
    }
  }

  failure(event: string, error: unknown, detail: ArrangeTraceDetail = {}): void {
    const value = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : {};
    const name = typeof value.name === 'string' ? value.name : '';
    const kind = /yaml/i.test(name) ? 'YamlError' : /syntax/i.test(name) ? 'SyntaxError' : /type/i.test(name) ? 'TypeError' : 'Error';
    const message = typeof value.message === 'string' ? value.message : '';
    const match = /line\s+(\d+)\s*,?\s*column\s+(\d+)/i.exec(message);
    this.record(event, { ...detail, kind, ...(match ? { line: Number(match[1]), column: Number(match[2]) } : {}) });
  }

  export(): { persistence: string; storage: string; limit: number; events: TraceEntry[] } {
    return { persistence: this.persistence, storage: 'device-local localStorage (not Obsidian Sync)',
      limit: LIMIT, events: this.events.slice() };
  }
}

export function deviceArrangeTrace(vaultName: string, version: string, platform: string): ArrangeTrace {
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { /* private browsing or restricted WebView */ }
  return new ArrangeTrace(storage, 'gvkit:arrange:config-trace:v1:' + vaultName, version, platform);
}
