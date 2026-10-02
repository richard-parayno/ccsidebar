/**
 * The sidebar's drawing. Type scale, top to bottom:
 *   SECTION ──────── figure   uppercase bold title, gray rule, bold key figure
 *   label        value        dim label, default value, unit or aside dim
 *   ╭ card ╮                   a gray rounded border with a column of padding,
 *                              around a sub-element that is a unit of its own
 * Sections run from what can stop or slow you (limits, context, cache) to
 * what happened (activity, session, files).
 */
import type { Elements, RenderChildren } from 'claude-code'

import type {
  FileStatus,
  SidebarCache,
  SidebarCategory,
  SidebarContext,
  SidebarFile,
  SidebarTranscript,
  SidebarTurns,
  SidebarUsage,
} from '../types'
import * as cacheModel from './cache'
import * as fileModel from './files'
import * as fmt from './format'
import * as px from './pixels'
import type { Palette, Pixel } from './pixels'

export type UI = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & { pal: Palette }

export type View = {
  ui: UI
  width: number
  clock: number
  usage: SidebarUsage
  context: SidebarContext
  transcript: SidebarTranscript
  turns: SidebarTurns
  cache: SidebarCache
  actions: { refresh: () => void; close: () => void }
}

const ACTIVITY_MAX_ROWS = 4
const TOP_CATEGORIES = 5
const TOP_TOOLS = 5
const FILE_ROWS = 6
/** Border and padding a card takes from each side's width. */
const CARD_INSET = 4
const TOOL_NAME_WIDTH = 9
const RING_WIDTH = 9

const SHORT_NAMES: Record<string, string> = {
  'System prompt': 'System',
  'System tools': 'Tools',
  'MCP tools': 'MCP',
  'Custom agents': 'Agents',
  'Memory files': 'Memory',
  'Slash commands': 'Commands',
  'Autocompact buffer': 'Autocompact',
}

// ---- type primitives ------------------------------------------------------

type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean }

const dim = (text: string): Seg => ({ text, dim: true })
const strong = (text: string, color?: string): Seg => ({ text, bold: true, ...(color ? { color } : {}) })
const plain = (text: string, color?: string): Seg => ({ text, ...(color ? { color } : {}) })

function segs(v: View, list: readonly Seg[]) {
  const { Text } = v.ui
  return list.map(s =>
    s.color === undefined && !s.bold && !s.dim ? s.text : (
      <Text {...(s.color ? { color: s.color } : {})} {...(s.bold ? { bold: true } : {})} {...(s.dim ? { dimColor: true } : {})}>
        {s.text}
      </Text>
    ),
  )
}

const width = (list: readonly Seg[]) => list.reduce((n, s) => n + s.text.length, 0)

function heading(v: View, title: string, right: readonly Seg[] = []) {
  const { Text } = v.ui
  const label = title.toUpperCase()
  const rule = Math.max(2, v.width - label.length - width(right) - (right.length > 0 ? 2 : 1))
  return (
    <Text wrap="truncate-end">
      <Text bold>{label}</Text>
      <Text color={v.ui.pal.empty.color}>{` ${'─'.repeat(rule)}${right.length > 0 ? ' ' : ''}`}</Text>
      {segs(v, right)}
    </Text>
  )
}

/** One line, `left` flush left and `right` flush right. */
function split(v: View, left: readonly Seg[], right: readonly Seg[] = []) {
  const { Box, Text } = v.ui
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text wrap="truncate-end">{segs(v, left)}</Text>
      {right.length > 0 && <Text wrap="truncate-start">{segs(v, right)}</Text>}
    </Box>
  )
}

const kv = (v: View, label: string, value: readonly Seg[]) => split(v, [dim(label)], value)

function note(v: View, text: string) {
  const { Text } = v.ui
  return <Text dimColor wrap="wrap">{text}</Text>
}

/** A bordered, padded block; `body` draws at the width left inside it. */
function card(v: View, body: (inner: View) => RenderChildren) {
  const { Box } = v.ui
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={v.ui.pal.empty.color} paddingX={1}>
      {body({ ...v, width: v.width - CARD_INSET })}
    </Box>
  )
}

// ---- pixel primitives -----------------------------------------------------

function pixelRow(v: View, row: readonly (Pixel | undefined)[]) {
  const { Text } = v.ui
  return px.runs(row).map(run =>
    run.pixel === undefined ? run.text : (
      <Text color={run.pixel.color} {...(run.pixel.dim ? { dimColor: true } : {})} {...(run.pixel.bold ? { bold: true } : {})}>
        {run.text}
      </Text>
    ),
  )
}

function pixelGrid(v: View, grid: readonly (readonly (Pixel | undefined)[])[]) {
  const { Box, Text } = v.ui
  return (
    <Box flexDirection="column">
      {grid.map(row => <Text wrap="truncate-end">{pixelRow(v, row)}</Text>)}
    </Box>
  )
}

function meter(v: View, percent: number) {
  const { pal } = v.ui
  const cols = px.squaresAcross(v.width)
  return pixelGrid(v, [px.meterPixels(percent, 1, cols, { color: pal[fmt.heat(percent)] }, pal.empty)])
}

// ---- header ---------------------------------------------------------------

function header(v: View) {
  const model = v.usage.model.replace(/^claude-/, '') || 'model pending'
  const elapsed = v.usage.startedAt > 0 ? fmt.duration(v.clock - v.usage.startedAt) : undefined
  return split(v, [strong(model)], elapsed === undefined ? [] : [plain(elapsed), dim(' elapsed')])
}

// ---- limits ---------------------------------------------------------------

function limitBlock(v: View, limit: SidebarUsage['rateLimits'][number], isFirst: boolean) {
  const { Box, pal } = v.ui
  const resetsIn = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt) - v.clock
  const pace = fmt.projectedPercent(limit.kind, limit.percentUsed, limit.resetsAt, v.clock)
  const paceSegs = pace === undefined ? [] : [dim('on pace for '), plain(`${Math.round(pace)}%`, pace > 100 ? pal.bad : undefined)]
  return (
    <Box flexDirection="column" {...(isFirst ? {} : { marginTop: 1 })}>
      {split(v, [plain(fmt.limitLabel(limit.kind))], [strong(`${limit.percentUsed}%`, pal[fmt.heat(limit.percentUsed)])])}
      {meter(v, limit.percentUsed)}
      {split(v, resetsIn === undefined ? [dim('reset time unknown')] : [dim('resets in '), plain(fmt.duration(resetsIn))], paceSegs)}
    </Box>
  )
}

function limits(v: View) {
  const { Box } = v.ui
  return (
    <Box flexDirection="column">
      {heading(v, 'Limits')}
      {v.usage.rateLimits.length === 0
        ? note(v, 'Appears after the first response (subscriptions only).')
        : v.usage.rateLimits.map((limit, i) => limitBlock(v, limit, i === 0))}
    </Box>
  )
}

// ---- context --------------------------------------------------------------

type Swatch = { name: string; tokens: number; pixel: Pixel }

/** Biggest categories first, then free space, then the reserve auto-compact stops at. */
function swatches(c: SidebarContext, pal: Palette): Swatch[] {
  const used = c.categories.filter(cat => cat.kind === 'used' && cat.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const named: Swatch[] = used.slice(0, TOP_CATEGORIES).map((cat, i) => ({
    name: SHORT_NAMES[cat.name] ?? cat.name,
    tokens: cat.tokens,
    pixel: { color: pal.series[i % pal.series.length] ?? pal.accent },
  }))
  const rest = used.slice(TOP_CATEGORIES).reduce((sum, cat) => sum + cat.tokens, 0)
  const of = (kind: SidebarCategory['kind'], pixel: Pixel): Swatch[] =>
    c.categories.filter(cat => cat.kind === kind && cat.tokens > 0)
      .map(cat => ({ name: SHORT_NAMES[cat.name] ?? cat.name, tokens: cat.tokens, pixel }))
  return [
    ...named,
    ...(rest > 0 ? [{ name: 'Other', tokens: rest, pixel: pal.other }] : []),
    ...of('free', pal.empty),
    ...of('buffer', pal.buffer),
  ]
}

function contextBar(v: View, list: Swatch[]) {
  const cols = px.squaresAcross(v.width)
  const counts = px.allocate(list.map(s => s.tokens), cols)
  return pixelGrid(v, [list.flatMap((s, i) => Array.from({ length: counts[i] ?? 0 }, () => s.pixel))])
}

/** The key, two to a line; free space goes without saying (gray is empty). */
function legend(v: View, list: Swatch[]) {
  const { Box, Text } = v.ui
  const keyed = list.filter(s => s.pixel !== v.ui.pal.empty)
  const cell = Math.floor((v.width - 2) / 2)
  const pairs = Array.from({ length: Math.ceil(keyed.length / 2) }, (_, i) => keyed.slice(i * 2, i * 2 + 2))
  return (
    <Box flexDirection="column">
      {pairs.map(pair => (
        <Box flexDirection="row" gap={2}>
          {pair.map(s => (
            <Box flexDirection="row" justifyContent="space-between" width={cell}>
              <Text wrap="truncate-end">
                {pixelRow(v, [s.pixel])}
                <Text dimColor>{` ${s.name}`}</Text>
              </Text>
              <Text>{fmt.tokens(s.tokens)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function contextTrend(v: View) {
  const { usage: u, context: c } = v
  const used = u.contextTokens
  const turnsLeft = used === undefined || c.autoCompactAt === undefined ? undefined : fmt.turnsUntil(c.history, used, c.autoCompactAt)
  if (c.history.length < 2) return undefined
  const right = turnsLeft === undefined ? [] : [plain(`~${turnsLeft}`), dim(' turns left')]
  const spark = fmt.sparkline(c.history, u.contextWindow, v.width - 6 - width(right) - 2)
  return split(v, [dim('trend '), plain(spark, v.ui.pal.accent)], right)
}

function context(v: View) {
  const { Box } = v.ui
  const { usage: u, context: c } = v
  const percent = u.contextPercent
  const used = u.contextTokens
  const list = swatches(c, v.ui.pal)
  const toCompact = used === undefined || c.autoCompactAt === undefined ? undefined : Math.max(0, c.autoCompactAt - used)
  const right = toCompact !== undefined ? [plain(fmt.tokens(toCompact)), dim(' to compact')]
    : used !== undefined ? [plain(fmt.tokens(Math.max(0, u.contextWindow - used))), dim(' free')] : []
  return (
    <Box flexDirection="column">
      {heading(v, 'Context', percent === undefined ? [] : [strong(`${percent}%`, v.ui.pal[fmt.heat(percent)])])}
      {used === undefined ? note(v, 'Measured after the first response.') : (
        <Box flexDirection="column">
          {list.length > 0 ? contextBar(v, list) : meter(v, percent ?? 0)}
          {split(v, [strong(fmt.tokens(used)), dim(` of ${fmt.tokens(u.contextWindow)}`)], right)}
          {contextTrend(v)}
        </Box>
      )}
      {list.length > 0 && card(v, inner => legend(inner, list))}
    </Box>
  )
}

// ---- cache ----------------------------------------------------------------

const VERDICT: Record<cacheModel.Verdict, { label: string; glyph: string }> = {
  hit: { label: 'HIT', glyph: '✓' },
  miss: { label: 'MISS', glyph: '✗' },
  partial: { label: 'PARTIAL', glyph: '◐' },
  cold: { label: 'COLD', glyph: '·' },
  off: { label: 'OFF', glyph: '·' },
}

function verdictColor(pal: Palette, p: cacheModel.Prediction): string {
  if (p.verdict === 'miss') return pal.bad
  if (p.verdict === 'partial') return pal.warn
  if (p.verdict === 'hit') return pal[fmt.heat(100 - p.fraction * 100)]
  return pal.empty.color
}

/** Five lines beside the ring: the clock, its window, a gap, the next request, the session. */
function cacheLines(v: View, p: cacheModel.Prediction, color: string): Seg[][] {
  const c = v.cache
  const size = v.usage.contextTokens === undefined ? 'the prefix' : fmt.tokens(v.usage.contextTokens)
  const window = c.ttl === 'off' ? [] : [dim(`${c.ttl} window · ${c.ttlReason}`)]
  const t = v.turns
  const inputSide = t.tokensIn + t.cacheRead + t.cacheWrite
  const session = inputSide > 0 ? [plain(`${Math.round((t.cacheRead / inputSide) * 100)}%`), dim(' of input cached')] : []
  const left = p.leftMs ?? 0
  const rewrite = [dim('next request writes '), strong(size)]
  const penalty = c.ttl === 'off' ? [] : [plain(`${cacheModel.MISS_COST[c.ttl]}×`, v.ui.pal.bad), dim(' the cost of a hit')]
  switch (p.verdict) {
    case 'off': return [[strong('caching off')], [dim(c.ttlReason)], [], [dim('every request pays full input')], []]
    case 'cold': return [[strong('no request yet')], window, [], [dim('warms on the first response')], []]
    case 'hit': return [[strong(fmt.duration(left), color), dim(' left')], window, [], [dim('next request reads '), strong(size)], session]
    case 'partial': return [[strong(fmt.duration(left), color), dim(' left')], window, [], [plain(`${c.pending}: `), dim('history re-cached')], [dim('system & tools still hit')]]
    case 'miss': return c.pending === 'model'
      ? [[strong('model switched', color)], [dim('the cache is per model')], [], rewrite, penalty]
      : [[strong('expired', color), dim(` ${fmt.duration(-left)} ago`)], window, [], rewrite, penalty]
  }
}

function cache(v: View) {
  const { Box, Text } = v.ui
  const p = cacheModel.predict(v.cache, v.clock)
  const color = verdictColor(v.ui.pal, p)
  const isPulse = Math.floor(v.clock / 1000) % 2 === 1
  const ring = cacheModel.ringGrid(p.fraction, {
    on: { color },
    head: { color, ...(isPulse ? { dim: true } : {}) },
    off: v.ui.pal.empty,
    center: { color, glyph: VERDICT[p.verdict].glyph },
  })
  return (
    <Box flexDirection="column">
      {heading(v, 'Cache', [strong(VERDICT[p.verdict].label, color)])}
      <Box flexDirection="row" gap={2}>
        {pixelGrid(v, ring)}
        <Box flexDirection="column" width={Math.max(10, v.width - RING_WIDTH - 2)}>
          {cacheLines(v, p, color).map(line => <Text wrap="truncate-end">{line.length === 0 ? ' ' : segs(v, line)}</Text>)}
        </Box>
      </Box>
    </Box>
  )
}

// ---- activity -------------------------------------------------------------

function heatmap(v: View) {
  const t = v.turns
  const cols = px.squaresAcross(v.width)
  const values = [...t.activity, ...(t.pendingCalls > 0 ? [t.pendingCalls] : [])].slice(-cols * ACTIVITY_MAX_ROWS)
  const max = Math.max(0, ...values)
  const pixels = values.map(n => v.ui.pal.levels[px.level(n, max)] ?? v.ui.pal.empty)
  return values.length === 0 ? note(v, 'Fills in as turns complete.') : pixelGrid(v, px.rowMajor(pixels, cols))
}

function toolBars(v: View) {
  const { Box, Text } = v.ui
  const top = Object.entries(v.transcript.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, TOP_TOOLS)
  const max = top[0]?.[1] ?? 1
  const squares = px.squaresAcross(v.width - TOOL_NAME_WIDTH - 5)
  return top.map(([tool, n]) => (
    <Box flexDirection="row" justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text dimColor>{fmt.pad(tool.replace(/^mcp__/, ''), TOOL_NAME_WIDTH)}</Text>
        {pixelRow(v, Array.from({ length: Math.max(1, Math.round((n / max) * squares)) }, () => ({ color: v.ui.pal.tools })))}
      </Text>
      <Text>{String(n)}</Text>
    </Box>
  ))
}

const levelSeg = (l: Pixel): Seg => ({ text: `${px.SQUARE} `, color: l.color, ...(l.dim ? { dim: true } : {}), ...(l.bold ? { bold: true } : {}) })

function activity(v: View) {
  const { Box } = v.ui
  const t = v.turns
  const tx = v.transcript
  const calls = Object.values(tx.toolCounts).reduce((a, b) => a + b, 0)
  const failed = tx.toolErrors > 0 ? [dim(' · '), plain(`${tx.toolErrors} failed`, v.ui.pal.warn)] : []
  return (
    <Box flexDirection="column">
      {heading(v, 'Activity', [strong(String(t.turns)), dim(t.turns === 1 ? ' turn' : ' turns')])}
      <Box flexDirection="column" marginTop={1}>
        {heatmap(v)}
        {split(v, [dim('tool calls per turn')], [dim('less '), ...v.ui.pal.levels.map(levelSeg), dim('more')])}
      </Box>
      {calls > 0 && card(v, inner => [
        split(inner, [dim('by tool')], [strong(String(calls)), dim(' calls'), ...failed]),
        toolBars(inner),
      ])}
    </Box>
  )
}

// ---- session & files ------------------------------------------------------

function session(v: View) {
  const { Box } = v.ui
  const { usage: u, transcript: tx } = v
  const t = v.turns
  const avg = t.turns > 0 ? t.turnMsTotal / t.turns : undefined
  return (
    <Box flexDirection="column">
      {heading(v, 'Session', u.costUsd === undefined ? [] : [strong(fmt.usd(u.costUsd))])}
      {kv(v, 'Prompts', [plain(String(tx.prompts))])}
      {avg !== undefined && kv(v, 'Turn time', [plain(fmt.duration(avg)), dim(' avg · last '), plain(fmt.duration(t.lastTurnMs))])}
      {t.tokensOut > 0 && kv(v, 'Output', [plain(fmt.tokens(t.tokensOut)), dim(' tokens')])}
      {u.costUsd !== undefined && tx.prompts > 0 && kv(v, 'Per prompt', [plain(fmt.usd(u.costUsd / tx.prompts))])}
      {tx.subagents > 0 && kv(v, 'Subagents', [plain(String(tx.subagents))])}
      {t.compactions > 0 && kv(v, 'Compactions', [plain(String(t.compactions))])}
    </Box>
  )
}

const FILE_STATUS: Record<FileStatus, { letter: string; label: string; color: (pal: Palette) => string }> = {
  added: { letter: 'A', label: 'added', color: pal => pal.ok },
  modified: { letter: 'M', label: 'modified', color: pal => pal.warn },
  read: { letter: 'R', label: 'read', color: pal => pal.info },
}

/** `+12 −3` in the palette's green and red; nothing for a change of no lines. */
function delta(v: View, added: number, removed: number): Seg[] {
  return [
    ...(added > 0 ? [plain(`+${added}`, v.ui.pal.ok)] : []),
    ...(added > 0 && removed > 0 ? [plain(' ')] : []),
    ...(removed > 0 ? [plain(`−${removed}`, v.ui.pal.bad)] : []),
  ]
}

/** Each status's letter, count and word: the list's key and its tally at once. */
function fileKey(v: View, list: readonly SidebarFile[]): Seg[] {
  const statuses: FileStatus[] = ['added', 'modified', 'read']
  return statuses
    .map(status => ({ status, n: list.filter(f => f.status === status).length }))
    .filter(({ n }) => n > 0)
    .flatMap(({ status, n }, i) => {
      const s = FILE_STATUS[status]
      return [...(i > 0 ? [plain('  ')] : []), strong(s.letter, s.color(v.ui.pal)), plain(` ${n}`), dim(` ${s.label}`)]
    })
}

function fileRow(v: View, f: SidebarFile) {
  const s = FILE_STATUS[f.status]
  const dir = f.path.split('/').slice(-2, -1)[0]
  const right = f.status === 'read' ? (f.reads > 1 ? [dim(`×${f.reads}`)] : []) : delta(v, f.added, f.removed)
  return split(v, [strong(s.letter, s.color(v.ui.pal)), plain(` ${fmt.basename(f.path)}`), ...(dir ? [dim(` ${dir}/`)] : [])], right)
}

function files(v: View) {
  const { Box } = v.ui
  const list = v.transcript.files
  const changed = list.filter(f => f.status !== 'read')
  const total = delta(v, changed.reduce((n, f) => n + f.added, 0), changed.reduce((n, f) => n + f.removed, 0))
  const shown = fileModel.byImportance(list).slice(0, FILE_ROWS)
  return (
    <Box flexDirection="column">
      {heading(v, 'Files', total)}
      {list.length === 0 ? note(v, 'No files touched yet.') : card(v, inner => [
        split(inner, fileKey(inner, list)),
        ...shown.map(f => fileRow(inner, f)),
        list.length > FILE_ROWS ? note(inner, `+${list.length - FILE_ROWS} more`) : null,
      ])}
    </Box>
  )
}

function footer(v: View) {
  const { Box, Button } = v.ui
  return (
    <Box flexDirection="row" gap={3}>
      <Button key="refresh" plain hotkey="r" dimColor onPress={v.actions.refresh}>Refresh</Button>
      <Button key="close" plain hotkey="x" dimColor role="dismiss" onPress={v.actions.close}>Close</Button>
    </Box>
  )
}

export function drawSidebar(v: View) {
  const { Box } = v.ui
  return (
    <Box flexDirection="column" gap={1}>
      {header(v)}
      {limits(v)}
      {context(v)}
      {cache(v)}
      {activity(v)}
      {session(v)}
      {files(v)}
      {footer(v)}
    </Box>
  )
}
