import fs from 'fs/promises'
import { createReadStream, type Dirent, type FSWatcher, watch } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import readline from 'readline'

export type UIBlock = {
  type: 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'attachment' | 'other'
  text?: string
  name?: string
  input?: string
}

export type UIMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'meta'
  blocks: UIBlock[]
  timestamp?: string
  meta?: {
    isMeta?: boolean
    reasoningStatus?: 'provided' | 'disabled' | 'unknown'
  }
}

export type ConversationSummary = {
  sessionId: string
  project: string
  firstPrompt: string
  updatedAt: number
}

export type DirectoryListing = {
  path: string
  parent: string | null
  entries: string[]
}

const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude')
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects')
const ROOT_DIR = path.resolve(process.env.CC_MOBILE_ROOT ?? os.homedir())
const SHOW_HIDDEN = process.env.CC_MOBILE_SHOW_HIDDEN === '1'

type CachedConversation = ConversationSummary & {
  filePath: string
  mtimeMs: number
  size: number
  projectDir: string
}

type ConversationListener = (conversations: ConversationSummary[]) => void

const conversationCache = new Map<string, CachedConversation>()
const projectWatchers = new Map<string, FSWatcher>()
const conversationListeners = new Set<ConversationListener>()
let projectsWatcher: FSWatcher | null = null
let refreshPromise: Promise<{ conversations: ConversationSummary[]; changed: boolean }> | null = null
let refreshTimer: NodeJS.Timeout | null = null
let lastSnapshotKey = ''
let watchersEnabled = false
const SNAPSHOT_PROMPT_LIMIT = 120

function encodeProjectPath(projectPath: string) {
  return projectPath.replace(/[\\/]/g, '-')
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonLines(filePath: string) {
  let content = ''
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch {
    return []
  }
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function extractText(content: unknown) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === 'object' && (block as any).type === 'text')
      .map((block) => String((block as any).text ?? ''))
      .join('')
  }
  return ''
}

function normalizeBlocks(content: unknown): UIBlock[] {
  if (!content) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []

  return content.map((block: any) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text ?? '' }
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        name: block.name ?? 'tool',
        input: JSON.stringify(block.input ?? {}, null, 2)
      }
    }
    if (block.type === 'tool_result') {
      return {
        type: 'tool_result',
        text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? {}, null, 2)
      }
    }
    if (block.type === 'thinking' || block.type === 'analysis' || block.type === 'reasoning') {
      return { type: 'reasoning', text: block.text ?? '' }
    }
    return { type: 'other', text: JSON.stringify(block ?? {}, null, 2) }
  })
}

function buildSnapshotKey(conversations: ConversationSummary[]) {
  return conversations
    .map((conversation) => {
      const promptSnippet = conversation.firstPrompt.slice(0, SNAPSHOT_PROMPT_LIMIT)
      return `${conversation.sessionId}:${conversation.updatedAt}:${conversation.project}:${promptSnippet}`
    })
    .join('|')
}

async function listProjectDirectories() {
  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(PROJECTS_DIR, entry.name) }))
}

async function readSessionMetadata(filePath: string) {
  let project = ''
  let firstPrompt = ''
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let linesRead = 0

  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      linesRead += 1
      let record: any = null
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (!project && typeof record?.cwd === 'string') {
        project = record.cwd.trim()
      }
      if (!firstPrompt && record?.type === 'user' && !record?.isMeta) {
        const text = extractText(record.message?.content)
        if (text.trim()) firstPrompt = text.trim()
      }
      if (project && firstPrompt) break
      if (linesRead >= 200) break
    }
  } catch {
  } finally {
    rl.close()
    stream.destroy()
  }

  return { project, firstPrompt }
}

function syncProjectWatchers(projectDirs: string[]) {
  const next = new Set(projectDirs)
  for (const dir of projectDirs) {
    if (projectWatchers.has(dir)) continue
    try {
      const watcher = watch(dir, { persistent: false }, () => scheduleConversationRefresh())
      projectWatchers.set(dir, watcher)
    } catch {
      continue
    }
  }

  for (const [dir, watcher] of projectWatchers) {
    if (next.has(dir)) continue
    watcher.close()
    projectWatchers.delete(dir)
  }
}

function ensureProjectsWatcher() {
  if (projectsWatcher) return
  try {
    projectsWatcher = watch(PROJECTS_DIR, { persistent: false }, () => scheduleConversationRefresh())
  } catch {
    projectsWatcher = null
  }
}

function stopWatchersIfIdle() {
  if (conversationListeners.size > 0) return
  for (const watcher of projectWatchers.values()) {
    watcher.close()
  }
  projectWatchers.clear()
  if (projectsWatcher) {
    projectsWatcher.close()
    projectsWatcher = null
  }
  watchersEnabled = false
}

function scheduleConversationRefresh() {
  if (!watchersEnabled) return
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void emitConversationUpdates()
  }, 150)
}

async function emitConversationUpdates() {
  try {
    const { conversations, changed } = await refreshConversationCache()
    if (!changed) return
    for (const listener of conversationListeners) {
      listener(conversations)
    }
  } catch {
  }
}

async function refreshConversationCache() {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const projectDirs = await listProjectDirectories()
    if (watchersEnabled) {
      ensureProjectsWatcher()
      syncProjectWatchers(projectDirs.map((entry) => entry.path))
    }

    const nextCache = new Map<string, CachedConversation>()
    for (const projectDir of projectDirs) {
      let files: Dirent[] = []
      try {
        files = await fs.readdir(projectDir.path, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile()) continue
        if (!file.name.endsWith('.jsonl')) continue
        const sessionId = file.name.replace(/\.jsonl$/, '')
        const filePath = path.join(projectDir.path, file.name)
        let stats: { mtimeMs: number; size: number }
        try {
          const stat = await fs.stat(filePath)
          stats = { mtimeMs: stat.mtimeMs, size: stat.size }
        } catch {
          continue
        }

        const cached = conversationCache.get(sessionId)
        if (
          cached &&
          cached.filePath === filePath &&
          cached.mtimeMs === stats.mtimeMs &&
          cached.size === stats.size
        ) {
          nextCache.set(sessionId, { ...cached, updatedAt: stats.mtimeMs })
          continue
        }

        const { project, firstPrompt } = await readSessionMetadata(filePath)
        const resolvedProject = project || cached?.project || projectDir.name
        nextCache.set(sessionId, {
          sessionId,
          project: resolvedProject,
          firstPrompt,
          updatedAt: stats.mtimeMs,
          filePath,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          projectDir: projectDir.path
        })
      }
    }

    conversationCache.clear()
    for (const [sessionId, entry] of nextCache) {
      conversationCache.set(sessionId, entry)
    }

    const conversations = Array.from(nextCache.values()).map(
      ({ filePath, mtimeMs, size, projectDir, ...summary }) => summary
    )
    conversations.sort((a, b) => b.updatedAt - a.updatedAt)
    const snapshotKey = buildSnapshotKey(conversations)
    const changed = snapshotKey !== lastSnapshotKey
    lastSnapshotKey = snapshotKey

    return { conversations, changed }
  })().finally(() => {
    refreshPromise = null
  })

  return refreshPromise
}

function clampToRoot(targetPath: string) {
  const resolved = path.resolve(targetPath)
  if (resolved === ROOT_DIR) return resolved
  if (ROOT_DIR === path.parse(ROOT_DIR).root) return resolved
  const rootPrefix = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : `${ROOT_DIR}${path.sep}`
  return resolved.startsWith(rootPrefix) ? resolved : ROOT_DIR
}

async function resolveSessionFile(sessionId: string, project?: string) {
  if (project) {
    const candidate = path.join(PROJECTS_DIR, encodeProjectPath(project), `${sessionId}.jsonl`)
    if (await fileExists(candidate)) return candidate
  }
  const cached = conversationCache.get(sessionId)
  if (cached) return cached.filePath
  const { conversations } = await refreshConversationCache()
  const found = conversations.find((conversation) => conversation.sessionId === sessionId)
  if (!found) return null
  return conversationCache.get(sessionId)?.filePath ?? null
}

export function watchConversations(listener: ConversationListener) {
  conversationListeners.add(listener)
  watchersEnabled = true
  ensureProjectsWatcher()
  void refreshConversationCache()
    .then(({ conversations }) => listener(conversations))
    .catch(() => {})
  return () => {
    conversationListeners.delete(listener)
    stopWatchersIfIdle()
  }
}

export async function listConversations() {
  const { conversations } = await refreshConversationCache()
  return conversations
}

export async function listDirectories(requestPath?: string | null): Promise<DirectoryListing> {
  const basePath = requestPath ? clampToRoot(requestPath) : ROOT_DIR
  let dirEntries: string[] = []
  try {
    const entries = await fs.readdir(basePath, { withFileTypes: true, encoding: 'utf8' })
    dirEntries = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => (SHOW_HIDDEN ? true : !name.startsWith('.')))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    dirEntries = []
  }

  const parent = basePath === ROOT_DIR ? null : path.dirname(basePath)

  return {
    path: basePath,
    parent,
    entries: dirEntries
  }
}

export async function loadConversation(sessionId: string, project?: string) {
  const filePath = await resolveSessionFile(sessionId, project)
  if (!filePath) return { messages: [] as UIMessage[], model: null }

  const records = await readJsonLines(filePath)
  const messages: UIMessage[] = []
  let lastModel: string | null = null

  for (const record of records) {
    if (record?.type !== 'user' && record?.type !== 'assistant') continue
    const message = record.message
    if (!message || !message.role) continue

    if (message.role === 'assistant' && message.model) {
      lastModel = message.model
    }

    const blocks = normalizeBlocks(message.content)
    if (blocks.length === 0) continue

    const reasoningStatus = blocks.some((block) => block.type === 'reasoning')
      ? 'provided'
      : record.thinkingMetadata?.disabled
        ? 'disabled'
        : 'unknown'

    const role = blocks.every((block) => block.type === 'tool_result')
      ? 'tool'
      : (message.role as 'user' | 'assistant')

    messages.push({
      id: record.uuid ?? message.id ?? crypto.randomUUID(),
      role,
      blocks,
      timestamp: record.timestamp,
      meta: {
        isMeta: record.isMeta ?? false,
        reasoningStatus: message.role === 'assistant' ? reasoningStatus : undefined
      }
    })
  }

  return { messages, model: lastModel }
}

export async function getBootstrapState() {
  const conversations = await listConversations()
  const activeConversation = conversations[0] ?? null
  const activeConversationId = activeConversation?.sessionId ?? null
  const currentProject = activeConversation?.project ?? null
  const { messages, model } = activeConversationId
    ? await loadConversation(activeConversationId, activeConversation?.project ?? undefined)
    : { messages: [], model: null }

  return {
    currentProject,
    conversations,
    activeConversationId,
    messages,
    model
  }
}
