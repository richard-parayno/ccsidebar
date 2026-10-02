const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SPARKS = '▁▂▃▄▅▆▇█'

/** Rate-limit windows whose length we know, for pace projection. */
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }

/** Below this share of a window elapsed, a pace projection is noise. */
const MIN_PACE_FRACTION = 0.1

export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function duration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))}s`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ${Math.floor((ms % MINUTE) / 1000)}s`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`
  return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`
}

export function usd(n: number): string {
  return n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(1)}`
}

/** Which of the palette's ok / warn / bad a fill reads as. */
export function heat(percent: number): 'ok' | 'warn' | 'bad' {
  if (percent >= 85) return 'bad'
  if (percent >= 60) return 'warn'
  return 'ok'
}

/** Sparkline of absolute fill against `max`, newest last, `width` points. */
export function sparkline(values: readonly number[], max: number, width: number): string {
  const tail = values.slice(-Math.max(1, width))
  return tail
    .map(v => SPARKS[Math.min(SPARKS.length - 1, Math.floor((v / Math.max(1, max)) * SPARKS.length))])
    .join('')
}

export function limitLabel(kind: string): string {
  const known: Record<string, string> = {
    five_hour: '5-hour',
    seven_day: 'Weekly',
    seven_day_opus: 'Weekly Opus',
    seven_day_sonnet: 'Weekly Sonnet',
    spend_limit: 'Spend',
  }
  return known[kind] ?? kind.replace(/_/g, ' ')
}

/** Percent the window would reach by reset at the pace so far, or undefined. */
export function projectedPercent(kind: string, percentUsed: number, resetsAt: string | undefined, now: number): number | undefined {
  const windowMs = WINDOW_MS[kind] ?? (kind.startsWith('seven_day') ? WINDOW_MS.seven_day : undefined)
  if (windowMs === undefined || resetsAt === undefined) return undefined
  const left = Date.parse(resetsAt) - now
  if (!Number.isFinite(left)) return undefined
  const elapsed = 1 - left / windowMs
  if (elapsed < MIN_PACE_FRACTION || elapsed > 1) return undefined
  return percentUsed / elapsed
}

/** Turns until `target` at the average growth of the last few readings. */
export function turnsUntil(history: readonly number[], current: number, target: number): number | undefined {
  const recent = history.slice(-6)
  const deltas = recent.slice(1).map((v, i) => v - (recent[i] ?? v)).filter(d => d > 0)
  if (deltas.length === 0 || current >= target) return undefined
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length
  return Math.max(1, Math.round((target - current) / avg))
}

export function basename(path: string): string {
  return path.split('/').pop() ?? path
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length)
}
