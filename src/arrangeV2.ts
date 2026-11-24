import { defaultArrangeState, moveInOrder, ARRANGE_ACTIONS, COMPLETION_SOUNDS, SUBMIT_BLUE_COLORS, DATE_HINT_COLORS, PIN_COLORS, type ArrangeItem, type ArrangeState } from './arrangeCore';
import { validDate } from './arrangeRepeat';

export const V2_ROOT = 'settings/gvkit/arrange-v2';
export const V2_ACTIVATION = `${V2_ROOT}/activation.md`;
export const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export interface Activation { schema: 2; epoch: string; state: ArrangeState; legacy: string }
export interface OrderIntent {
  kind: 'move' | 'top' | 'front' | 'remove'; ids: string[]; before?: string; after?: boolean;
  /** Pins at the time of the action, not mutable pin state at replay time. */
  pins: string[];
  added?: { id: string; before?: string }[];
  removed?: string[];
}
export interface ArrangeOperation {
  schema: 2; epoch: string; id: string; clock: number;
  parents: string[]; expected: Record<string, string>;
  changes: Record<string, unknown>; order?: OrderIntent;
  automatic?: { kind: 'rollover' | 'reminder'; day: string };
  /** Explicit user confirmation of the competing records seen for each field. */
  resolves?: Record<string, string[]>;
}
export interface Projection {
  state: ArrangeState; versions: Record<string, string>; clock: number;
  applied: Set<string>; deferred: Set<string>; conflicts: Set<string>;
  pending: Map<string, string[]>;
}
export const encodeV2 = (value: Activation | ArrangeOperation): string => `# GVKit Arrange v2\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
export function decodeV2(source: string): unknown {
  const prefix = '# GVKit Arrange v2\n\n```json\n', suffix = '\n```\n';
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) throw Error('v2 record incomplete');
  return JSON.parse(source.slice(prefix.length, -suffix.length));
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && (!/^[0-9a-f]{8}-/i.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0);
export function validSetting(key: string, value: unknown): boolean {
  const defaults = defaultArrangeState() as unknown as Record<string, unknown>;
  if (key.startsWith('achieved:')) return validDate(key.slice(9)) && typeof value === 'boolean';
  if (key === 'order') return strings(value) && new Set(value).size === value.length;
  if (key === 'dailyGoal') return value === null || (record(value) && validDate(value.day) && (value.id === null || identity(value.id))
    && (value.returnedId === undefined || identity(value.returnedId)));
  if (key === 'specialReminderDay') return value === null || (typeof value === 'string' && validDate(value));
  if (key === 'rewardsEnabledAt') return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
  if (key === 'achievedDays') return Array.isArray(value) && value.every(validDate);
  if (!Object.prototype.hasOwnProperty.call(defaults, key)) return false;
  if (key === 'timezone') { try { if (typeof value !== 'string') return false; new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }
  const enums: Record<string, readonly string[]> = { submitColor: Object.keys(SUBMIT_BLUE_COLORS), dateHintColor: Object.keys(DATE_HINT_COLORS),
    pinColor: Object.keys(PIN_COLORS), completionSound: Object.keys(COMPLETION_SOUNDS), completedStyle: ['background', 'text'],
    rootItemStyle: ['background', 'text', 'none'], selectionColor: ['blue', 'purple', 'gold'], swipeAction: ['none', ...ARRANGE_ACTIONS] };
  if (enums[key]) return typeof value === 'string' && enums[key]!.includes(value);
  if (key === 'rowActions' || key === 'detailActions') return Array.isArray(value) && value.every(x => ARRANGE_ACTIONS.includes(x));
  const fallback = defaults[key];
  if (Array.isArray(fallback)) return Array.isArray(value) && value.every(x => typeof x === 'string');
  return typeof value === typeof fallback && (typeof value !== 'number' || (Number.isFinite(value) && value >= 0));
}
export function activation(value: unknown): Activation {
  if (!record(value) || value.schema !== 2 || typeof value.epoch !== 'string' || !value.epoch || typeof value.legacy !== 'string' || !record(value.state)) throw Error('Invalid activation');
  const state = { ...defaultArrangeState(), ...value.state };
  for (const [key, field] of Object.entries(state)) if (!validSetting(key, field)) throw Error('Invalid baseline field: ' + key);
  return { schema: 2, epoch: value.epoch, state: state as ArrangeState, legacy: value.legacy };
}
export function operation(value: unknown): ArrangeOperation {
  if (!record(value) || value.schema !== 2 || typeof value.epoch !== 'string' || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value.id)
    || !Number.isSafeInteger(value.clock) || Number(value.clock) < 1 || !Array.isArray(value.parents) || !value.parents.every(p => typeof p === 'string')
    || !record(value.expected) || !Object.values(value.expected).every(p => typeof p === 'string') || !record(value.changes)) throw Error('Invalid operation');
  for (const [key, field] of Object.entries(value.changes)) if (key === 'order' || key === 'achievedDays' || !validSetting(key, field)) throw Error('Invalid operation field');
  if (value.order !== undefined) {
    const o = value.order;
    if (!record(o) || !['move', 'top', 'front', 'remove'].includes(String(o.kind)) || !strings(o.ids) || !Array.isArray(o.pins) || !o.pins.every(p => typeof p === 'string')
      || (o.before !== undefined && typeof o.before !== 'string') || (o.after !== undefined && typeof o.after !== 'boolean')) throw Error('Invalid move');
    if (o.added !== undefined && (!Array.isArray(o.added) || !o.added.every(v => record(v) && typeof v.id === 'string' && (v.before === undefined || typeof v.before === 'string')))) throw Error('Invalid additions');
    if (o.removed !== undefined && !strings(o.removed)) throw Error('Invalid removals');
    if (o.kind === 'move' && o.ids.length !== 1) throw Error('Invalid move targets');
  }
  if (value.automatic !== undefined && (!record(value.automatic) || !['rollover', 'reminder'].includes(String(value.automatic.kind)) || !validDate(value.automatic.day))) throw Error('Invalid business day');
  if (value.resolves !== undefined && (!record(value.resolves) || value.automatic !== undefined
    || !Object.entries(value.resolves).every(([field, ids]) => strings(ids) && ids.length > 0
      && (Object.prototype.hasOwnProperty.call(value.changes, field) || (field === 'order' && value.order !== undefined))))) throw Error('Invalid conflict confirmation');
  const expected = value.expected;
  for (const key of [...Object.keys(value.changes), ...(value.order ? ['order'] : []), ...(value.automatic ? ['dailyGoal'] : [])]) {
    if (!Object.prototype.hasOwnProperty.call(expected, key) || (expected[key] && !value.parents.includes(String(expected[key])))) throw Error('Missing causal precondition');
  }
  return value as unknown as ArrangeOperation;
}
export const businessKey = (op: ArrangeOperation): string | undefined => op.automatic ? `business:${op.epoch}:${op.automatic.kind}:${op.automatic.day}` : undefined;
export function applyOrder(order: string[], intent: OrderIntent): string[] {
  const removed = new Set(intent.removed ?? []);
  order = order.filter(id => !removed.has(id));
  for (const entry of intent.added ?? []) {
    if (order.includes(entry.id)) continue;
    const fixed = intent.pins.filter(id => id !== entry.id).map(id => ({id,pinned:true,completedAt:null} as ArrangeItem));
    order = moveInOrder(order, fixed, entry.id, entry.before);
  }
  const selected = new Set(intent.ids);
  if (intent.kind === 'remove') return order.filter(id => !selected.has(id));
  if (intent.kind === 'front') return [...intent.ids, ...order.filter(id => !selected.has(id))];
  const pins = intent.pins.map(id => ({ id, pinned: true, completedAt: null } as ArrangeItem));
  if (intent.kind === 'move') return moveInOrder(order, pins, intent.ids[0]!, intent.before, intent.after);
  // Explicit top stores selected order, so reminder chronology survives replay.
  const fixed = new Set(intent.pins.filter(id => !selected.has(id)));
  const movable = [...intent.ids.filter(id => order.includes(id)), ...order.filter(id => !selected.has(id) && !fixed.has(id))];
  let index = 0;
  return order.map(id => fixed.has(id) ? id : movable[index++]!);
}
/** Deterministic replay; missing dependencies defer one intent, never the whole store. */
export function project(base: Activation, operations: readonly ArrangeOperation[], invalid = new Set<string>()): Projection {
  const state = clone(base.state), versions: Record<string, string> = {}, applied = new Set<string>(), deferred = new Set<string>(), conflicts = new Set<string>();
  const sorted = operations.filter(op => op.epoch === base.epoch && !invalid.has(op.id)).sort((a, b) => a.clock - b.clock || a.id.localeCompare(b.id));
  const seen = new Map<string, ArrangeOperation>();
  for (const op of sorted) { const previous = seen.get(op.id); if (previous && !equal(previous, op)) invalid.add(op.id); seen.set(op.id, op); }
  const business = new Map<string, ArrangeOperation>();
  const pending = new Map<string, string[]>(), observed = new Set<string>();
  const isolate = (op: ArrangeOperation, fields: string[]) => {
    for (const field of fields) {
      const ids = new Set(pending.get(field) ?? []);
      if (versions[field]) ids.add(versions[field]!);
      ids.add(op.id); pending.set(field, [...ids].sort()); conflicts.add(field);
    }
  };
  let remaining = [...seen.values()].filter(op => !invalid.has(op.id)), clock = 0;
  while (remaining.length) {
    const later: ArrangeOperation[] = []; let progressed = false;
    for (const op of remaining) {
      clock = Math.max(clock, op.clock);
      if (op.parents.some(id => !applied.has(id)) || Object.values(op.resolves ?? {}).flat().some(id => !observed.has(id) && !applied.has(id))) { later.push(op); continue; }
      progressed = true; observed.add(op.id);
      const key = businessKey(op);
      if (key && applied.has(key)) {
        const accepted = business.get(key)!;
        if (equal([accepted.expected, accepted.changes, accepted.order], [op.expected, op.changes, op.order])) applied.add(op.id);
        else conflicts.add(op.id);
        continue;
      }
      const mismatches = Object.keys(op.expected).filter(field => (versions[field] ?? '') !== op.expected[field]);
      const touchedFields = [...Object.keys(op.changes), ...(op.order ? ['order'] : [])];
      const unresolved = Object.keys(op.expected).filter(field => pending.has(field)
        && !equal(op.resolves?.[field]?.slice().sort(), pending.get(field)));
      // A pending field is only a provisional display value. Never silently
      // overwrite it or release dependent writes without explicit confirmation.
      if (unresolved.length || (!op.automatic && mismatches.length)) {
        isolate(op, [...new Set([...touchedFields, ...unresolved, ...mismatches])]);
        continue;
      }
      // One atomic conflict-resolution decision: concurrent manual order wins,
      // while a still-current goal can finish rollover. A newer goal supersedes
      // the entire old rollover, but its logical result still releases successors.
      const skipOrder = !!op.automatic && mismatches.length > 0;
      if (op.automatic?.kind === 'rollover' && mismatches.includes('dailyGoal')) {
        conflicts.add(op.id); applied.add(key!); business.set(key!, op); continue;
      }
      const touched = [...Object.keys(op.changes), ...(op.order && !skipOrder ? ['order'] : [])];
      for (const field of mismatches) conflicts.add(field);
      for (const [field, value] of Object.entries(op.changes)) {
        if (field.startsWith('achieved:')) { const day = field.slice(9); state.achievedDays = state.achievedDays.filter(x => x !== day); if (value) state.achievedDays.push(day); }
        else (state as unknown as Record<string, unknown>)[field] = clone(value);
      }
      if (op.order && !skipOrder) state.order = applyOrder(state.order, op.order);
      for (const field of touched) {
        versions[field] = key ?? op.id;
        if (op.resolves?.[field]) { pending.delete(field); conflicts.delete(field); }
      }
      applied.add(op.id); if (key) { applied.add(key); business.set(key, op); }
    }
    if (!progressed) { for (const op of later) deferred.add(op.id); break; }
    remaining = later;
  }
  state.achievedDays.sort();
  return { state, versions, clock, applied, deferred, conflicts, pending };
}
