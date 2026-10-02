import { expect, test } from 'claude-code/testing'

import * as cacheModel from '../hooks/cache'
import * as fileModel from '../hooks/files'
import * as fmt from '../hooks/format'
import * as px from '../hooks/pixels'

const SURFACES = ['terminal', 'desktop'] as const
const PANE = {
  plugin: 'ccsidebar',
  component: 'Pane',
  requestId: 'ccsidebar',
  props: {
    title: 'Thread',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

test('empty sidebar draws every section on each surface', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const title of ['LIMITS', 'CONTEXT', 'CACHE', 'ACTIVITY', 'SESSION', 'FILES']) {
      expect(await ui.find({ text: new RegExp(`^${title} ─`) })).toBeDefined()
    }
    expect(await ui.find({ text: /Appears after the first response/ })).toBeDefined()
    expect(await ui.find({ text: 'Fills in as turns complete.' })).toBeDefined()
    expect(await ui.find({ text: 'No files touched yet.' })).toBeDefined()
    await ui.unmount()
  }
})

test('a measurement shows limits and context fill', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  await $.session.measure({
    context: { tokens: 112_000, window: 200_000, percent: 56 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 58, resetsAt }],
    cost: { usd: 3.21 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: '5-hour' })).toBeDefined()
    expect(await ui.find({ text: '58%' })).toBeDefined()
    expect(await ui.find({ text: /112k of 200k/ })).toBeDefined()
    expect(await ui.find({ text: /\$3\.21/ })).toBeDefined()
    await ui.unmount()
  }
})

test('tool calls are tallied and files badged by what was done to them', async ($, on) => {
  on('tool.call', (_$, e) => {
    const call = e as unknown as { tool: string; file_path?: string }
    if (call.tool === 'Write') return { result: { type: 'create', content: 'a\nb\n' }, text: 'ok' } as never
    if (call.tool === 'Edit') return { result: { structuredPatch: [{ lines: ['+x', '-y', '-z'] }] }, text: 'ok' } as never
    return { result: {}, text: 'ok' } as never
  })
  const calls = [
    { tool: 'Bash', command: 'ls' },
    { tool: 'Read', file_path: '/repo/src/layout.astro' },
    { tool: 'Read', file_path: '/repo/src/layout.astro' },
    { tool: 'Edit', file_path: '/repo/src/page.astro' },
    { tool: 'Write', file_path: '/repo/src/new.ts' },
  ]
  for (const call of calls) await $.tool.call(call as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /5 calls/ })).toBeDefined()
    expect(await ui.find({ text: /A 1 added {2}M 1 modified {2}R 1 read/ })).toBeDefined()
    expect(await ui.find({ text: /^M page\.astro src\/$/ })).toBeDefined()
    expect(await ui.find({ text: '+1 −2' })).toBeDefined()
    expect(await ui.find({ text: /^A new\.ts/ })).toBeDefined()
    expect(await ui.find({ text: /^R layout\.astro/ })).toBeDefined()
    expect(await ui.find({ text: '×2' })).toBeDefined()
    expect(await ui.find({ text: /FILES ─+ \+3 −2$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('file model: status ranks, line deltas, order', () => {
  expect(fileModel.lineDelta({ type: 'create', content: 'a\nb\nc\n' })).toEqual({ added: 3, removed: 0 })
  expect(fileModel.lineDelta({ structuredPatch: [{ lines: ['+a', ' b', '-c'] }, { lines: ['+d'] }] })).toEqual({ added: 2, removed: 1 })
  expect(fileModel.touchOf('Grep', { pattern: 'x' }, undefined)).toBeUndefined()
  let files = fileModel.applyTouch([], { path: '/a', status: 'read', added: 0, removed: 0 })
  files = fileModel.applyTouch(files, { path: '/b', status: 'read', added: 0, removed: 0 })
  files = fileModel.applyTouch(files, { path: '/a', status: 'modified', added: 4, removed: 1 })
  files = fileModel.applyTouch(files, { path: '/a', status: 'read', added: 0, removed: 0 })
  expect(files.find(f => f.path === '/a')).toEqual({ path: '/a', status: 'modified', added: 4, removed: 1, reads: 2 })
  expect(fileModel.byImportance(files).map(f => f.path)).toEqual(['/a', '/b'])
})

test('format helpers', () => {
  expect(fmt.tokens(950)).toBe('950')
  expect(fmt.tokens(1500)).toBe('1.5k')
  expect(fmt.tokens(112_000)).toBe('112k')
  expect(fmt.duration(90_000)).toBe('1m 30s')
  expect(fmt.duration(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m')
  expect(fmt.heat(90)).toBe('bad')
  expect(fmt.limitLabel('seven_day_opus')).toBe('Weekly Opus')
  expect(fmt.turnsUntil([100, 110, 120], 120, 160)).toBe(4)
  const now = Date.parse('2026-10-02T12:00:00Z')
  const resetsAt = new Date(now + 2.5 * 3_600_000).toISOString()
  expect(fmt.projectedPercent('five_hour', 25, resetsAt, now)).toBe(50)
})

test('pixel helpers lay out squares left to right', () => {
  expect(px.squaresAcross(41)).toBe(21)
  expect(px.level(0, 10)).toBe(0)
  expect(px.level(1, 10)).toBe(1)
  expect(px.level(10, 10)).toBe(4)
  expect(px.allocate([1, 1, 1], 10).reduce((a, b) => a + b, 0)).toBe(10)
  const a: px.Pixel = { color: 'ansi256(2)' }
  const z = px.TERMINAL.empty
  const grid = px.rowMajor([a, a, a, z, z], 3)
  expect(grid[0]).toEqual([a, a, a])
  expect(grid[1]).toEqual([z, z])
  expect(px.runs([a, a, z])).toEqual([
    { text: '■ ■ ', pixel: a },
    { text: '■', pixel: z },
  ])
  const filled = px.meterPixels(50, 2, 10, a, z).filter(p => p === a)
  expect(filled.length).toBe(10)
})

test('on the terminal every color is a shell palette slot', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 150_000, window: 200_000, percent: 75 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 90 }],
    changed: ['context', 'rateLimits'],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const colors = (await ui.findAll({ type: 'Text' }))
    .map(t => t.props.color)
    .filter((c): c is string => typeof c === 'string')
  expect(colors.length).toBeGreaterThan(0)
  expect(colors.every(c => /^ansi256\((\d|1[0-5])\)$/.test(c))).toBe(true)
  expect(colors).toContain('ansi256(1)')
  expect(colors).toContain('ansi256(3)')
  await ui.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const deskColors = (await desk.findAll({ type: 'Text' })).map(t => t.props.color)
  expect(deskColors).toContain('error')
  await desk.unmount()
})

test('finished turns fill the activity grid', async ($, on) => {
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('session.turns', () => ({ value: 1 }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  for (const calls of [3, 0, 7]) {
    for (let i = 0; i < calls; i++) await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: `t${calls}`, reason: 'answer' })
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /ACTIVITY ─+ 3 turns/ })).toBeDefined()
  expect(await ui.find({ text: /less ■ ■ ■ ■ ■ more/ })).toBeDefined()
  const greens = (await ui.findAll({ type: 'Text' })).filter(t => ['ansi256(2)', 'ansi256(10)'].includes(String(t.props.color)))
  expect(greens.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('cache TTL follows the engine order', () => {
  const base = { isSubscriber: true, isOverage: false }
  expect(cacheModel.resolveTtl(base)).toEqual({ ttl: '1h', reason: 'subscriber' })
  expect(cacheModel.resolveTtl({ ...base, isOverage: true }).ttl).toBe('5m')
  expect(cacheModel.resolveTtl({ isSubscriber: false, isOverage: false }).ttl).toBe('5m')
  expect(cacheModel.resolveTtl({ ...base, settingTtl: '5m' }).ttl).toBe('5m')
  expect(cacheModel.resolveTtl({ ...base, envTtl: '5m', settingTtl: '1h' }).reason).toBe('set by env')
  expect(cacheModel.resolveTtl({ ...base, disabled: '1' }).ttl).toBe('off')
})

test('cache prediction and countdown ring', () => {
  const at = 1_000_000
  const warm = { ttl: '5m', ttlReason: '', lastRequestAt: at } as const
  expect(cacheModel.predict(warm, at + 60_000)).toMatchObject({ verdict: 'hit', leftMs: 240_000 })
  expect(cacheModel.predict(warm, at + 400_000).verdict).toBe('miss')
  expect(cacheModel.predict({ ...warm, pending: 'model' }, at + 1000).verdict).toBe('miss')
  expect(cacheModel.predict({ ...warm, pending: 'compacted' }, at + 1000).verdict).toBe('partial')
  expect(cacheModel.predict({ ttl: '1h', ttlReason: '' }, at).verdict).toBe('cold')

  const on = { color: 'on' }
  const head = { color: 'head' }
  const off = { color: 'off' }
  const lit = (f: number) => cacheModel.ringGrid(f, { on, head, off }).flat().filter(p => p === on || p === head).length
  expect(lit(1)).toBe(12)
  expect(lit(0.5)).toBe(6)
  expect(lit(0.01)).toBe(1)
  expect(lit(0)).toBe(0)
  // half left: the hand sits at six o'clock and the arc runs back up the left to twelve
  const half = cacheModel.ringGrid(0.5, { on, head, off })
  expect(half[4]?.[2]).toBe(head)
  expect(half[0]?.[2]).toBe(off)
  expect(half[0]?.[1]).toBe(on)
  expect(cacheModel.sameModel('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(true)
})

test('a finished turn shows the cache warm', async ($, on) => {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.turns', () => ({ value: 1 }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] } }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await before.find({ text: 'COLD' })).toBeDefined()
  await before.unmount()
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({
    answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: 'HIT' })).toBeDefined()
    expect(await ui.find({ text: /left$/ })).toBeDefined()
    expect(await ui.find({ text: /1h window · subscriber/ })).toBeDefined()
    expect(await ui.find({ text: /✓/ })).toBeDefined()
    await ui.unmount()
  }
})
