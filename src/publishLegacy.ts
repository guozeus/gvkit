/** Device-only, user-initiated legacy inventory for ONE selected Markdown note.
 * This module does not import Obsidian, credentials, URLs, source text or IO APIs.
 * The host must implement the narrow port with its own trusted Obsidian adapter,
 * native TFile identity and actual rename-event evidence. Never call from AI tools,
 * startup scans or background listeners. Only whitelisted relation data is returned. */
import type { LegacyObservation } from './publishBindings';

const REFERENCE_PLUGIN_ID = 'zhouyou-producer-sync';
const FIELDS = [
	'zhou_source_id', 'zhou_document_id', 'zhou_product_id', 'zhou_record_version',
	'zhou_operation_id', 'zhou_operation_hash', 'zhou_operation_record_version',
	'zhou_operation_document_id',
] as const;
type OldField = typeof FIELDS[number];

export type NativeLegacyPath = 'current-file' | 'other-file' | 'absent' | 'unknown';
export interface LegacyNoteInput {
	/** Host has selected an eligible, current TFile and already parsed its frontmatter. */
	readonly path: string;
	readonly frontmatter: unknown;
}
/** Methods must be backed by Obsidian's configDir/adapter/native file index;
 * never user-supplied paths, legacy settings, or gvid/name/content guesses.
 * verifiedRenamedFrom must come from SAME TFile native rename evidence.
 * unrelatedOrphansProven may be true only if the native identity registry
 * independently excludes the selected TFile from ALL remaining orphan paths. */
export interface LegacyRuntimePort {
	readonly configDir: string;
	readonly verifiedRenamedFrom: readonly string[];
	readonly unrelatedOrphansProven?: boolean;
	existsConfigFile(exactAdapterPath: string): Promise<boolean>;
	readConfigFile(exactAdapterPath: string): Promise<string>;
	nativePath(path: string): Promise<NativeLegacyPath>;
}
function plain(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function own(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}
function safePath(path: unknown): path is string {
	return typeof path === 'string' && path.length > 0 && path.length <= 2048
		&& path === path.trim() && !/[\\\u0000-\u001f\u007f]/u.test(path)
		&& !path.startsWith('/') && !path.endsWith('/')
		&& path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function cleanFields(input: Record<string, unknown>): Record<OldField, unknown> | null {
	const fields = {} as Record<OldField, unknown>;
	for (const name of FIELDS) {
		if (!own(input, name)) continue;
		const value = input[name];
		// Never hand opaque objects or nested/private configuration to a caller.
		// Business ID, integer version, and pending semantics remain the job of
		// publishBindings. Invalid primitive values will fail its checks.
		if (value !== null && typeof value !== 'string' && typeof value !== 'number')
			return null;
		fields[name] = value;
	}
	return fields;
}
function combine(
	front: Readonly<Record<OldField, unknown>>,
	privateFields: Readonly<Record<OldField, unknown>>,
): Record<OldField, unknown> | null {
	const result = { ...front } as Record<OldField, unknown>;
	for (const name of FIELDS) {
		if (!own(privateFields, name)) continue;
		if (own(result, name) && result[name] !== privateFields[name]) return null;
		result[name] = privateFields[name];
	}
	return result;
}
function unknown(): LegacyObservation {
	return { inventory: 'unknown', fields: {} };
}
/** Explicitly opt-in, once for the currently selected note and target.
 * The port runs solely inside the installed app on that user's device;
 * JSON and extra configuration remain local in this function and NEVER escape.
 * The function does not write to the legacy file, current note or GVKit state.
 * When the port cannot prove an unambiguous complete inventory, fail closed. */
export async function observeLegacyForCurrentNote(
	note: LegacyNoteInput, port: LegacyRuntimePort,
): Promise<LegacyObservation> {
	if (!note || !port || !safePath(note.path) || !safePath(port.configDir)
		|| !Array.isArray(port.verifiedRenamedFrom)
		|| typeof port.existsConfigFile !== 'function'
		|| typeof port.readConfigFile !== 'function'
		|| typeof port.nativePath !== 'function') return unknown();
	if (!(note.frontmatter === null || plain(note.frontmatter))) return unknown();
	const front = cleanFields(note.frontmatter ?? {});
	if (!front) return unknown();
	try {
		if (await port.nativePath(note.path) !== 'current-file') return unknown();
		const dataPath = port.configDir + '/plugins/' + REFERENCE_PLUGIN_ID + '/data.json';
		if (!(await port.existsConfigFile(dataPath))) {
			return { inventory: 'checked', fields: front,
				origin: Object.keys(front).length ? 'note-fields' : 'none' };
		}
		const text = await port.readConfigFile(dataPath);
		const data: unknown = JSON.parse(text);
		if (!plain(data)) return unknown();
		const raw = own(data, 'noteBindings') ? data.noteBindings : {};
		if (!plain(raw)) return unknown();
		const bindings = raw as Record<string, unknown>;
		const previous = new Set<string>();
		for (const path of port.verifiedRenamedFrom) {
			if (!safePath(path)) return unknown();
			if (path !== note.path) previous.add(path);
		}
		let exact: Record<OldField, unknown> | null = null;
		let renamed: Record<OldField, unknown> | null = null;
		let renamedPath: string | null = null;
		let unresolvedOrphan = false;
		const otherRelations: Record<OldField, unknown>[] = [];
		for (const path of Object.keys(bindings)) {
			if (!safePath(path)) return unknown();
			const entry = bindings[path];
			if (!plain(entry)) return unknown();
			const fields = cleanFields(entry);
			if (!fields) return unknown();
			// Empty entries are not legacy identities, but malformed non-empty
			// whitelisted identities must go to the original core validator.
			if (path === note.path) {
				exact = fields;
				continue;
			}
			const status = await port.nativePath(path);
			if (status === 'unknown' || (status !== 'absent' && status !== 'other-file'
				&& status !== 'current-file')) return unknown();
			if (previous.has(path)) {
				if (status !== 'absent') return unknown();
				if (renamed !== null) return unknown(); // no arbitrary winner
				renamed = fields;
				renamedPath = path;
				continue;
			}
			if (status === 'current-file') return unknown(); // same file under two names
			otherRelations.push(fields);
			// A copied/forked old source can never be assumed a new independent file.
			if (own(front, 'zhou_source_id') && own(fields, 'zhou_source_id')
				&& front.zhou_source_id === fields.zhou_source_id) return unknown();
			if (status === 'absent' && Object.keys(fields).length > 0) unresolvedOrphan = true;
		}
		if (exact !== null && renamed !== null) return unknown();
		const selected = exact ?? renamed ?? front;
		// Even an exact current-path record must not mask another path claiming
		// the same stable source AND product: it may be a copied/conflicting note.
		if (own(selected, 'zhou_source_id') && own(selected, 'zhou_product_id')
			&& otherRelations.some(other => own(other, 'zhou_source_id')
				&& own(other, 'zhou_product_id')
				&& other.zhou_source_id === selected.zhou_source_id
				&& other.zhou_product_id === selected.zhou_product_id)) return unknown();
		if (renamed !== null && unresolvedOrphan && port.unrelatedOrphansProven !== true)
			return unknown();
		// An unrelated orphan does not identify this current TFile. It must not
		// prevent an independent lookup by this note's GVID.
		if (exact === null && renamed === null && Object.keys(front).length === 0)
			return { inventory: 'checked', fields: {}, origin: 'none',
				...(unresolvedOrphan && port.unrelatedOrphansProven !== true
					? { unresolvedOrphan: true } : {}) };
		if (exact === null && renamed === null && unresolvedOrphan
			&& port.unrelatedOrphansProven !== true) return unknown();
		const joined = combine(front, exact ?? renamed ?? ({} as Record<OldField, unknown>));
		if (!joined) return unknown();
		// This is the ONLY output: original whitelist plus checked/unknown;
		// no raw config, token, URL, path mapping or private notes exposed.
		return { inventory: 'checked', fields: joined,
			origin: exact ? 'path-only' : renamed ? 'native-rename-hint'
				: Object.keys(front).length ? 'note-fields' : 'none',
			...(exact || renamed ? { candidatePath: exact ? note.path : renamedPath! } : {}) };
	} catch {
		// No exception messages, parsed configuration or adapter paths escape.
		return unknown();
	}
}
