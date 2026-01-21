import fs from 'fs/promises'
import type { Dirent } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

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

type HistoryEntry = {
  display?: string
  timestamp?: number
  project?: string
  sessionId?: string
}

type SessionIndex = Map<string, { filePath: string }>

const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude')
const HISTORY_PATH = path.join(CLAUDE_HOME, 'history.jsonl')
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects')
const ROOT_DIR = path.resolve(process.env.CC_MOBILE_ROOT ?? os.homedir())
const SHOW_HIDDEN = process.env.CC_MOBILE_SHOW_HIDDEN === '1'

let sessionIndex: SessionIndex | null = null

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

async function buildSessionIndex() {
  const index: SessionIndex = new Map()
  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return index
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectDir = path.join(PROJECTS_DIR, entry.name)
    const files = await fs.readdir(projectDir, { withFileTypes: true, encoding: 'utf8' })
    for (const file of files) {
      if (!file.isFile()) continue
      if (!file.name.endsWith('.jsonl')) continue
      const sessionId = file.name.replace(/\.jsonl$/, '')
      index.set(sessionId, { filePath: path.join(projectDir, file.name) })
    }
  }

  return index
}

async function getSessionIndex() {
  if (sessionIndex) return sessionIndex
  sessionIndex = await buildSessionIndex()
  return sessionIndex
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
  const index = await getSessionIndex()
  return index.get(sessionId)?.filePath ?? null
}

async function getFirstPrompt(sessionFile: string) {
  const records = await readJsonLines(sessionFile)
  for (const record of records) {
    if (record?.type !== 'user') continue
    if (record?.isMeta) continue
    const text = extractText(record.message?.content)
    if (text.trim()) return text.trim()
  }
  return ''
}

function getLatestProject(history: HistoryEntry[]) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].project) return history[i].project ?? null
  }
  return null
}

function getLatestSessionForProject(history: HistoryEntry[], project: string) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]
    if (entry.project === project && entry.sessionId) return entry.sessionId
  }
  return null
}

function getProjectForSession(history: HistoryEntry[], sessionId: string) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]
    if (entry.sessionId === sessionId && entry.project) return entry.project
  }
  return null
}

export async function readHistory() {
  const entries = (await readJsonLines(HISTORY_PATH)) as HistoryEntry[]
  return entries
}

export async function listConversations() {
  const history = await readHistory()
  const latestBySession = new Map<string, HistoryEntry>()

  for (const entry of history) {
    if (!entry.sessionId || !entry.project) continue
    const existing = latestBySession.get(entry.sessionId)
    const nextTimestamp = entry.timestamp ?? 0
    const existingTimestamp = existing?.timestamp ?? 0
    if (!existing || nextTimestamp >= existingTimestamp) {
      latestBySession.set(entry.sessionId, entry)
    }
  }

  const ordered = Array.from(latestBySession.values()).sort(
    (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)
  )

  const summaries: ConversationSummary[] = []
  for (const entry of ordered) {
    if (!entry.sessionId || !entry.project) continue
    const sessionFile = await resolveSessionFile(entry.sessionId, entry.project)
    const firstPrompt = sessionFile ? await getFirstPrompt(sessionFile) : entry.display ?? ''
    summaries.push({
      sessionId: entry.sessionId,
      project: entry.project,
      firstPrompt,
      updatedAt: entry.timestamp ?? 0
    })
  }

  return summaries
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
  const history = await readHistory()
  const currentProject = getLatestProject(history)
  const conversations = await listConversations()

  let activeConversationId: string | null = null
  if (currentProject) {
    activeConversationId = getLatestSessionForProject(history, currentProject)
  }
  if (!activeConversationId && conversations.length > 0) {
    activeConversationId = conversations[0].sessionId
  }

  const projectForActive = activeConversationId ? getProjectForSession(history, activeConversationId) : null
  const { messages, model } = activeConversationId
    ? await loadConversation(activeConversationId, projectForActive ?? undefined)
    : { messages: [], model: null }

  return {
    currentProject,
    conversations,
    activeConversationId,
    messages,
    model
  }
}
