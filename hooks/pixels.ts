/**
 * GitHub-contributions-style pixel grids, drawn as text squares. On the
 * terminal every color is a slot of its 16-color palette (`ansi256(0-15)`),
 * which the shell theme defines; elsewhere, Claude Code's theme keys.
 */

export const SQUARE = '■'
export const HOLLOW = '□'

export type Pixel = { color: string; dim?: boolean; bold?: boolean; glyph?: string }

export type Palette = {
  empty: Pixel
  ok: string
  warn: string
  bad: string
  accent: string
  /** Reads and other look-only activity. */
  info: string
  tools: string
  other: Pixel
  buffer: Pixel
  series: readonly string[]
  /** GitHub's five levels, none to most. */
  levels: readonly Pixel[]
}

/** A slot of the terminal's 16-color palette, which the shell theme defines. */
const slot = (n: number) => `ansi256(${n})`
const ANSI = { red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7, gray: 8, brightGreen: 10 }

/** The terminal: palette slots 0-15, so colors follow the shell theme. */
export const TERMINAL: Palette = {
  empty: { color: slot(ANSI.gray) },
  ok: slot(ANSI.green),
  warn: slot(ANSI.yellow),
  bad: slot(ANSI.red),
  accent: slot(ANSI.cyan),
  info: slot(ANSI.blue),
  tools: slot(ANSI.magenta),
  other: { color: slot(ANSI.white), dim: true },
  buffer: { color: slot(ANSI.yellow), dim: true, glyph: HOLLOW },
  series: [ANSI.magenta, ANSI.cyan, ANSI.blue, ANSI.yellow, ANSI.green, ANSI.red].map(slot),
  levels: [
    { color: slot(ANSI.gray) },
    { color: slot(ANSI.green), dim: true },
    { color: slot(ANSI.green) },
    { color: slot(ANSI.brightGreen) },
    { color: slot(ANSI.brightGreen), bold: true },
  ],
}

/** Other surfaces draw their own theme: Claude Code's theme keys. */
export const THEMED: Palette = {
  empty: { color: 'inactive' },
  ok: 'success',
  warn: 'warning',
  bad: 'error',
  accent: 'suggestion',
  info: 'professionalBlue',
  tools: 'merged',
  other: { color: 'subtle' },
  buffer: { color: 'warning', dim: true, glyph: HOLLOW },
  series: ['merged', 'suggestion', 'professionalBlue', 'warning', 'success', 'error'],
  levels: [
    { color: 'inactive' },
    { color: 'diffAddedDimmed' },
    { color: 'diffAdded' },
    { color: 'diffAddedWord' },
    { color: 'success' },
  ],
}

export function paletteFor(surface: string): Palette {
  return surface === 'terminal' ? TERMINAL : THEMED
}

/** How many squares fit across `width` columns, one space between each. */
export function squaresAcross(width: number): number {
  return Math.max(1, Math.floor((width + 1) / 2))
}

/** GitHub's bucketing: 0 is level 0, the rest by quarter of the max. */
export function level(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)))
}

/** Lays pixels left to right, wrapping every `cols`, oldest first. */
export function rowMajor<T>(pixels: readonly T[], cols: number): T[][] {
  return Array.from({ length: Math.ceil(pixels.length / cols) }, (_, r) => pixels.slice(r * cols, (r + 1) * cols))
}

/** A filled-to-percent block of `rows` x `cols`, filling column-major. */
export function meterPixels(percent: number, rows: number, cols: number, fill: Pixel, empty: Pixel): Pixel[] {
  const total = rows * cols
  const filled = Math.min(total, Math.round((Math.max(0, percent) / 100) * total))
  return Array.from({ length: total }, (_, i) => (i < filled ? fill : empty))
}

/**
 * Splits `total` squares among `shares` by largest remainder, so the counts
 * always add up to `total`.
 */
export function allocate(shares: readonly number[], total: number): number[] {
  const sum = shares.reduce((a, b) => a + b, 0)
  if (sum <= 0) return shares.map(() => 0)
  const exact = shares.map(s => (s / sum) * total)
  const counts = exact.map(Math.floor)
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest)
  let left = total - counts.reduce((a, b) => a + b, 0)
  for (const { i } of order) {
    if (left <= 0) break
    counts[i] = (counts[i] ?? 0) + 1
    left -= 1
  }
  return counts
}

export type Run = { text: string; pixel: Pixel | undefined }

/** Joins one grid row into runs of the same pixel, squares spaced by one column. */
export function runs(row: readonly (Pixel | undefined)[]): Run[] {
  const out: Run[] = []
  row.forEach((pixel, i) => {
    const text = (pixel === undefined ? ' ' : pixel.glyph ?? SQUARE) + (i < row.length - 1 ? ' ' : '')
    const last = out[out.length - 1]
    if (last !== undefined && samePixel(last.pixel, pixel)) last.text += text
    else out.push({ text, pixel })
  })
  return out
}

function samePixel(a: Pixel | undefined, b: Pixel | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.color === b.color && a.dim === b.dim && a.bold === b.bold && a.glyph === b.glyph
}
