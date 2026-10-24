import type { CollabCurrent } from "./collabBoard";

export function validCollabPath(path: string): boolean {
  if (!path || path.length > 1024 || path.includes('\\') || path.includes('%') || path.startsWith('/')) return false;
  if (/[\u0000-\u001f\u007f\u2215\u2044\uff0f\uff3c]/u.test(path)) return false;
  const parts = path.split('/');
  return parts.length >= 2 && (parts[0] === '项目' || parts[0] === '安排') &&
    parts.every(p => !!p && !p.startsWith('.') && !['模板', 'template', 'templates', '内部控制', '控制'].includes(p.toLowerCase())) &&
    parts[parts.length - 1]!.toLowerCase().endsWith('.md') && parts[parts.length - 1]!.toLowerCase() !== '.md';
}
export function safeCurrent(value: unknown): CollabCurrent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  return typeof c.server_doc_uuid === 'string' && /^[0-9a-f-]{36}$/i.test(c.server_doc_uuid) &&
    typeof c.active === 'boolean' && ['epoch','revision','source_locator_revision'].every(k => Number.isSafeInteger(c[k]) && (c[k] as number) >= 0) &&
    (c.content_sha256 === null || (typeof c.content_sha256 === 'string' && /^[0-9a-f]{64}$/.test(c.content_sha256))) ? c as unknown as CollabCurrent : null;
}
