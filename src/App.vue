<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

type AgentInfo = {
  key: string
  version: string
  display_name: string
  description: string
  supported_artifacts: string[]
}

type Conversation = {
  id: string
  title: string
  status: string
  created_at: string
  updated_at: string
}

type ConversationGroup = {
  key: string
  label: string
  items: Conversation[]
}

type Message = {
  id: string
  role: 'user' | 'assistant' | string
  content: string
  created_at: string
  extra: Record<string, unknown>
}

type AttachmentSummary = {
  filename: string
  extension: string
  kind: string
  content_type?: string
  file_size: number
}

type RunSummary = {
  id: string
  status: string
  question: string
  agent_key?: string
  created_at?: string
  updated_at?: string
  result?: RunResult | null
  error?: string | null
  events?: RunEvent[]
  retry_of_run_id?: string | null
  attachments?: AttachmentSummary[]
}

type ConversationTurn = {
  id: string
  attempts: RunSummary[]
  latestRun: RunSummary
}
type RunCreateResult = {
  run_id: string
  conversation_id: string
  conversation_title: string
  status: string
}

type RunArtifact = {
  kind: string
  content?: { attachments?: AttachmentSummary[] }
}

type RunResult = {
  answer?: string
  reasoning?: string
  analysis_result?: AttendanceSummary
}

type AttendanceSummary = {
  employee_count: number
  total_attendance_days: number
  total_late_count: number
  total_missing_punch_count: number
  total_deduction: number
  employees: Array<Record<string, string | number>>
  warnings: string[]
}

type RunEvent = {
  id?: string
  event_id?: string
  run_id: string
  sequence: number
  type: string
  occurred_at: string
  payload: Record<string, unknown>
}

type ToolRequest = {
  id: string
  run_id: string
  tool_name: string
  execution_scope: string
  risk_level: string
  arguments: Record<string, unknown>
  argument_hash: string
  status: string
  requested_at: string
  result?: Record<string, unknown> | null
}

type ProcessStep = {
  id: string
  title: string
  detail: string
  occurredAt: string
  status: 'done' | 'active' | 'failed'
  meta?: string
}

// 页面状态按“可选 Agent、持久化会话、当前运行”三类组织，避免相互覆盖。
const agents = ref<AgentInfo[]>([])
const conversations = ref<Conversation[]>([])
const messages = ref<Message[]>([])
const runs = ref<RunSummary[]>([])
const events = ref<RunEvent[]>([])
const toolRequests = ref<ToolRequest[]>([])
const selectedConversationId = ref('')
const selectedAgent = ref('')
const question = ref('')
const tableText = ref('')
const tableHtml = ref('')
const attachments = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
const submitError = ref('')
const retryError = ref('')
const isSubmitting = ref(false)
const isRetrying = ref(false)
const approvalKey = ref('')
const approvalError = ref('')
const approvalBusy = ref(false)
const activeRunId = ref('')
const activeRun = ref<RunSummary | null>(null)
const eventSource = ref<EventSource | null>(null)
const messageScroll = ref<HTMLElement | null>(null)
const typedAnswer = ref('')
const isTyping = ref(false)
const reasoningText = ref('')
const isReasoning = ref(false)
const reasoningExpanded = ref(true)
const reasoningStartedAt = ref<number | null>(null)
const reasoningEndedAt = ref<number | null>(null)
const clockNow = ref(Date.now())
const isNearMessageBottom = ref(true)
const SESSIONS_COLLAPSED_KEY = 'fuecn-sessions-collapsed'
const EXECUTION_COLLAPSED_KEY = 'fuecn-execution-collapsed'
const compactSidebarDefault = typeof window !== 'undefined'
  && window.matchMedia('(max-width: 1020px)').matches
const sessionsCollapsed = ref(readCollapsedPreference(SESSIONS_COLLAPSED_KEY, compactSidebarDefault))
const executionCollapsed = ref(readCollapsedPreference(EXECUTION_COLLAPSED_KEY, compactSidebarDefault))
let clockTimer: number | undefined

const conversationGroups = computed<ConversationGroup[]>(() => {
  const dayMilliseconds = 24 * 60 * 60 * 1000
  const localDayNumber = (timestamp: number) => {
    const date = new Date(timestamp)
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / dayMilliseconds
  }
  const today = localDayNumber(clockNow.value)
  const groups: ConversationGroup[] = [
    { key: 'today', label: '今天', items: [] },
    { key: 'yesterday', label: '昨天', items: [] },
    { key: 'week', label: '7 天内', items: [] },
    { key: 'month', label: '30 天内', items: [] },
    { key: 'older', label: '更早', items: [] },
  ]

  const sorted = [...conversations.value].sort((left, right) => (
    parseServerTime(right.updated_at || right.created_at)
      - parseServerTime(left.updated_at || left.created_at)
  ))
  for (const conversation of sorted) {
    const timestamp = parseServerTime(conversation.updated_at || conversation.created_at)
    const ageInDays = timestamp ? Math.max(0, today - localDayNumber(timestamp)) : 30
    const groupIndex = ageInDays === 0 ? 0
      : ageInDays === 1 ? 1
        : ageInDays < 7 ? 2
          : ageInDays < 30 ? 3 : 4
    groups[groupIndex]?.items.push(conversation)
  }
  return groups.filter((group) => group.items.length > 0)
})

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
})
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof HTMLAnchorElement) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

// 派生状态集中定义，模板只负责展示，不重复业务判断。
const routedAgentKey = computed(() => {
  const dispatchEvent = [...events.value].reverse().find((event) => (
    String(event.payload.stage || '') === 'dispatch_agent'
  ))
  const target = String(dispatchEvent?.payload.target_agent || '')
  if (!target) return ''
  return agents.value.find((agent) => agent.key === target || agent.display_name === target)?.key || target
})
const activeAgent = computed(() => agents.value.find(
  (agent) => agent.key === (routedAgentKey.value || activeRun.value?.agent_key || 'general'),
))
const hasClipboardTable = computed(() => Boolean(tableText.value.trim() || tableHtml.value.trim()))
const hasTable = computed(() => hasClipboardTable.value || attachments.value.length > 0)
const pasteRowCount = computed(() => tableText.value.split(/\r?\n/).filter((line) => line.trim()).length)
const canSubmit = computed(() => Boolean(question.value.trim())
  && !isSubmitting.value)
const visibleProgressEvents = computed(() => events.value.filter((event) => (
  event.type !== 'message.delta' && event.type !== 'message.reasoning.delta'
)))
const processSteps = computed(() => buildProcessSteps(visibleProgressEvents.value, activeRun.value?.status || ''))
const processProgressText = computed(() => {
  const completed = processSteps.value.filter((step) => step.status === 'done').length
  return processSteps.value.length ? `${completed}/${processSteps.value.length} 已完成` : '准备执行'
})
const renderedAnswer = computed(() => renderMarkdown(typedAnswer.value))
const renderedReasoning = computed(() => renderMarkdown(reasoningText.value))
const reasoningElapsedText = computed(() => formatElapsed(
  Math.max(0, (isReasoning.value ? clockNow.value : reasoningEndedAt.value || clockNow.value)
    - (reasoningStartedAt.value || clockNow.value)),
))
const approvalRequest = computed(() => (
  activeRun.value?.status === 'waiting_approval'
    ? [...toolRequests.value].reverse().find(
      (request) => request.status === 'pending' || request.status === 'resuming',
    )
    : undefined
))
const approvalCommand = computed(() => String(approvalRequest.value?.arguments.command || ''))
const conversationTurns = computed<ConversationTurn[]>(() => {
  const runById = new Map(runs.value.map((run) => [run.id, run]))
  const groups = new Map<string, RunSummary[]>()
  for (const run of runs.value) {
    const rootId = resolveRootRunId(run, runById)
    const attempts = groups.get(rootId) || []
    attempts.push(run)
    groups.set(rootId, attempts)
  }

  const turns: ConversationTurn[] = []
  for (const [rootId, attempts] of groups) {
    attempts.sort((left, right) => runTimestamp(left) - runTimestamp(right))
    const latestRun = attempts[attempts.length - 1]
    if (!latestRun) continue
    turns.push({
      id: rootId,
      attempts,
      latestRun,
    })
  }
  return turns.sort((left, right) => runTimestamp(left.attempts[0]) - runTimestamp(right.attempts[0]))
})
const historicalTurns = computed(() => conversationTurns.value.filter(
  (turn) => !turn.attempts.some((attempt) => attempt.id === activeRunId.value),
))
const failureDetail = computed(() => {
  const failedEvent = [...events.value].reverse().find((event) => event.type === 'run.failed')
  if (failedEvent) return eventMessage(failedEvent)
  return activeRun.value?.status === 'failed' ? activeRun.value.error || '流程执行失败' : ''
})
const summary = computed(() => activeRun.value?.result?.analysis_result)
const activeConversation = computed(() => conversations.value.find((item) => item.id === selectedConversationId.value))
const visibleEmployees = computed(() => summary.value?.employees?.slice(0, 8) || [])
const runStatusText = computed(() => {
  const labels: Record<string, string> = {
    pending: '等待执行',
    running: '执行中',
    waiting_approval: '等待审批',
    completed: '已完成',
    failed: '执行失败',
  }
  return labels[activeRun.value?.status || ''] || '空闲'
})

// Agent 与会话列表互不依赖，初始化时并行加载以缩短首屏等待。
onMounted(async () => {
  clockTimer = window.setInterval(() => { clockNow.value = Date.now() }, 100)
  approvalKey.value = window.sessionStorage.getItem('fuecn-tool-approval-key') || ''
  await Promise.all([loadAgents(), loadConversations()])
  if (!selectedConversationId.value) {
    await createConversation()
  }
})

function readCollapsedPreference(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  const stored = window.localStorage.getItem(key)
  return stored === null ? fallback : stored === 'true'
}

function toggleSessions(): void {
  sessionsCollapsed.value = !sessionsCollapsed.value
  window.localStorage.setItem(SESSIONS_COLLAPSED_KEY, String(sessionsCollapsed.value))
}

function toggleExecution(): void {
  executionCollapsed.value = !executionCollapsed.value
  window.localStorage.setItem(EXECUTION_COLLAPSED_KEY, String(executionCollapsed.value))
}

onBeforeUnmount(() => {
  closeEventSource()
  if (clockTimer !== undefined) window.clearInterval(clockTimer)
})

async function loadAgents() {
  agents.value = await apiGet<AgentInfo[]>('/api/agents')
}

async function loadConversations() {
  conversations.value = await apiGet<Conversation[]>('/api/conversations')
  if (conversations.value.length && !selectedConversationId.value) {
    await selectConversation(conversations.value[0].id)
  }
}

async function refreshConversationContent(conversationId: string) {
  const detail = await apiGet<{
    messages: Message[]
    runs: RunSummary[]
  }>(`/api/conversations/${conversationId}`)
  // 请求返回前用户可能已经切换会话，旧响应不能覆盖当前对话区。
  if (selectedConversationId.value !== conversationId) return
  messages.value = detail.messages
  runs.value = detail.runs
}


async function createConversation() {
  const conversation = await apiPost<Conversation>('/api/conversations', { title: '新的会话' })
  conversations.value = [conversation, ...conversations.value]
  await selectConversation(conversation.id)
}

async function selectConversation(id: string) {
  // 切换会话前关闭旧 SSE，防止旧运行事件写入新会话界面。
  selectedConversationId.value = id
  closeEventSource()
  events.value = []
  toolRequests.value = []
  approvalError.value = ''
  retryError.value = ''
  activeRun.value = null
  resetTypewriter()
  const detail = await apiGet<{
    messages: Message[]
    runs: RunSummary[]
  }>(`/api/conversations/${id}`)
  messages.value = detail.messages
  runs.value = detail.runs
  const lastRun = detail.runs[0]
  if (lastRun) {
    activeRunId.value = lastRun.id
    await refreshRun(lastRun.id, false)
    if (['running', 'pending', 'waiting_approval'].includes(lastRun.status)) {
      connectEvents(lastRun.id)
    }
  }
  await scrollMessagesToBottom(true)
}

async function deleteConversation(conversation: Conversation) {
  if (!window.confirm(`确定删除会话“${conversation.title}”吗？相关消息和运行记录也会一并删除。`)) return

  try {
    await apiDelete(`/api/conversations/${conversation.id}`)
    conversations.value = conversations.value.filter((item) => item.id !== conversation.id)
    if (selectedConversationId.value !== conversation.id) return

    // 删除当前会话后清理运行态，并自动打开下一条；列表为空则创建一个新会话。
    closeEventSource()
    selectedConversationId.value = ''
    messages.value = []
    runs.value = []
    events.value = []
    toolRequests.value = []
    activeRunId.value = ''
    activeRun.value = null
    const nextConversation = conversations.value[0]
    if (nextConversation) {
      await selectConversation(nextConversation.id)
    } else {
      await createConversation()
    }
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '删除会话失败，请稍后重试。')
  }
}
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024
const MAX_ATTACHMENT_FILES = 5
const SUPPORTED_ATTACHMENT_EXTENSIONS = ['.xlsx', '.xlsm', '.csv', '.pdf', '.docx', '.pptx', '.txt', '.md']

function onPaste(event: ClipboardEvent) {
  const clipboard = event.clipboardData
  if (!clipboard) return

  // 优先识别从资源管理器复制的文件；部分浏览器只在 items 中暴露文件。
  const pastedFiles = Array.from(clipboard.files)
  if (!pastedFiles.length) {
    const itemFile = Array.from(clipboard.items).find((item) => item.kind === 'file')?.getAsFile()
    if (itemFile) pastedFiles.push(itemFile)
  }
  if (pastedFiles.length) {
    event.preventDefault()
    addAttachments(pastedFiles)
    return
  }

  // 只有真正的 HTML 表格或多行制表符数据才作为考勤表，普通文字仍正常粘贴到输入框。
  const html = clipboard.getData('text/html')
  const text = clipboard.getData('text/plain')
  const isTable = /<table[\s>]/i.test(html) || (text.includes('\t') && /\r?\n/.test(text))
  if (!isTable) return
  event.preventDefault()
  attachments.value = []
  tableHtml.value = html
  tableText.value = text
  submitError.value = ''
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  if (files.length) addAttachments(files)
  // 允许清除后再次选择同名文件也能触发 change。
  input.value = ''
}

function onDrop(event: DragEvent) {
  isDragging.value = false
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length) addAttachments(files)
}

function addAttachments(files: File[]) {
  const next = [...attachments.value]
  for (const file of files) {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!SUPPORTED_ATTACHMENT_EXTENSIONS.includes(extension)) {
      submitError.value = `不支持 ${extension || '无扩展名'} 文件，请上传 PDF、Word、PPT、Excel、CSV、TXT 或 Markdown。`
      return
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      submitError.value = `${file.name} 不能超过 20 MB。`
      return
    }
    const duplicate = next.some((item) => (
      item.name === file.name && item.size === file.size && item.lastModified === file.lastModified
    ))
    if (!duplicate) next.push(file)
  }
  if (next.length > MAX_ATTACHMENT_FILES) {
    submitError.value = `一次最多上传 ${MAX_ATTACHMENT_FILES} 个文件。`
    return
  }
  if (next.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    submitError.value = '附件总大小不能超过 50 MB。'
    return
  }
  attachments.value = next
  tableText.value = ''
  tableHtml.value = ''
  submitError.value = ''
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1)
}

function attachmentType(file: File): string {
  return attachmentTypeByExtension(file.name.slice(file.name.lastIndexOf('.')).toLowerCase())
}

function attachmentTypeByExtension(extension: string): string {
  const labels: Record<string, string> = {
    '.pdf': 'PDF', '.docx': 'Word', '.pptx': 'PPT',
    '.xlsx': 'Excel', '.xlsm': 'Excel', '.csv': 'CSV', '.txt': '文本', '.md': 'Markdown',
  }
  return labels[extension] || '文件'
}

function summarizeFile(file: File): AttachmentSummary {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  return {
    filename: file.name,
    extension,
    kind: attachmentTypeByExtension(extension),
    content_type: file.type || 'application/octet-stream',
    file_size: file.size,
  }
}

function turnAttachments(turn: ConversationTurn): AttachmentSummary[] {
  return turn.attempts.find((attempt) => attempt.attachments?.length)?.attachments || []
}

function openFilePicker() {
  fileInput.value?.click()
}

function applyAttachmentPrompt(value: string) {
  question.value = value
}

function clearTable() {
  tableText.value = ''
  tableHtml.value = ''
  attachments.value = []
  submitError.value = ''
}

async function submitRun() {
  // 普通问题不要求表格；只要问题非空且当前没有提交任务即可发送。
  if (!canSubmit.value) return
  isSubmitting.value = true
  submitError.value = ''
  const submittedQuestion = question.value.trim()
  const submittedFiles = [...attachments.value]
  const requestedAgent = selectedAgent.value
  try {
    if (!selectedConversationId.value) {
      await createConversation()
    }

    let response: RunCreateResult
    if (submittedFiles.length) {
      const form = new FormData()
      form.append('question', submittedQuestion)
      if (requestedAgent) form.append('agent_key', requestedAgent)
      for (const file of submittedFiles) form.append('files', file, file.name)
      response = await apiPostForm<RunCreateResult>(
        `/api/conversations/${selectedConversationId.value}/runs/files`,
        form,
      )
    } else {
      response = await apiPost<RunCreateResult>(
        `/api/conversations/${selectedConversationId.value}/runs`,
        {
          question: submittedQuestion,
          ...(requestedAgent ? { agent_key: requestedAgent } : {}),
          table_text: tableText.value,
          table_html: tableHtml.value,
        },
      )
    }

    const currentConversation = conversations.value.find(
      (conversation) => conversation.id === response.conversation_id,
    )
    if (currentConversation) currentConversation.title = response.conversation_title
    activeRunId.value = response.run_id
    const pendingRun: RunSummary = {
      id: response.run_id,
      status: 'pending',
      question: submittedQuestion,
      agent_key: requestedAgent || undefined,
      created_at: new Date().toISOString(),
      events: [],
      attachments: submittedFiles.map(summarizeFile),
    }
    activeRun.value = pendingRun
    runs.value = [pendingRun, ...runs.value]
    resetTypewriter()
    // 先乐观显示用户消息，后台持久化版本会在下次刷新会话时替换它。
    messages.value.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: submittedQuestion,
      created_at: new Date().toISOString(),
      extra: { run_id: response.run_id },
    })
    events.value = []
    toolRequests.value = []
    approvalError.value = ''
    question.value = ''
    clearTable()
    connectEvents(response.run_id)
    await scrollMessagesToBottom(true)
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : '提交失败，请稍后重试。'
  } finally {
    isSubmitting.value = false
  }
}

async function retryRun() {
  const sourceRun = activeRun.value
  if (!sourceRun || sourceRun.status !== 'failed' || isRetrying.value) return
  isRetrying.value = true
  retryError.value = ''
  try {
    const response = await apiPost<RunCreateResult>(
      `/api/runs/${sourceRun.id}/retry`,
      {},
    )
    const currentConversation = conversations.value.find(
      (conversation) => conversation.id === response.conversation_id,
    )
    if (currentConversation) currentConversation.title = response.conversation_title
    activeRunId.value = response.run_id
    const pendingRun: RunSummary = {
      id: response.run_id,
      status: 'pending',
      question: sourceRun.question,
      agent_key: sourceRun.agent_key,
      created_at: new Date().toISOString(),
      events: [],
      retry_of_run_id: sourceRun.id,
      attachments: sourceRun.attachments || [],
    }
    activeRun.value = pendingRun
    runs.value = [pendingRun, ...runs.value]
    // 新运行使用独立事件序列；旧失败运行仍保留在数据库中供历史复查。
    events.value = []
    toolRequests.value = []
    approvalError.value = ''
    resetTypewriter()
    connectEvents(response.run_id)
    await scrollMessagesToBottom(true)
  } catch (error) {
    retryError.value = error instanceof Error ? error.message : '重新执行失败，请稍后重试。'
  } finally {
    isRetrying.value = false
  }
}
function connectEvents(runId: string) {
  // 一个页面只保留一个活动连接，避免重复订阅和事件重复渲染。
  closeEventSource()
  const source = new EventSource(`/api/runs/${runId}/events`)
  eventSource.value = source
  source.onmessage = (message) => appendEvent(message.data)
  // 服务端发送了具名 SSE 事件，必须逐类监听；onmessage 仅兼容默认事件。
  const names = [
    'run.started',
    'run.progress',
    'message.reasoning.delta',
    'message.delta',
    'tool.started',
    'tool.completed',
    'approval.required',
    'approval.resolved',
    'input.required',
    'run.completed',
    'run.failed',
  ]
  for (const name of names) {
    source.addEventListener(name, (message) => appendEvent((message as MessageEvent).data))
  }
}

async function appendEvent(raw: string) {
  const event = JSON.parse(raw) as RunEvent
  if (event.run_id !== activeRunId.value) return
  // SSE 重连可能补发历史事件，以 sequence 去重后再追加到内嵌执行轨迹。
  if (!events.value.some((item) => item.sequence === event.sequence)) {
    events.value.push(event)
    if (event.type === 'run.started' && activeRun.value) {
      activeRun.value.status = 'running'
    }
    if (event.type === 'approval.required' && activeRun.value) {
      activeRun.value.status = 'waiting_approval'
      await refreshRun(event.run_id, false)
    }
    if (event.type === 'approval.resolved') {
      await refreshRun(event.run_id, false)
    }
    if (event.type === 'message.delta') {
      finishReasoning(event.occurred_at)
      enqueueAnswerChunk(String(event.payload.content || ''))
    }
    if (event.type === 'message.reasoning.delta') {
      enqueueReasoningChunk(String(event.payload.content || ''), event.occurred_at)
    }
  }
  await scrollMessagesToBottom()
  if (event.type === 'run.completed' || event.type === 'run.failed') {
    const conversationId = selectedConversationId.value
    isTyping.value = false
    finishReasoning(event.occurred_at)
    closeEventSource()
    await refreshRun(event.run_id, true)
    await Promise.all([loadConversations(), refreshConversationContent(conversationId)])
  }
}

async function refreshRun(runId: string, animateAnswer = true) {
  // 从持久化接口恢复最终结果及完整事件，确保刷新页面后仍可复查。
  const detail = await apiGet<{
    run: RunSummary
    events: RunEvent[]
    artifacts: RunArtifact[]
    tool_requests: ToolRequest[]
  }>(`/api/runs/${runId}`)
  const attachmentArtifact = detail.artifacts?.find((artifact) => artifact.kind === 'raw-attachments')
  detail.run.attachments = (attachmentArtifact?.content?.attachments || []).map((item) => ({
    filename: item.filename,
    extension: item.extension,
    kind: item.kind,
    content_type: item.content_type,
    file_size: item.file_size,
  }))
  activeRun.value = detail.run
  toolRequests.value = detail.tool_requests || []
  events.value = detail.events.map((event) => ({
    event_id: event.event_id ?? event.id,
    run_id: event.run_id,
    sequence: event.sequence,
    type: event.type,
    occurred_at: event.occurred_at,
    payload: event.payload,
  })) as RunEvent[]
  setAnswerTarget(String(detail.run.result?.answer || ''), animateAnswer)
  restoreReasoning(detail.run, events.value)
  await scrollMessagesToBottom()
}

async function decideToolRequest(action: 'approve' | 'reject') {
  const request = approvalRequest.value
  const key = approvalKey.value.trim()
  if (!request || approvalBusy.value) return
  if (!key) {
    approvalError.value = '请输入审批口令。'
    return
  }
  approvalBusy.value = true
  approvalError.value = ''
  try {
    window.sessionStorage.setItem('fuecn-tool-approval-key', key)
    await apiPostWithHeaders(
      `/api/runs/${request.run_id}/tool-requests/${request.id}/decision`,
      { action, argument_hash: request.argument_hash },
      { 'X-Tool-Approval-Key': key },
    )
    request.status = 'resuming'
  } catch (error) {
    approvalError.value = error instanceof Error ? error.message : '审批提交失败，请稍后重试。'
  } finally {
    approvalBusy.value = false
  }
}
function enqueueAnswerChunk(content: string) {
  if (!content) return
  // message.delta 始终是后端真实产生的新增文本；兼容旧版累计全文事件。
  typedAnswer.value = content.startsWith(typedAnswer.value)
    ? content
    : `${typedAnswer.value}${content}`
  isTyping.value = true
}

function enqueueReasoningChunk(content: string, occurredAt: string) {
  if (!content) return
  if (reasoningStartedAt.value === null) {
    reasoningStartedAt.value = parseServerTime(occurredAt) || Date.now()
  }
  reasoningEndedAt.value = null
  reasoningText.value = `${reasoningText.value}${content}`
  isReasoning.value = true
  reasoningExpanded.value = true
}

function finishReasoning(occurredAt?: string) {
  if (!isReasoning.value) return
  isReasoning.value = false
  reasoningEndedAt.value = occurredAt ? parseServerTime(occurredAt) : Date.now()
  reasoningExpanded.value = false
}

function restoreReasoning(run: RunSummary, source: RunEvent[]) {
  const reasoningEvents = source.filter((event) => event.type === 'message.reasoning.delta')
  reasoningText.value = String(run.result?.reasoning || '')
    || reasoningEvents.map((event) => String(event.payload.content || '')).join('')
  const first = reasoningEvents[0]
  const last = reasoningEvents[reasoningEvents.length - 1]
  reasoningStartedAt.value = first ? parseServerTime(first.occurred_at) : null
  if (!last) {
    reasoningEndedAt.value = null
    isReasoning.value = false
    reasoningExpanded.value = false
    return
  }
  const closingEvent = source.find((event) => (
    event.sequence > last.sequence
    && (event.type === 'message.delta' || event.type === 'run.completed' || event.type === 'run.failed')
  ))
  isReasoning.value = !closingEvent && ['running', 'pending'].includes(run.status)
  reasoningEndedAt.value = closingEvent ? parseServerTime(closingEvent.occurred_at) : null
  reasoningExpanded.value = isReasoning.value
}

function setAnswerTarget(answer: string, _animate: boolean) {
  if (!answer) {
    typedAnswer.value = ''
    isTyping.value = false
    return
  }
  typedAnswer.value = answer
  isTyping.value = false
}

function renderMarkdown(value: string): string {
  if (!value) return ''
  return DOMPurify.sanitize(markdown.render(value), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed'],
  })
}

function resetTypewriter() {
  typedAnswer.value = ''
  isTyping.value = false
  reasoningText.value = ''
  isReasoning.value = false
  reasoningExpanded.value = true
  reasoningStartedAt.value = null
  reasoningEndedAt.value = null
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0.1, milliseconds / 1000).toFixed(1)} 秒`
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} 秒`
  const minutes = Math.floor(milliseconds / 60000)
  const seconds = Math.floor((milliseconds % 60000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

function processStepElapsed(step: ProcessStep): string {
  const startedAt = parseServerTime(step.occurredAt)
  return formatElapsed(Math.max(0, clockNow.value - startedAt))
}

function parseServerTime(value: string): number {
  if (!value) return 0
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const withTimezone = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(normalized)
    ? normalized
    : `${normalized}Z`
  const timestamp = Date.parse(withTimezone)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (canSubmit.value) void submitRun()
}

function handleMessageScroll() {
  const element = messageScroll.value
  if (!element) return
  isNearMessageBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 96
}

async function scrollMessagesToBottom(force = false) {
  await nextTick()
  const element = messageScroll.value
  if (!element || (!force && !isNearMessageBottom.value)) return
  element.scrollTop = element.scrollHeight
  isNearMessageBottom.value = true
}
function closeEventSource() {
  eventSource.value?.close()
  eventSource.value = null
}

// 轻量请求封装统一处理非 2xx 响应，后续可在此接入鉴权和错误提示。
async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<T>
}

async function apiPost<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<T>
}

async function apiPostWithHeaders<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<T>
}

async function apiPostForm<T>(
  url: string,
  payload: FormData,
  headers: Record<string, string> = {},
): Promise<T> {
  // 不手动设置 Content-Type，由浏览器自动附加 multipart boundary。
  const response = await fetch(url, { method: 'POST', headers, body: payload })
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<T>
}

async function apiDelete(url: string): Promise<void> {
  const response = await fetch(url, { method: 'DELETE' })
  if (!response.ok) throw new Error(await response.text())
}

function resolveRootRunId(run: RunSummary, runById: Map<string, RunSummary>): string {
  let current = run
  const visited = new Set<string>()
  while (current.retry_of_run_id && !visited.has(current.id)) {
    visited.add(current.id)
    const parent = runById.get(current.retry_of_run_id)
    if (!parent) return current.retry_of_run_id
    current = parent
  }
  return current.id
}

function runTimestamp(run: RunSummary | undefined): number {
  if (!run?.created_at) return 0
  return parseServerTime(run.created_at)
}

function runReasoning(run: RunSummary): string {
  const persisted = String(run.result?.reasoning || '')
  if (persisted) return persisted
  return (run.events || [])
    .filter((event) => event.type === 'message.reasoning.delta')
    .map((event) => String(event.payload.content || ''))
    .join('')
}

function runReasoningElapsed(run: RunSummary): string {
  const source = run.events || []
  const reasoningEvents = source.filter((event) => event.type === 'message.reasoning.delta')
  const first = reasoningEvents[0]
  const last = reasoningEvents[reasoningEvents.length - 1]
  if (!first || !last) return ''
  const end = source.find((event) => (
    event.sequence > last.sequence
    && (event.type === 'message.delta' || event.type === 'run.completed' || event.type === 'run.failed')
  ))
  const duration = parseServerTime(end?.occurred_at || last.occurred_at)
    - parseServerTime(first.occurred_at)
  return formatElapsed(Math.max(0, duration))
}

function runAnswer(run: RunSummary): string {
  const resultAnswer = String(run.result?.answer || '')
  if (resultAnswer) return resultAnswer
  const assistantMessage = messages.value.find((message) => (
    message.role === 'assistant' && String(message.extra?.run_id || '') === run.id
  ))
  return assistantMessage?.content || ''
}

function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '等待执行',
    running: '执行中',
    waiting_approval: '等待审批',
    completed: '已完成',
    failed: '执行失败',
  }
  return labels[status] || status
}

function agentDisplayName(agentKey?: string): string {
  return agents.value.find((agent) => agent.key === agentKey)?.display_name || 'Agent'
}

function policyCategoryLabel(category: unknown): string {
  const labels: Record<string, string> = {
    filesystem_delete: '文件删除',
    filesystem_destroy: '文件破坏',
    system_power: '系统电源',
    system_control: '系统控制',
    disk_destroy: '磁盘破坏',
    system_mount: '文件系统挂载',
    privilege_escalation: '权限提升',
    container_escape: '容器隔离',
    container_control: '容器控制',
    process_control: '进程控制',
    indirect_execution: '间接执行',
    resource_exhaustion: '资源耗尽',
    invalid_command: '命令格式',
  }
  return labels[String(category || '')] || '高风险操作'
}

function buildProcessSteps(source: RunEvent[], runStatus: string): ProcessStep[] {
  const steps: ProcessStep[] = []
  const activate = (step: ProcessStep) => {
    for (const item of steps) {
      if (item.status === 'active') item.status = 'done'
    }
    const existing = steps.find((item) => item.id === step.id)
    if (existing) {
      Object.assign(existing, step)
    } else {
      steps.push(step)
    }
  }

  for (const event of source) {
    const stage = String(event.payload.stage || '')
    const occurredAt = event.occurred_at
    if (event.type === 'run.started') {
      activate({ id: 'start', title: '开始处理你的请求', detail: '已创建执行上下文并载入会话信息', occurredAt, status: 'active' })
      continue
    }
    if (event.type === 'approval.required') {
      activate({ id: 'approval', title: '等待你确认高风险操作', detail: '命令参数已锁定，确认后才会在隔离环境执行', occurredAt, status: 'active' })
      continue
    }
    if (event.type === 'approval.resolved') {
      const step = steps.find((item) => item.id === 'approval')
      if (step) {
        step.status = event.payload.action === 'approve' ? 'done' : 'failed'
        step.detail = event.payload.action === 'approve' ? '已确认，继续执行' : '已拒绝，本次命令不会执行'
      }
      continue
    }
    const definition = processStageDefinition(stage)
    if (event.type === 'tool.started' && definition && !event.payload.tool) {
      activate({
        id: definition.id,
        title: definition.title,
        detail: String(event.payload.message || definition.detail),
        occurredAt,
        status: 'active',
      })
      continue
    }
    if (event.type === 'tool.completed' && definition && !event.payload.tool) {
      const step = steps.find((item) => item.id === definition.id)
      if (step) {
        step.status = event.payload.ok === false ? 'failed' : 'done'
        step.detail = event.payload.ok === false ? '处理未成功' : `${definition.title}完成`
      }
      continue
    }
    if (event.type === 'tool.started') {
      const tool = String(event.payload.tool || 'tool')
      const args = (event.payload.args || {}) as Record<string, unknown>
      const command = String(args.command || '').trim()
      const requestId = String(event.payload.request_id || event.sequence)
      activate({
        id: `tool-${requestId}`,
        title: toolStepTitle(tool),
        detail: command ? `执行：${truncateText(command, 120)}` : '工具正在处理所需数据',
        occurredAt,
        status: 'active',
        meta: args.cwd ? `工作目录：${String(args.cwd)}` : undefined,
      })
      continue
    }
    if (event.type === 'tool.completed') {
      const requestId = String(event.payload.request_id || '')
      const tool = String(event.payload.tool || '')
      const step = [...steps].reverse().find((item) => (
        item.status === 'active'
        && (requestId ? item.id === `tool-${requestId}` : item.title === toolStepTitle(tool))
      ))
      if (step) {
        if (event.payload.blocked_by_policy) {
          step.title = '命令安全检查'
          step.status = 'failed'
          step.detail = String(event.payload.reason || '该命令违反安全策略，未执行')
          step.meta = '已拦截 · ' + policyCategoryLabel(event.payload.category)
        } else {
          step.status = event.payload.ok === false ? 'failed' : 'done'
          step.detail = event.payload.rejected ? '用户已拒绝执行' : event.payload.ok === false ? '工具执行未成功' : '工具执行完成'
        }
      }
      continue
    }
    if (event.type === 'run.failed') {
      activate({ id: 'failed', title: '执行遇到问题', detail: eventMessage(event), occurredAt, status: 'failed' })
      continue
    }
    if (event.type === 'run.completed') {
      activate({ id: 'complete', title: '完成并生成答复', detail: '结果已保存，可以继续追问', occurredAt, status: 'done' })
      continue
    }

    if (definition) {
      activate({
        id: definition.id,
        title: definition.title,
        detail: String(event.payload.message || definition.detail),
        occurredAt,
        status: 'active',
      })
    }
  }

  if (runStatus === 'completed') {
    for (const step of steps) {
      if (step.status === 'active') step.status = 'done'
    }
  } else if (runStatus === 'failed') {
    const active = [...steps].reverse().find((step) => step.status === 'active')
    if (active) active.status = 'failed'
  }
  return steps
}

function processStageDefinition(stage: string) {
  const definitions: Record<string, { id: string; title: string; detail: string }> = {
    recognize_intent: { id: 'intent', title: '理解你的目标', detail: '正在判断最合适的处理方式' },
    dispatch_agent: { id: 'route', title: '选择合适的处理能力', detail: '已根据内容自动分配专业 Agent' },
    analyze_task: { id: 'plan', title: '分析任务并制定计划', detail: '正在拆解目标和所需步骤' },
    think: { id: 'reason', title: '规划下一步操作', detail: '正在判断是否需要使用工具' },
    direct_chat: { id: 'answer', title: '组织最终答复', detail: '正在生成回复内容' },
    parse_input: { id: 'parse', title: '读取考勤数据', detail: '正在解析输入表格' },
    parse_excel: { id: 'parse', title: '读取考勤数据', detail: '正在解析 Excel 文件' },
    normalize_data: { id: 'normalize', title: '整理考勤字段', detail: '正在统一字段和数据格式' },
    normalize_attendance: { id: 'normalize', title: '整理考勤字段', detail: '正在统一字段和数据格式' },
    analyze_attendance: { id: 'analyze', title: '计算考勤结果', detail: '正在统计出勤、迟到、缺卡和扣款' },
    parse_attachments: { id: 'documents', title: '读取上传附件', detail: '正在安全解析文件内容' },
    analyze_document: { id: 'document-analysis', title: '分析文档内容', detail: '正在分段提取重点和事实' },
    generate_document_answer: { id: 'answer', title: '整理文档结论', detail: '正在根据附件生成最终答复' },
    build_answer: { id: 'answer', title: '整理分析结论', detail: '正在生成清晰的结果说明' },
    generate_answer: { id: 'answer', title: '整理分析结论', detail: '正在生成清晰的结果说明' },
    persist_result: { id: 'save', title: '保存执行结果', detail: '正在保存结果和执行记录' },
    final: { id: 'answer', title: '生成最终答复', detail: '正在组织回复内容' },
  }
  return definitions[stage]
}

function toolStepTitle(tool: string): string {
  const labels: Record<string, string> = {
    run_shell: '在隔离环境执行命令',
    read_file: '读取工作区文件',
    web_fetch: '获取网页内容',
    database_query: '查询业务数据',
  }
  return labels[tool] || `使用工具：${tool || '未知工具'}`
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
}

function eventStage(event: RunEvent): string {
  const stage = String(event.payload.stage || event.type)
  const labels: Record<string, string> = {
    recognize_intent: '理解需求',
    direct_chat: '生成回复',
    dispatch_agent: '进入专业分析',
    analyze_task: '分析任务',
    think: '规划下一步',
    parse_excel: '解析 Excel',
    normalize_attendance: '整理考勤字段',
    generate_answer: '生成分析结论',
    persist_result: '保存执行结果',
    parse_input: '解析考勤数据',
    normalize_data: '整理考勤字段',
    analyze_attendance: '计算考勤结果',
    parse_attachments: '读取上传附件',
    analyze_document: '分析文档内容',
    generate_document_answer: '整理文档结论',
    build_answer: '生成分析结论',
    'run.started': '任务开始',
    'run.completed': '任务完成',
    'run.failed': '任务失败',
    'tool.started': '调用工具',
    'tool.completed': '工具调用完成',
    'approval.required': '等待高风险操作审批',
    'approval.resolved': '审批已提交',
  }
  return labels[stage] || stage
}

function eventMessage(event: RunEvent): string {
  if (event.type === 'approval.required') return '命令已冻结，等待用户核对参数并授权。'
  if (event.type === 'approval.resolved') {
    return event.payload.action === 'approve' ? '已授权，准备进入隔离环境执行。' : '已拒绝执行。'
  }
  const message = String(event.payload.message || event.payload.content || event.type)
  if (event.type !== 'run.failed') return message

  // 失败事件同时展示异常链和安全服务地址，避免页面只剩笼统的 Connection error。
  const fallbackError = [event.payload.error_type, event.payload.error].filter(Boolean).join(': ')
  const detail = String(event.payload.detail || fallbackError || '')
  const endpoint = event.payload.endpoint ? `服务地址：${String(event.payload.endpoint)}` : ''
  return [message, detail, endpoint].filter(Boolean).join('\n')
}

function formatFileSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(value: string): string {
  const timestamp = parseServerTime(value)
  return timestamp
    ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '--:--'
}
</script>

<template>
  <main
    class="shell"
    :class="{
      'sessions-collapsed': sessionsCollapsed,
      'execution-collapsed': executionCollapsed,
    }"
  >
    <aside v-if="!sessionsCollapsed" class="sessions" aria-label="会话列表">
      <div class="brand-row">
        <div class="brand-identity">
          <span class="brand-mark">F</span>
          <strong>Fuecn Agent</strong>
        </div>
        <button
          class="sidebar-collapse-button"
          type="button"
          aria-label="折叠会话列表"
          title="折叠会话列表"
          :aria-expanded="true"
          @click="toggleSessions"
        >‹</button>
      </div>

      <button class="new-chat" type="button" @click="createConversation">
        <span>＋</span>
        新建会话
      </button>

      <nav class="session-list" aria-label="会话列表">
        <section v-for="group in conversationGroups" :key="group.key" class="session-group">
          <p>{{ group.label }}</p>
          <div
            v-for="conversation in group.items"
            :key="conversation.id"
            class="session-item"
            :class="{ active: conversation.id === selectedConversationId }"
          >
            <button class="session-open" type="button" @click="selectConversation(conversation.id)">
              <span>{{ conversation.title }}</span>
              <small>{{ formatTime(conversation.updated_at) }}</small>
            </button>
            <button
              class="session-delete"
              type="button"
              :aria-label="`删除会话：${conversation.title}`"
              title="删除会话"
              @click.stop="deleteConversation(conversation)"
            >
              ×
            </button>
          </div>
        </section>
      </nav>
    </aside>

    <section class="chat">
      <header class="chat-topbar">
        <div class="chat-topbar-left">
          <div v-if="sessionsCollapsed" class="sidebar-quick-controls">
            <button
              class="sidebar-restore-button"
              type="button"
              aria-label="展开会话列表"
              title="展开会话列表"
              :aria-expanded="false"
              @click="toggleSessions"
            >☰</button>
            <button
              class="sidebar-restore-button"
              type="button"
              aria-label="新建会话"
              title="新建会话"
              @click="createConversation"
            >＋</button>
          </div>
          <div class="chat-title">
            <span class="crumb">当前会话</span>
            <strong>{{ activeConversation?.title || '新的会话' }}</strong>
          </div>
        </div>
        <div class="chat-topbar-actions">
          <span class="run-state">{{ runStatusText }}</span>
          <button
            v-if="executionCollapsed"
            class="sidebar-restore-button trace-restore-button"
            :class="{ active: activeRun?.status === 'running' }"
            type="button"
            aria-label="展开执行轨迹"
            title="展开执行轨迹"
            :aria-expanded="false"
            @click="toggleExecution"
          >◎</button>
        </div>
      </header>

      <div ref="messageScroll" class="message-scroll" @scroll="handleMessageScroll">
        <section v-if="!historicalTurns.length && !activeRun" class="empty-chat">
          <p>智能任务协作</p>
          <h1>描述目标，Agent 会自动选择处理方式。</h1>
          <span>直接提问，或添加 Excel 数据；系统会自动识别意图、选择能力，并清晰展示处理过程。</span>
        </section>

        <section v-for="turn in historicalTurns" :key="turn.id" class="conversation-turn historical-turn">
          <article class="message user">
            <div class="avatar">我</div>
            <div class="bubble user-bubble">
              <div v-if="turnAttachments(turn).length" class="sent-attachment-grid">
                <article
                  v-for="(attachment, index) in turnAttachments(turn)"
                  :key="`${turn.id}-${attachment.filename}-${index}`"
                  class="attachment-card sent-attachment-card"
                >
                  <span class="file-glyph" :data-kind="attachmentTypeByExtension(attachment.extension)" aria-hidden="true">{{ attachmentTypeByExtension(attachment.extension).slice(0, 1) }}</span>
                  <div><strong>{{ attachment.filename }}</strong><small>{{ attachmentTypeByExtension(attachment.extension) }} · {{ formatFileSize(attachment.file_size) }}</small></div>
                </article>
              </div>
              <p>{{ turn.attempts[0]?.question || turn.latestRun.question }}</p>
            </div>
          </article>
          <article class="message assistant run-message">
            <div class="avatar agent-avatar">A</div>
            <section class="agent-panel historical-agent-panel">
              <header class="agent-message-header">
                <div>
                  <strong>{{ agentDisplayName(turn.latestRun.agent_key) }}</strong>
                  <span :class="`status-${turn.latestRun.status}`">{{ runStatusLabel(turn.latestRun.status) }}</span>
                </div>
                <small>{{ formatTime(turn.latestRun.updated_at || turn.latestRun.created_at || '') }}</small>
              </header>

              <details v-if="runReasoning(turn.latestRun)" class="reasoning-panel historical-reasoning">
                <summary>
                  <span class="reasoning-orb" aria-hidden="true">✦</span>
                  <strong>已深度思考<span v-if="runReasoningElapsed(turn.latestRun)"> {{ runReasoningElapsed(turn.latestRun) }}</span></strong>
                  <small>查看思考过程</small>
                </summary>
                <div class="reasoning-content markdown-body" v-html="renderMarkdown(runReasoning(turn.latestRun))"></div>
              </details>

              <div
                v-if="runAnswer(turn.latestRun)"
                class="historical-answer markdown-body"
                :class="{ 'without-reasoning': !runReasoning(turn.latestRun) }"
                v-html="renderMarkdown(runAnswer(turn.latestRun))"
              ></div>
              <div v-else-if="turn.latestRun.error" class="run-error compact-error">
                <p>{{ turn.latestRun.error }}</p>
              </div>
            </section>
          </article>
        </section>

        <section v-if="activeRun" class="conversation-turn active-turn">
          <article class="message user">
            <div class="avatar">我</div>
            <div class="bubble user-bubble">
              <div v-if="activeRun.attachments?.length" class="sent-attachment-grid">
                <article
                  v-for="(attachment, index) in activeRun.attachments"
                  :key="`${activeRun.id}-${attachment.filename}-${index}`"
                  class="attachment-card sent-attachment-card"
                >
                  <span class="file-glyph" :data-kind="attachmentTypeByExtension(attachment.extension)" aria-hidden="true">{{ attachmentTypeByExtension(attachment.extension).slice(0, 1) }}</span>
                  <div><strong>{{ attachment.filename }}</strong><small>{{ attachmentTypeByExtension(attachment.extension) }} · {{ formatFileSize(attachment.file_size) }}</small></div>
                </article>
              </div>
              <p>{{ activeRun.question }}</p>
            </div>
          </article>
          <article class="message assistant run-message">
            <div class="avatar agent-avatar">A</div>
            <section class="agent-panel">
              <header class="agent-message-header">
                <div>
                  <strong>{{ activeAgent?.display_name || 'Agent' }}</strong>
                  <span :class="`status-${activeRun.status}`">{{ runStatusText }}</span>
                </div>
                
              </header>

              <section v-if="approvalRequest" class="approval-card" aria-labelledby="approval-title">
                <header>
                  <div>
                    <span class="risk-mark">HIGH RISK</span>
                    <h2 id="approval-title">服务器隔离命令待审批</h2>
                  </div>
                  <span class="sandbox-badge">隔离容器 · 禁止联网</span>
                </header>
                <p>批准只对当前 Run、当前参数摘要生效，不会授权后续命令。</p>
                <pre><code>{{ approvalCommand }}</code></pre>
                <dl>
                  <div><dt>工作目录</dt><dd>{{ approvalRequest.arguments.cwd || '.' }}</dd></div>
                  <div><dt>超时</dt><dd>{{ approvalRequest.arguments.timeout || 30 }} 秒</dd></div>
                  <div><dt>参数摘要</dt><dd class="argument-hash">{{ approvalRequest.argument_hash }}</dd></div>
                </dl>
                <label class="approval-key-field">
                  <span>审批口令</span>
                  <input
                    v-model="approvalKey"
                    type="password"
                    autocomplete="off"
                    placeholder="仅保存在当前浏览器会话"
                    :disabled="approvalBusy || approvalRequest.status === 'resuming'"
                  />
                </label>
                <div class="approval-actions">
                  <span v-if="approvalError">{{ approvalError }}</span>
                  <button class="reject-command" type="button"
                    :disabled="approvalBusy || approvalRequest.status === 'resuming'"
                    @click="decideToolRequest('reject')">拒绝</button>
                  <button class="approve-command" type="button"
                    :disabled="approvalBusy || approvalRequest.status === 'resuming'"
                    @click="decideToolRequest('approve')">
                    {{ approvalRequest.status === 'resuming' ? '正在提交…' : '批准本次执行' }}
                  </button>
                </div>
              </section>

              <section v-if="reasoningText || isReasoning" class="reasoning-panel" :class="{ 'is-active': isReasoning }">
                <button class="reasoning-toggle" type="button" @click="reasoningExpanded = !reasoningExpanded">
                  <span class="reasoning-orb" aria-hidden="true">✦</span>
                  <strong>{{ isReasoning ? '正在深度思考' : '已深度思考' }} {{ reasoningElapsedText }}</strong>
                  <span class="reasoning-chevron" :class="{ expanded: reasoningExpanded }">⌄</span>
                </button>
                <div
                  v-show="reasoningExpanded"
                  class="reasoning-content markdown-body"
                  :class="{ 'is-reasoning': isReasoning }"
                  v-html="renderedReasoning"
                ></div>
              </section>

              <div
                v-if="typedAnswer || isTyping"
                class="answer-text"
                :class="{ 'without-reasoning': !reasoningText && !isReasoning }"
                aria-live="polite"
              >
                <header><strong>最终答复</strong><span>{{ isTyping ? '正在接收回复' : '生成完成' }}</span></header>
                <div
                  class="markdown-body"
                  :class="{ 'is-typing': isTyping }"
                  v-html="renderedAnswer"
                ></div>
              </div>

              <div v-if="failureDetail" class="run-error">
                <p>{{ failureDetail }}</p>
                <div class="run-error-actions">
                  <span v-if="retryError">{{ retryError }}</span>
                  <button type="button" :disabled="isRetrying" @click="retryRun">
                    {{ isRetrying ? '正在重新执行…' : '重新执行' }}
                  </button>
                </div>
              </div>

              <div v-if="summary" class="metric-grid">
                <div><span>人数</span><strong>{{ summary.employee_count }}</strong></div>
                <div><span>出勤</span><strong>{{ summary.total_attendance_days }} 天</strong></div>
                <div><span>迟到</span><strong>{{ summary.total_late_count }} 次</strong></div>
                <div><span>扣款</span><strong>{{ summary.total_deduction }} 元</strong></div>
              </div>
              <div v-if="visibleEmployees.length" class="result-table-wrap">
                <table class="result-table">
                  <thead>
                    <tr>
                      <th>姓名</th>
                      <th>出勤</th>
                      <th>迟到</th>
                      <th>缺卡</th>
                      <th>扣款</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in visibleEmployees" :key="String(row.name)">
                      <td>{{ row.name }}</td>
                      <td>{{ row.attendance_days }}</td>
                      <td>{{ row.late_count }}</td>
                      <td>{{ row.missing_punch_count }}</td>
                      <td>{{ row.deduction }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </article>
        </section>
      </div>
      <footer
        class="composer-wrap"
        @paste="onPaste"
        @dragenter.prevent="isDragging = true"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="onDrop"
      >
        <div class="composer" :class="{ dragging: isDragging }">
          <section v-if="hasTable" class="composer-attachments" aria-label="已添加的附件">
            <div class="attachment-grid">
              <article
                v-for="(file, index) in attachments"
                :key="`${file.name}-${file.size}-${file.lastModified}`"
                class="attachment-card"
              >
                <span class="file-glyph" :data-kind="attachmentType(file)" aria-hidden="true">{{ attachmentType(file).slice(0, 1) }}</span>
                <div><strong>{{ file.name }}</strong><small>{{ attachmentType(file) }} · {{ formatFileSize(file.size) }} · 已就绪</small></div>
                <button type="button" aria-label="移除附件" title="移除附件" @click="removeAttachment(index)">×</button>
              </article>
              <article v-if="hasClipboardTable" class="attachment-card">
                <span class="file-glyph" data-kind="Excel" aria-hidden="true">X</span>
                <div><strong>剪贴板表格</strong><small>{{ pasteRowCount }} 行数据 · 已就绪</small></div>
                <button type="button" aria-label="移除表格" title="移除表格" @click="clearTable">×</button>
              </article>
            </div>
            <div class="attachment-prompts">
              <button type="button" @click="applyAttachmentPrompt('梳理附件的重点内容，并给出结构化总结')">梳理重点内容 <span>→</span></button>
              <button type="button" @click="applyAttachmentPrompt('分析附件，找出关键结论、异常和需要关注的问题')">分析并找出问题 <span>→</span></button>
            </div>
          </section>
          <textarea
            v-model="question"
            rows="3"
            placeholder="发消息，或粘贴、拖入 PDF、Word、PPT、Excel 等文件…"
            @keydown="handleComposerKeydown"
          />
          <div class="composer-tools">
            <div class="tool-left">
              <input
                ref="fileInput"
                class="excel-file-input"
                type="file"
                accept=".xlsx,.xlsm,.csv,.pdf,.docx,.pptx,.txt,.md"
                multiple
                @change="onFileChange"
              />
              <button
                class="attach-button"
                type="button"
                title="添加附件"
                @click="openFilePicker"
              >
                <span aria-hidden="true">＋</span>
              </button>
              <label class="agent-picker">
                <span aria-hidden="true">✦</span>
                <select v-model="selectedAgent" aria-label="选择智能体">
                  <option value="">自动选择智能体</option>
                  <option v-for="agent in agents" :key="agent.key" :value="agent.key">{{ agent.display_name }}</option>
                </select>
              </label>
            </div>
            <button class="send" type="button" :disabled="!canSubmit" @click="submitRun">
              {{ isSubmitting ? '...' : '↑' }}
            </button>
          </div>
        </div>
        <p v-if="submitError" class="composer-error">{{ submitError }}</p>
      </footer>
    </section>

    <aside v-if="!executionCollapsed" class="execution-sidebar" aria-label="执行轨迹">
      <header class="execution-sidebar-header">
        <div><span>AGENT TRACE</span><strong>执行轨迹</strong></div>
        <div class="execution-header-actions">
          <small>{{ processProgressText }}</small>
          <button
            class="sidebar-collapse-button"
            type="button"
            aria-label="折叠执行轨迹"
            title="折叠执行轨迹"
            :aria-expanded="true"
            @click="toggleExecution"
          >›</button>
        </div>
      </header>

      <template v-if="activeRun">
        <section class="process-ledger">
          <div v-if="processSteps.length" class="process-list">
            <article
              v-for="step in processSteps"
              :key="step.id"
              class="process-step"
              :class="[
                'is-' + step.status,
                { 'is-waiting-approval': step.status === 'active' && activeRun.status === 'waiting_approval' },
              ]"
            >
              <span class="process-marker" aria-hidden="true">{{ step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : '' }}</span>
              <div>
                <header>
                  <strong>{{ step.title }}</strong>
                  <span class="process-step-status">
                    <b v-if="step.status === 'active'">
                      {{ activeRun.status === 'waiting_approval' ? '等待确认' : '进行中' }} · {{ processStepElapsed(step) }}
                    </b>
                    <time v-else>{{ formatTime(step.occurredAt) }}</time>
                  </span>
                </header>
                <p>{{ step.detail }}</p>
                <small v-if="step.meta">{{ step.meta }}</small>
              </div>
            </article>
          </div>
          <p v-else class="empty-process">正在等待第一个执行事件…</p>
          <details class="technical-details">
            <summary>查看技术详情 · {{ visibleProgressEvents.length }} 条事件</summary>
            <div class="embedded-timeline live-timeline">
              <article
                v-for="(event, index) in visibleProgressEvents"
                :key="event.sequence"
                :class="{ current: index === visibleProgressEvents.length - 1 }"
              >
                <i></i>
                <time>{{ formatTime(event.occurred_at) }}</time>
                <div><strong>{{ eventStage(event) }}</strong><p>{{ eventMessage(event) }}</p></div>
              </article>
            </div>
          </details>
        </section>
      </template>
      <div v-else class="execution-sidebar-empty">
        <span>◎</span>
        <p>发送问题后，这里会实时展示 Agent 的执行步骤。</p>
      </div>
    </aside>

  </main>
</template>
