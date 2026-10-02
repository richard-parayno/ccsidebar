/**
 * The main thread's prompt cache: which TTL the engine asks for, how long the
 * last request's entry has left, and whether the next request will read it.
 */
import type { CacheTtl, SidebarCache } from '../types'
import type { Pixel } from './pixels'

export const TTL_MS: Record<Exclude<CacheTtl, 'off'>, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

/** Cache write over cache read, per TTL: what a miss costs the prefix against a hit. */
export const MISS_COST: Record<Exclude<CacheTtl, 'off'>, number> = { '5m': 1.25 / 0.1, '1h': 2 / 0.1 }

export type TtlInputs = {
  disabled?: string
  force5m?: string
  envTtl?: string
  settingTtl?: unknown
  enable1h?: string
  isSubscriber: boolean
  isOverage: boolean
}

const isTtl = (v: unknown): v is '5m' | '1h' => v === '5m' || v === '1h'
const isSet = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'

/** The engine's own order: env, then settings, then subscription and overage. */
export function resolveTtl(i: TtlInputs): { ttl: CacheTtl; reason: string } {
  if (isSet(i.disabled)) return { ttl: 'off', reason: 'disabled by env' }
  if (isSet(i.force5m)) return { ttl: '5m', reason: 'forced by env' }
  if (isTtl(i.envTtl)) return { ttl: i.envTtl, reason: 'set by env' }
  if (isTtl(i.settingTtl)) return { ttl: i.settingTtl, reason: 'set in settings' }
  if (isSet(i.enable1h)) return { ttl: '1h', reason: 'enabled by env' }
  if (!i.isSubscriber) return { ttl: '5m', reason: 'API default' }
  if (i.isOverage) return { ttl: '5m', reason: 'in overage' }
  return { ttl: '1h', reason: 'subscriber' }
}

export type Verdict = 'hit' | 'miss' | 'partial' | 'cold' | 'off'

export type Prediction = {
  verdict: Verdict
  /** Time the entry has left, negative once expired; absent with no entry. */
  leftMs?: number
  /** Share of the TTL left, 0 to 1. */
  fraction: number
}

export function predict(c: SidebarCache, now: number): Prediction {
  if (c.ttl === 'off') return { verdict: 'off', fraction: 0 }
  if (c.lastRequestAt === undefined) return { verdict: 'cold', fraction: 0 }
  const ttlMs = TTL_MS[c.ttl]
  const leftMs = c.lastRequestAt + ttlMs - now
  const fraction = Math.min(1, Math.max(0, leftMs / ttlMs))
  if (leftMs <= 0 || c.pending === 'model') return { verdict: 'miss', leftMs, fraction }
  if (c.pending !== undefined) return { verdict: 'partial', leftMs, fraction }
  return { verdict: 'hit', leftMs, fraction }
}

/** Twelve cells around a 5x5 square, clockwise from twelve o'clock. */
export const RING: readonly (readonly [number, number])[] = [
  [0, 2], [0, 3], [1, 4], [2, 4], [3, 4], [4, 3], [4, 2], [4, 1], [3, 0], [2, 0], [1, 0], [0, 1],
]

/**
 * A countdown ring: the lit arc runs from the sweeping hand clockwise back to
 * twelve, so it empties the way a kitchen timer does. `head` is the hand.
 */
export function ringGrid(fraction: number, cells: { on: Pixel; head: Pixel; off: Pixel; center?: Pixel }): (Pixel | undefined)[][] {
  const grid: (Pixel | undefined)[][] = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => undefined))
  const lit = fraction <= 0 ? 0 : Math.ceil(fraction * RING.length)
  const first = RING.length - lit
  RING.forEach(([r, col], i) => {
    const rowCells = grid[r]
    if (rowCells !== undefined) rowCells[col] = i < first ? cells.off : i === first ? cells.head : cells.on
  })
  const middle = grid[2]
  if (middle !== undefined) middle[2] = cells.center
  return grid
}

/** Resolved model ids compared without a context-window suffix (`[1m]`). */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true
  const strip = (m: string) => m.replace(/\[.*\]$/, '').trim()
  return strip(a) === strip(b)
}
