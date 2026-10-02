export type SidebarLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type SidebarUsage = {
  startedAt: number
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: SidebarLimit[]
  costUsd?: number
  model: string
}

export type SidebarCategory = {
  name: string
  tokens: number
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type SidebarContext = {
  categories: SidebarCategory[]
  autoCompactAt?: number
  history: number[]
}

/** `added` a file Write created, `modified` one edited or overwritten, `read` one only read. */
export type FileStatus = 'added' | 'modified' | 'read'

export type SidebarFile = {
  path: string
  status: FileStatus
  /** Lines added and removed over every change this session. */
  added: number
  removed: number
  reads: number
}

export type SidebarTranscript = {
  prompts: number
  toolCounts: Record<string, number>
  toolErrors: number
  /** Every file touched, least recently touched first. */
  files: SidebarFile[]
  subagents: number
}

export type SidebarTurns = {
  turns: number
  turnMsTotal: number
  lastTurnMs: number
  compactions: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  /** Tool calls per finished main-loop turn, subagents' included, oldest first. */
  activity: number[]
  /** Tool calls so far in the turn that is running. */
  pendingCalls: number
}

export type CacheTtl = '5m' | '1h' | 'off'

export type SidebarCache = {
  /** When the last main-thread request was sent, ms since the epoch. */
  lastRequestAt?: number
  /** The model that answered it: the cache is per model. */
  model?: string
  ttl: CacheTtl
  ttlReason: string
  /** Why the next request will not read the whole prefix, if it will not. */
  pending?: 'model' | 'compacted' | 'cleared'
  /** Bookkeeping for the running turn: its start and its last tool's end. */
  turnStartAt?: number
  lastToolAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ccsidebar': {
      usage: SidebarUsage
      context: SidebarContext
      transcript: SidebarTranscript
      turns: SidebarTurns
      cache: SidebarCache
      now: number
    }
  }
}
