// Device-local bounded diagnostics for Arrange configuration write/read boundaries.
// Do not store YAML, note text, item UUIDs, user content, exception messages, or secrets.
const LIMIT = 240;
const INCIDENT_LIMIT = 6;
const INCIDENT_CONTEXT = 36;
const IMPORTANT_EVENT = /^v2\.|^(?:plugin\.initialize|view\.open|load\.start|config\.read\.ok|config\.parse\.ok|day_rollover\.(?:start|ok)|special_reminders\.(?:start|ok)|write\.(?:start|source|candidate|process\.ok|readback\.ok|readback\.mismatch|noop)|vault\.(?:modify|observe))$|fail|invalid|conflict|mismatch/;
const IS_ANOMALY = /fail|invalid|conflict|mismatch/;

export interface ArrangeTraceDetail {
  operationId?: string;
  epoch?: string;
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
  sourceFingerprint?: string;
  candidateFingerprint?: string;
  readbackFingerprint?: string;
  keys?: string[];
}

interface TraceEntry {
  time: string;
  offsetMinutes: number;
  device?: string;
  session: string;
  seq: number;
  version: string;
  platform: string;
  event: string;
  detail: ArrangeTraceDetail;
  count?: number;
  lastTime?: string;
  lastRun?: number;
  lastTrigger?: string;
}
interface Incident {
  time: string;
  event: string;
  events: TraceEntry[];
}

export function configFingerprint(source: string): Pick<ArrangeTraceDetail, 'chars' | 'fingerprint'> {
  // Stable correlation token, NOT a cryptographic hash or proof of which client wrote a file.
  let value = 2166136261;
  for (let i = 0; i < source.length; i++) value = Math.imul(value ^ source.charCodeAt(i), 16777619);
  return { chars: source.length, fingerprint: 'fnv32:' + (value >>> 0).toString(16).padStart(8, '0') };
}

export class ArrangeTrace {
  private readonly events: TraceEntry[] = [];
  private readonly incidents: Incident[] = [];
  private readonly session = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  private readonly device: string;
  private seq = 0;
  private run = 0;
  private persistence: 'available' | 'failed' = 'available';

  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly key: string;
  private readonly version: string;
  private readonly platform: string;

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | null, key: string, version: string, platform: string) {
    this.storage = storage; this.key = key; this.version = version; this.platform = platform;
    this.device = 'd-' + Math.random().toString(36).slice(2, 12);
    try {
      if (!storage) throw new Error('storage unavailable');
      let savedDevice = storage.getItem(key + ':device');
      if (!savedDevice) {
        savedDevice = this.device;
        storage.setItem(key + ':device', savedDevice);
      }
      // Persist the ID without exposing any device identifiers or platform secrets.
      this.device = savedDevice;
      const saved: unknown = JSON.parse(storage.getItem(key) ?? '[]');
      if (Array.isArray(saved)) this.events.push(...saved.slice(-LIMIT) as TraceEntry[]);
      const incidents: unknown = JSON.parse(storage.getItem(key + ':incidents') ?? '[]');
      if (Array.isArray(incidents)) this.incidents.push(...incidents.slice(-INCIDENT_LIMIT) as Incident[]);
    } catch {
      this.persistence = 'failed';
    }
  }

  nextRun(): number { return ++this.run; }

  record(event: string, detail: ArrangeTraceDetail = {}): void {
    if (!IMPORTANT_EVENT.test(event)) return; // No ordinary click or item-level interaction stream.
    try {
      const now = new Date(), anomalous = IS_ANOMALY.test(event);
      const previous = anomalous && detail.fingerprint
        ? [...this.events].reverse().find(entry => entry.event === event && entry.detail.fingerprint === detail.fingerprint
            && entry.detail.stage === detail.stage && Date.now() - Date.parse(entry.lastTime ?? entry.time) < 300_000)
        : undefined;
      if (previous) {
        previous.count = (previous.count ?? 1) + 1;
        previous.lastTime = now.toISOString(); previous.lastRun = detail.run; previous.lastTrigger = detail.trigger;
      } else {
        this.events.push({
          time: now.toISOString(), offsetMinutes: -now.getTimezoneOffset(), device: this.device,
          session: this.session, seq: ++this.seq, version: this.version, platform: this.platform, event, detail,
        });
      }
      if (this.events.length > LIMIT) this.events.splice(0, this.events.length - LIMIT);
      if (anomalous && !previous) {
        this.incidents.push({ time: now.toISOString(), event, events: this.events.slice(-INCIDENT_CONTEXT) });
        if (this.incidents.length > INCIDENT_LIMIT) this.incidents.splice(0, this.incidents.length - INCIDENT_LIMIT);
      }
      if (!this.storage) throw new Error('storage unavailable');
      this.storage.setItem(this.key, JSON.stringify(this.events));
      if (anomalous && !previous) this.storage.setItem(this.key + ':incidents', JSON.stringify(this.incidents));
      this.persistence = 'available';
    } catch {
      // Diagnostics must never prevent reading or writing the producer's notes.
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

  export(): { persistence: string; storage: string; limit: number; device: string; events: TraceEntry[]; incidents: Incident[] } {
    return {
      persistence: this.persistence, storage: 'device-local localStorage (not Obsidian Sync)',
      limit: LIMIT, device: this.device, events: this.events.slice(), incidents: this.incidents.slice(),
    };
  }
}

export function deviceArrangeTrace(vaultName: string, version: string, platform: string): ArrangeTrace {
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { /* private browsing or restricted WebView */ }
  return new ArrangeTrace(storage, 'gvkit:arrange:config-trace:v1:' + vaultName, version, platform);
}
