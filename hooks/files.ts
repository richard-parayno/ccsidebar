/**
 * Which files the main thread touched and how: git-style status per file and
 * the lines its changes added and removed, read off each tool's own record.
 */
import type { FileStatus, SidebarFile } from '../types'

const MAX_TRACKED = 200
const RANK: Record<FileStatus, number> = { read: 0, modified: 1, added: 2 }
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])

type Touch = { path: string; status: FileStatus; added: number; removed: number }

type Hunk = { lines?: unknown }
type WriteRecord = { type?: unknown; content?: unknown; structuredPatch?: unknown }

/** Lines a change added and removed, from its diff hunks or a created file's content. */
export function lineDelta(record: unknown): { added: number; removed: number } {
  const r = (record ?? {}) as WriteRecord
  if (r.type === 'create' && typeof r.content === 'string') {
    const body = r.content.replace(/\n$/, '')
    return { added: body === '' ? 0 : body.split('\n').length, removed: 0 }
  }
  const hunks = Array.isArray(r.structuredPatch) ? (r.structuredPatch as Hunk[]) : []
  const lines = hunks.flatMap(h => (Array.isArray(h.lines) ? (h.lines as unknown[]) : [])).filter((l): l is string => typeof l === 'string')
  return { added: lines.filter(l => l.startsWith('+')).length, removed: lines.filter(l => l.startsWith('-')).length }
}

/** What one successful tool call did to a file, or undefined when it touched none. */
export function touchOf(tool: string, input: Record<string, unknown>, record: unknown): Touch | undefined {
  const path = input.file_path ?? input.notebook_path
  if (typeof path !== 'string') return undefined
  if (tool === 'Read') return { path, status: 'read', added: 0, removed: 0 }
  if (tool === 'Write') {
    const status = (record as WriteRecord | undefined)?.type === 'create' ? 'added' : 'modified'
    return { path, status, ...lineDelta(record) }
  }
  if (EDIT_TOOLS.has(tool)) return { path, status: 'modified', ...lineDelta(record) }
  return undefined
}

/** Folds a touch in: the strongest status stands, deltas add up, the file moves to most recent. */
export function applyTouch(files: readonly SidebarFile[], touch: Touch): SidebarFile[] {
  const prev = files.find(f => f.path === touch.path)
  const next: SidebarFile = {
    path: touch.path,
    status: prev !== undefined && RANK[prev.status] >= RANK[touch.status] ? prev.status : touch.status,
    added: (prev?.added ?? 0) + touch.added,
    removed: (prev?.removed ?? 0) + touch.removed,
    reads: (prev?.reads ?? 0) + (touch.status === 'read' ? 1 : 0),
  }
  return [...files.filter(f => f.path !== touch.path), next].slice(-MAX_TRACKED)
}

/** Changed files first, then read ones, each most recent first. */
export function byImportance(files: readonly SidebarFile[]): SidebarFile[] {
  const recent = [...files].reverse()
  return [...recent.filter(f => f.status !== 'read'), ...recent.filter(f => f.status === 'read')]
}
