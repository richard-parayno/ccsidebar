import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, SessionMessage } from 'claude-code'

import type {
  SidebarCache,
  SidebarCategory,
  SidebarContext,
  SidebarTranscript,
  SidebarTurns,
  SidebarUsage,
} from '../types'
import * as cacheModel from './cache'
import * as fileModel from './files'
import * as fmt from './format'
import * as px from './pixels'
import { drawSidebar } from './view'

const PANE = 'ccsidebar'
const TITLE = 'Thread'
const COMMAND = 'sidebar'
const STORE_OPEN = 'open'
const PANE_COLUMNS = 44
const TICK_MS = 1_000
const SLOW_TICK_MS = 30_000
const HISTORY_LENGTH = 40
const ACTIVITY_LENGTH = 200
const AGENT_TOOLS = new Set(['Agent', 'Task'])

const EMPTY_TRANSCRIPT: SidebarTranscript = {
  prompts: 0,
  toolCounts: {},
  toolErrors: 0,
  files: [],
  subagents: 0,
}
const EMPTY_TURNS: SidebarTurns = {
  turns: 0,
  turnMsTotal: 0,
  lastTurnMs: 0,
  compactions: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  activity: [],
  pendingCalls: 0,
}

const transcriptRef = { plugin: 'ccsidebar', key: 'transcript' } as const
const usage = atom({ plugin: 'ccsidebar', key: 'usage' } as const, {
  startedAt: 0,
  contextWindow: 0,
  rateLimits: [],
  model: '',
} as SidebarUsage)
const context = atom({ plugin: 'ccsidebar', key: 'context' } as const, {
  categories: [],
  history: [],
} as SidebarContext)
const transcript = atom(transcriptRef, EMPTY_TRANSCRIPT)
const turns = atom({ plugin: 'ccsidebar', key: 'turns' } as const, EMPTY_TURNS)
const cache = atom({ plugin: 'ccsidebar', key: 'cache' } as const, {
  ttl: '1h',
  ttlReason: 'not resolved yet',
} as SidebarCache)
const now = atom({ plugin: 'ccsidebar', key: 'now' } as const, 0)

/** When the clock last wrote `now` (the module's own; a reload starts it over). */
let lastTickAt = 0

/** Fills fields a value written by an older version of the mod lacks. */
function withTurnDefaults(t: SidebarTurns): SidebarTurns {
  return { ...EMPTY_TURNS, ...t }
}

function withTranscriptDefaults(t: SidebarTranscript): SidebarTranscript {
  return { ...EMPTY_TRANSCRIPT, ...t }
}

// ---- data -----------------------------------------------------------------

async function refreshUsage($: EngineInterface): Promise<void> {
  const [snap, model] = await Promise.all([
    $.session.usage({ breakdown: 'summary', columns: PANE_COLUMNS }),
    $.session.model(),
  ])
  await update($, usage, () => ({
    startedAt: snap.startedAt,
    contextTokens: snap.context.tokens,
    contextWindow: snap.context.window,
    contextPercent: snap.context.percent,
    rateLimits: snap.rateLimits.map(l => ({ ...l })),
    costUsd: snap.cost?.usd,
    model,
  }))
  await refreshTtl($, snap.rateLimits)
  const breakdown = snap.context.breakdown
  if (breakdown === undefined) return
  const categories: SidebarCategory[] = breakdown.categories.map(c => ({
    name: c.name,
    tokens: c.tokens,
    kind: c.kind,
  }))
  await update($, context, prev => ({
    ...prev,
    categories,
    autoCompactAt: breakdown.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined,
  }))
}

function addToolUse(held: SidebarTranscript, tool: string, input: Record<string, unknown>, record: unknown, isError: boolean): SidebarTranscript {
  const t = withTranscriptDefaults(held)
  const touch = isError ? undefined : fileModel.touchOf(tool, input, record)
  return {
    ...t,
    toolCounts: { ...t.toolCounts, [tool]: (t.toolCounts[tool] ?? 0) + 1 },
    toolErrors: t.toolErrors + (isError ? 1 : 0),
    files: touch === undefined ? t.files : fileModel.applyTouch(t.files, touch),
    subagents: t.subagents + (AGENT_TOOLS.has(tool) ? 1 : 0),
  }
}

/** Seeds thread stats from the transcript once (a resumed session). */
async function seedTranscript($: EngineInterface): Promise<void> {
  const held = await $.state.get(transcriptRef)
  if (held.version !== 0) return
  const rows = await $.session.messages()
  if (!Array.isArray(rows)) return
  const seeded = (rows as SessionMessage[])
    .flatMap(row => row.toolUses)
    .reduce((t, use) => addToolUse(t, use.tool, use.input, use.result, use.isError === true), EMPTY_TRANSCRIPT)
  await $.state.set(transcriptRef, { ...seeded, prompts: await $.session.turns() }, { ifVersion: 0 })
}

async function onMeasure($: EngineInterface, e: SessionMeasureInput): Promise<void> {
  await update($, usage, prev => ({
    ...prev,
    contextTokens: e.context.tokens ?? prev.contextTokens,
    contextWindow: e.context.window,
    contextPercent: e.context.percent ?? prev.contextPercent,
    rateLimits: e.rateLimits.map(l => ({ ...l })),
    costUsd: e.cost?.usd ?? prev.costUsd,
  }))
  const tokens = e.context.tokens
  if (!e.changed.includes('context') || tokens === undefined) return
  await update($, context, prev => ({ ...prev, history: [...prev.history, tokens].slice(-HISTORY_LENGTH) }))
}

/** Mirrors the engine's choice of the main thread's cache TTL. */
async function refreshTtl($: EngineInterface, rateLimits: readonly { percentUsed: number }[]): Promise<void> {
  const [disabled, force5m, envTtl, enable1h, settings] = await Promise.all([
    $.env.get('DISABLE_PROMPT_CACHING'),
    $.env.get('FORCE_PROMPT_CACHING_5M'),
    $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    $.env.get('ENABLE_PROMPT_CACHING_1H'),
    $.settings.read(),
  ])
  const { ttl, reason } = cacheModel.resolveTtl({
    disabled,
    force5m,
    envTtl,
    enable1h,
    settingTtl: (settings as Record<string, unknown>).promptCacheTtl,
    isSubscriber: rateLimits.length > 0,
    isOverage: rateLimits.some(l => l.percentUsed >= 100),
  })
  await update($, cache, c => ({ ...c, ttl, ttlReason: reason }))
}

/** Ticks every second while the cache is warm, every 30s otherwise. */
async function tick($: EngineInterface): Promise<void> {
  const t = Date.now()
  const c = await read($, cache)
  const isWarm = c.ttl !== 'off' && c.lastRequestAt !== undefined && t - c.lastRequestAt < cacheModel.TTL_MS[c.ttl] + TICK_MS
  if (!isWarm && t - lastTickAt < SLOW_TICK_MS) return
  lastTickAt = t
  await update($, now, () => t)
}

async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  await $.store.set(STORE_OPEN, true)
  return opened.isPlaced
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

// ---- hooks ----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Toggle the usage & thread sidebar', immediate: true })
    await update($, now, () => Date.now())
    $.clock.every(TICK_MS, () => void tick($))
    await Promise.all([refreshUsage($), seedTranscript($)])
    if ((await $.store.get(STORE_OPEN)) !== false) void openPane($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    if (await isPaneOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'Sidebar closed.' }
    }
    await refreshUsage($)
    const isPlaced = await openPane($)
    return { text: isPlaced ? 'Sidebar opened.' : 'Sidebar opened; widen the terminal to see it docked.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'unload') await $.store.set(STORE_OPEN, false)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await onMeasure($, e)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await update($, turns, t => ({ ...withTurnDefaults(t), pendingCalls: withTurnDefaults(t).pendingCalls + 1 }))
    if (e.agentId !== undefined) return result
    await update($, cache, c => ({ ...c, lastToolAt: Date.now() }))
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e as unknown as Record<string, unknown> & { tool: string }
    await update($, transcript, t => addToolUse(t, tool, input, result.result, result.isError === true))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const u = e.usage
    await update($, turns, held => {
      const t = withTurnDefaults(held)
      return {
        ...t,
        turns: t.turns + 1,
        turnMsTotal: t.turnMsTotal + e.durationMs,
        lastTurnMs: e.durationMs,
        tokensIn: t.tokensIn + (u?.input_tokens ?? 0),
        tokensOut: t.tokensOut + (u?.output_tokens ?? 0),
        cacheRead: t.cacheRead + (u?.cache_read_input_tokens ?? 0),
        cacheWrite: t.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
        activity: [...t.activity, t.pendingCalls].slice(-ACTIVITY_LENGTH),
        pendingCalls: 0,
      }
    })
    await update($, cache, c => ({
      ...c,
      lastRequestAt: Math.max(c.turnStartAt ?? Date.now(), c.lastToolAt ?? 0),
      model: u?.model ?? c.model,
      pending: undefined,
      turnStartAt: undefined,
      lastToolAt: undefined,
    }))
    const prompts = await $.session.turns()
    await update($, transcript, t => ({ ...t, prompts }))
    await refreshUsage($)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await update($, turns, t => ({ ...withTurnDefaults(t), compactions: withTurnDefaults(t).compactions + 1 }))
    await update($, cache, (c): SidebarCache => ({ ...c, pending: 'compacted' }))
    return result
  })

  on('turn.start', async ($, e, next) => {
    await update($, cache, c => ({ ...c, turnStartAt: Date.now(), lastToolAt: undefined }))
    return next(e)
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, cache, (c): SidebarCache => ({ ...c, pending: 'cleared' }))
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, cache, (c): SidebarCache => ({
      ...c,
      ttl: e.cache_ttl,
      ttlReason: 'reported by engine',
      pending: cacheModel.sameModel(e.to_model, c.model) ? c.pending : 'model',
    }))
    await update($, usage, prev => ({ ...prev, model: e.to_model }))
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const since = e.seconds_since_last_response
    if (since !== undefined) {
      await update($, cache, c => (c.lastRequestAt === undefined ? { ...c, lastRequestAt: Date.now() - since * 1000 } : c))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [u, c, tx, held, cached, tickAt] = await Promise.all([
      read($, usage), read($, context), read($, transcript), read($, turns), read($, cache), read($, now),
    ])
    return drawSidebar({
      ui: { Box, Text, Button, pal: px.paletteFor(e.surface) },
      width: Math.max(16, e.props.bodyColumns - 1),
      clock: tickAt > 0 ? tickAt : Date.now(),
      usage: u,
      context: c,
      transcript: withTranscriptDefaults(tx),
      turns: withTurnDefaults(held),
      cache: cached,
      actions: {
        refresh: () => void refreshUsage($),
        close: () => void $.ui.close({ id: PANE }),
      },
    })
  })
}
