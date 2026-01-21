import { useEffect, useMemo, useRef, useState } from 'react'

type Block = {
  type: 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'attachment' | 'other'
  text?: string
  name?: string
  input?: string
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'meta'
  blocks: Block[]
  timestamp?: string
  meta?: {
    isMeta?: boolean
    reasoningStatus?: 'provided' | 'disabled' | 'unknown'
  }
}

type ConversationSummary = {
  sessionId: string
  project: string
  firstPrompt: string
  updatedAt: number
}

type ServerPayload =
  | {
      type: 'bootstrap'
      currentProject: string | null
      conversations: ConversationSummary[]
      activeConversationId: string | null
      messages: ChatMessage[]
    }
  | {
      type: 'conversation'
      sessionId: string | null
      messages: ChatMessage[]
      currentProject?: string | null
    }
  | {
      type: 'dir_list'
      path: string
      parent: string | null
      entries: string[]
    }
  | { type: 'message'; message: ChatMessage }
  | { type: 'processing'; active: boolean }
  | { type: 'conversations'; conversations: ConversationSummary[] }
  | { type: 'error'; error: string }

const WS_URL = (() => {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL as string
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${window.location.hostname}:8787`
})()

function formatProject(project: string) {
  const parts = project.split('/').filter(Boolean)
  if (parts.length <= 2) return project
  return parts.slice(-2).join('/')
}

function truncateWords(text: string, maxWords = 10) {
  const words = text.trim().split(/\s+/)
  if (words.length <= maxWords) return text
  return `${words.slice(0, maxWords).join(' ')}...`
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [currentProject, setCurrentProject] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [dirPath, setDirPath] = useState<string | null>(null)
  const [dirParent, setDirParent] = useState<string | null>(null)
  const [dirEntries, setDirEntries] = useState<string[]>([])
  const [dirLoading, setDirLoading] = useState(false)
  const [dirError, setDirError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [inputText, setInputText] = useState('')
  const [pendingFiles, setPendingFiles] = useState<{ name: string; content: string }[]>([])
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')

  const wsRef = useRef<WebSocket | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      setWsStatus('open')
      ws.send(JSON.stringify({ type: 'init' }))
    }

    ws.onclose = () => {
      setWsStatus('closed')
    }

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as ServerPayload
        if (payload.type === 'bootstrap') {
          setCurrentProject(payload.currentProject)
          setConversations(payload.conversations)
          setActiveSessionId(payload.activeConversationId)
          setMessages(payload.messages)
        }
        if (payload.type === 'conversation') {
          setActiveSessionId(payload.sessionId)
          setMessages(payload.messages)
          if (payload.currentProject !== undefined) {
            setCurrentProject(payload.currentProject)
          }
        }
        if (payload.type === 'dir_list') {
          setDirPath(payload.path)
          setDirParent(payload.parent)
          setDirEntries(payload.entries)
          setDirLoading(false)
          setDirError(null)
        }
        if (payload.type === 'message') {
          setMessages((prev) => [...prev, payload.message])
        }
        if (payload.type === 'processing') {
          setIsProcessing(payload.active)
        }
        if (payload.type === 'conversations') {
          setConversations(payload.conversations)
        }
        if (payload.type === 'error') {
          setMessages((prev) => [
            ...prev,
            {
              id: `error-${Date.now()}`,
              role: 'meta',
              blocks: [{ type: 'text', text: payload.error }]
            }
          ])
        }
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: 'meta',
            blocks: [{ type: 'text', text: 'Server message could not be parsed.' }]
          }
        ])
      }
    }

    return () => {
      ws.close()
    }
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [messages, isProcessing])

  const canSend = useMemo(() => {
    return inputText.trim().length > 0 || pendingFiles.length > 0
  }, [inputText, pendingFiles])

  const uniqueConversations = useMemo(() => {
    const map = new Map<string, ConversationSummary>()
    for (const conversation of conversations) {
      const existing = map.get(conversation.sessionId)
      if (!existing || conversation.updatedAt >= existing.updatedAt) {
        map.set(conversation.sessionId, conversation)
      }
    }
    return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  }, [conversations])

  const requestDirList = (path: string | null) => {
    setDirLoading(true)
    setDirError(null)
    setDirEntries([])
    setDirParent(null)
    wsRef.current?.send(JSON.stringify({ type: 'list_dirs', path }))
  }

  const sendMessage = () => {
    if (!canSend) return
    const payload = {
      type: 'send_prompt',
      text: inputText.trim(),
      attachments: pendingFiles
    }
    wsRef.current?.send(JSON.stringify(payload))
    setInputText('')
    setPendingFiles([])
  }

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  }

  const handleFileChange: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const files = event.target.files
    if (!files) return
    const next: { name: string; content: string }[] = []
    for (const file of Array.from(files)) {
      const text = await file.text()
      next.push({ name: file.name, content: text })
    }
    setPendingFiles((prev) => [...prev, ...next])
    event.target.value = ''
  }

  const handleSelectConversation = (conversation: ConversationSummary) => {
    wsRef.current?.send(
      JSON.stringify({
        type: 'select_conversation',
        sessionId: conversation.sessionId,
        project: conversation.project
      })
    )
    setDrawerOpen(false)
  }

  const handleNewConversation = () => {
    setDrawerOpen(false)
    setProjectPickerOpen(true)
    requestDirList(null)
  }

  const handleClosePicker = () => {
    setProjectPickerOpen(false)
  }

  const handleNavigateDir = (entry: string) => {
    if (!dirPath) return
    requestDirList(`${dirPath}/${entry}`)
  }

  const handleUseFolder = () => {
    if (!dirPath) return
    wsRef.current?.send(JSON.stringify({ type: 'new_conversation', project: dirPath }))
    setMessages([])
    setActiveSessionId(null)
    setCurrentProject(dirPath)
    setProjectPickerOpen(false)
  }

  const renderBlocks = (message: ChatMessage) => {
    const hasReasoning = message.blocks.some((block) => block.type === 'reasoning')
    return (
      <>
        {message.blocks.map((block, index) => {
          if (block.type === 'text') {
            return (
              <div key={`${message.id}-text-${index}`} className="block-text">
                {block.text}
              </div>
            )
          }
          if (block.type === 'attachment') {
            return (
              <div key={`${message.id}-attachment-${index}`} className="block tool-use">
                <div className="block-label">Attachment: {block.name}</div>
                <pre>{block.text}</pre>
              </div>
            )
          }
          if (block.type === 'tool_use') {
            return (
              <div key={`${message.id}-tool-${index}`} className="block tool-use">
                <div className="block-label">Tool use: {block.name}</div>
                <pre>{block.input}</pre>
              </div>
            )
          }
          if (block.type === 'tool_result') {
            return (
              <div key={`${message.id}-tool-result-${index}`} className="block tool-result">
                <div className="block-label">Tool result</div>
                <pre>{block.text}</pre>
              </div>
            )
          }
          if (block.type === 'reasoning') {
            return (
              <div key={`${message.id}-reasoning-${index}`} className="block reasoning">
                {block.text}
              </div>
            )
          }
          return (
            <div key={`${message.id}-other-${index}`} className="block">
              <div className="block-label">Other</div>
              <pre>{block.text}</pre>
            </div>
          )
        })}
        {message.role === 'assistant' && !hasReasoning && message.meta?.reasoningStatus ? (
          <div className="block reasoning empty">Reasoning unavailable</div>
        ) : null}
      </>
    )
  }

  const overlayOpen = drawerOpen || projectPickerOpen

  return (
    <div className="app">
      <div
        className={overlayOpen ? 'scrim open' : 'scrim'}
        onClick={() => {
          setDrawerOpen(false)
          setProjectPickerOpen(false)
        }}
      />
      <aside className={drawerOpen ? 'drawer open' : 'drawer'}>
        <div className="drawer-header">Conversations</div>
        <div className="conversation-list">
          {uniqueConversations.map((conversation) => (
            <button
              key={conversation.sessionId}
              type="button"
              className={
                activeSessionId === conversation.sessionId
                  ? 'conversation-item active'
                  : 'conversation-item'
              }
              onClick={() => handleSelectConversation(conversation)}
            >
              <div className="conversation-dir">{formatProject(conversation.project)}</div>
              <div className="conversation-preview">
                {truncateWords(conversation.firstPrompt || conversation.project, 12)}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className={projectPickerOpen ? 'project-picker open' : 'project-picker'}>
        <div className="project-picker-header">
          <div>
            <div className="project-title">New conversation</div>
            <div className="project-path">{dirPath ?? 'Loading...'}</div>
          </div>
          <button type="button" className="icon-button" onClick={handleClosePicker} aria-label="Close">
            x
          </button>
        </div>
        <div className="project-actions">
          <button
            type="button"
            className="project-action primary"
            onClick={handleUseFolder}
            disabled={!dirPath || dirLoading}
          >
            Use this folder
          </button>
          <button
            type="button"
            className="project-action"
            onClick={() => requestDirList(dirParent)}
            disabled={!dirParent || dirLoading}
          >
            Up
          </button>
        </div>
        <div className="project-list">
          {dirLoading ? <div className="project-empty">Loading...</div> : null}
          {dirError ? <div className="project-empty">{dirError}</div> : null}
          {!dirLoading && !dirError && dirEntries.length === 0 ? (
            <div className="project-empty">No folders found.</div>
          ) : null}
          {dirEntries.map((entry) => (
            <button
              key={entry}
              type="button"
              className="project-entry"
              onClick={() => handleNavigateDir(entry)}
            >
              <span className="project-entry-name">{entry}</span>
            </button>
          ))}
        </div>
      </section>

      <header className="app-header">
        <button type="button" className="icon-button" onClick={() => setDrawerOpen(true)}>
          <span className="hamburger">
            <span />
          </span>
        </button>
        <button type="button" className="icon-button" onClick={handleNewConversation}>
          <span className="new-icon" aria-hidden="true" />
        </button>
      </header>

      <main className="chat-scroll" ref={scrollRef}>
        {currentProject ? (
          <div className="status-pill">{formatProject(currentProject)}</div>
        ) : (
          <div className="status-pill">No project detected</div>
        )}
        {wsStatus !== 'open' ? (
          <div className="status-pill">Server {wsStatus}</div>
        ) : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.meta?.isMeta
                ? 'message meta'
                : message.role === 'user'
                  ? 'message user'
                  : message.role === 'tool'
                    ? 'message tool'
                    : 'message'
            }
          >
            {renderBlocks(message)}
          </div>
        ))}
        {isProcessing ? (
          <div className="message">
            <div className="processing" aria-label="Processing">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </div>
          </div>
        ) : null}
      </main>

      <footer className="composer">
        {pendingFiles.length > 0 ? (
          <div className="file-list">
            {pendingFiles.map((file) => (
              <div key={file.name} className="file-chip">
                {file.name}
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer-inner">
          <textarea
            placeholder="Send a prompt"
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="composer-actions">
            <button
              type="button"
              className="file-button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach file"
            >
              +
            </button>
            <button
              type="button"
              className="send-button"
              onClick={sendMessage}
              disabled={!canSend}
              aria-label="Send prompt"
            >
              {'>'}
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={handleFileChange}
        />
      </footer>
    </div>
  )
}
