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

type ResponseMode = 'fast' | 'expert'

type RunSummary = {
  id: string
  status: string
  question: string
  agent_key?: string
  response_mode?: ResponseMode
  created_at?: string
  updated_at?: string
  result?: RunResult | null
  error?: string | null
  events?: RunEvent[]
  retry_of_run_id?: string | null
  attachments?: AttachmentSummary[]
  artifacts?: RunArtifact[]
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
  response_mode: ResponseMode
}

type RunArtifact = {
  id: string
  run_id: string
  kind: string
  title: string
  content?: {
    attachments?: AttachmentSummary[]
    file?: {
      filename: string
      media_type: string
      size: number
      sha256: string
      download_url: string
    }
    preview?: {
      kind: string
      sheet_name?: string
      headers?: string[]
      rows?: Array<Array<string | number | boolean | null>>
      row_count?: number
      text?: string
      title?: string
      sections?: Array<{
        heading?: string
        paragraphs?: string[]
        bullets?: string[]
        table?: {
          headers?: string[]
          rows?: Array<Array<string | number | boolean | null>>
        }
      }>
    }
  }
  created_at: string
}

type RunResult = {
  answer?: string
  reasoning?: string
  response_mode?: ResponseMode
  execution_mode?: string
  analysis_result?: AttendanceSummary
}

type AttendanceSummary = {
  employee_count: number
  total_attendance_days: number
  total_late_count: number
  total_missing_punch_count: number
  total_deduction: number
  employees: AttendanceEmployee[]
  focus_employees?: AttendanceEmployee[]
  warnings: string[]
}

type AttendanceExceptionType = 'late' | 'early_leave' | 'missing'

type AttendanceExceptionEvent = {
  punch_type: string
  expected_time: string
  actual_time: string
  status: string
}

type AttendanceExceptionDetail = {
  date: string
  events: AttendanceExceptionEvent[]
  machine_punches: string[]
  reason: string
}

type AttendanceEmployee = {
  employee_key?: string
  name: string
  attendance_days: number
  late_count: number
  early_leave_count?: number
  missing_punch_count: number
  deduction: number
  correction_count?: number
  attention_reasons?: string[]
  exception_details?: Partial<Record<AttendanceExceptionType, AttendanceExceptionDetail[]>>
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

type SourceCitation = {
  id: string
  citation_number: number
  title: string
  url: string
  domain: string
  snippet: string
  provider: string
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

type UploadStage = 'uploading' | 'processing'

// 页面状态按“可选 Agent、持久化会话、当前运行”三类组织，避免相互覆盖。
const agents = ref<AgentInfo[]>([])
const conversations = ref<Conversation[]>([])
const messages = ref<Message[]>([])
const runs = ref<RunSummary[]>([])
const events = ref<RunEvent[]>([])
const toolRequests = ref<ToolRequest[]>([])
const selectedConversationId = ref('')
const selectedAgent = ref('')
const RESPONSE_MODE_KEY = 'fuecn-response-mode'
const responseMode = ref<ResponseMode>(
  typeof window !== 'undefined' && window.localStorage.getItem(RESPONSE_MODE_KEY) === 'expert'
    ? 'expert'
    : 'fast',
)
const question = ref('')
const tableText = ref('')
const tableHtml = ref('')
const attachments = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
const submitError = ref('')
const retryError = ref('')
const isSubmitting = ref(false)
const pendingUploadFiles = ref<File[]>([])
const isRetrying = ref(false)
const isStopping = ref(false)
const editingRunId = ref('')
const editingQuestion = ref('')
const editError = ref('')
const copiedRunId = ref('')
const copiedAnswerRunId = ref('')
const approvalKey = ref('')
const approvalError = ref('')
const approvalBusy = ref(false)
const activeRunId = ref('')
const activeRun = ref<RunSummary | null>(null)
const eventSource = ref<EventSource | null>(null)
const messageScroll = ref<HTMLElement | null>(null)
const reasoningScroll = ref<HTMLElement | null>(null)
const reasoningAutoFollow = ref(true)
const typedAnswer = ref('')
const answerTarget = ref('')
const renderedAnswer = ref('')
const isTyping = ref(false)
const answerStreamCompleted = ref(false)
const answerPlaybackCompleted = ref(false)
const reasoningText = ref('')
const reasoningTarget = ref('')
const renderedReasoning = ref('')
const isReasoning = ref(false)
const reasoningExpanded = ref(true)
const reasoningStartedAt = ref<number | null>(null)
const reasoningEndedAt = ref<number | null>(null)
const clockNow = ref(Date.now())
const isNearMessageBottom = ref(true)
const SESSIONS_COLLAPSED_KEY = 'fuecn-sessions-collapsed'
const EXECUTION_COLLAPSED_KEY = 'fuecn-execution-collapsed'
const EXECUTION_WIDTH_KEY = 'fuecn-execution-width'
const MIN_EXECUTION_WIDTH = 300
const MAX_EXECUTION_WIDTH = 720
const MIN_CHAT_WIDTH = 420
const compactSidebarDefault = typeof window !== 'undefined'
  && window.matchMedia('(max-width: 1020px)').matches
const sessionsCollapsed = ref(readCollapsedPreference(SESSIONS_COLLAPSED_KEY, compactSidebarDefault))
const executionCollapsed = ref(readCollapsedPreference(EXECUTION_COLLAPSED_KEY, compactSidebarDefault))
const executionWidth = ref(readExecutionWidth())
const isExecutionResizing = ref(false)
const sidebarMode = ref<'trace' | 'preview' | 'sources'>('trace')
const selectedArtifact = ref<RunArtifact | null>(null)
const sourcePanelCitations = ref<SourceCitation[]>([])
const selectedCitation = ref<SourceCitation | null>(null)
const TYPEWRITER_INTERVAL_MS = 20
const REASONING_TYPEWRITER_INTERVAL_MS = 18
const FIRST_ANSWER_DELAY_MS = 150
const MARKDOWN_RENDER_INTERVAL_MS = 42
let clockTimer: number | undefined
let typewriterTimer: number | undefined
let reasoningTypewriterTimer: number | undefined
let executionResizeStartX = 0
let executionResizeStartWidth = 0
let markdownRenderTimer: number | undefined
let reasoningMarkdownRenderTimer: number | undefined
let typewriterScrollTick = 0
let reasoningScrollTick = 0
let eventQueue: Promise<void> = Promise.resolve()

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
const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const label = tokens[index + 1]?.type === 'text'
    ? tokens[index + 1].content.trim()
    : ''
  if (/^\d{1,3}$/.test(label)) {
    tokens[index].attrJoin('class', 'citation-link')
    tokens[index].attrSet('aria-label', `查看来源 ${label}`)
  }
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options)
}
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
const hasAttendanceData = computed(() => attachments.value.some((f) => f.name.includes('考勤')||f.name.includes('打卡记录')))
const pasteRowCount = computed(() => tableText.value.split(/\r?\n/).filter((line) => line.trim()).length)
const isRunActive = computed(() => ['pending', 'running', 'waiting_approval'].includes(
  activeRun.value?.status || '',
))
const isResponseActive = computed(() => (
  isRunActive.value || isReasoning.value || isTyping.value
))
const canSubmit = computed(() => Boolean(question.value.trim())
  && !isSubmitting.value
  && !isResponseActive.value)
const visibleProgressEvents = computed(() => events.value.filter((event) => (
  event.type !== 'message.delta'
  && event.type !== 'message.reasoning.delta'
  && event.type !== 'citation.created'
)))
const processSteps = computed(() => buildProcessSteps(visibleProgressEvents.value, activeRun.value?.status || ''))
const processProgressText = computed(() => {
  const completed = processSteps.value.filter((step) => step.status === 'done').length
  return processSteps.value.length ? `${completed}/${processSteps.value.length} 已完成` : '准备执行'
})
const showActiveArtifacts = computed(() => {
  const status = activeRun.value?.status || ''
  if (status === 'failed' || status === 'cancelled') return true
  return status === 'completed' && answerPlaybackCompleted.value
})
const activeProcessStep = computed(() => (
  [...processSteps.value].reverse().find((step) => step.status === 'active')
))
const isPreparingResponse = computed(() => (
  ['pending', 'running'].includes(activeRun.value?.status || '')
  && !reasoningText.value
  && !isReasoning.value
  && !typedAnswer.value
  && !isTyping.value
))
const preparingResponseTitle = computed(() => (
  activeProcessStep.value?.title
  || (runResponseMode(activeRun.value) === 'expert' ? '正在分析目标并制定计划' : '正在快速处理你的请求')
))
const preparingResponseDetail = computed(() => (
  activeProcessStep.value?.detail
  || (runResponseMode(activeRun.value) === 'expert' ? '将按步骤执行并验证结果' : '正在理解问题并选择最直接的处理方式')
))
const selectedArtifactFile = computed(() => selectedArtifact.value?.content?.file)
const selectedArtifactPreview = computed(() => selectedArtifact.value?.content?.preview)
const activeCitations = computed(() => citationsFromEvents(events.value))
const sidebarEyebrow = computed(() => ({
  trace: 'AGENT TRACE',
  preview: 'FILE PREVIEW',
  sources: 'WEB SOURCES',
}[sidebarMode.value]))
const sidebarTitle = computed(() => ({
  trace: '执行轨迹',
  preview: '文件预览',
  sources: '引用网页',
}[sidebarMode.value]))
const reasoningElapsedText = computed(() => formatElapsed(
  Math.max(
    0,
    (reasoningEndedAt.value || clockNow.value) - (reasoningStartedAt.value || clockNow.value),
  ),
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
const focusEmployees = computed(() => {
  const rows = summary.value?.focus_employees ?? summary.value?.employees ?? []
  return rows.filter((row) => (
    Number(row.missing_punch_count || 0) > 0
    || Number(row.late_count || 0) > 0
    || Number(row.early_leave_count || 0) > 0
  ))
})
const employeeAttentionText = (row: AttendanceEmployee) => {
  if (row.attention_reasons?.length) return row.attention_reasons.join('、')
  const reasons: string[] = []
  if (row.missing_punch_count) reasons.push(`缺卡${row.missing_punch_count}次`)
  if (row.late_count) reasons.push(`迟到${row.late_count}次`)
  if (row.early_leave_count) reasons.push(`早退${row.early_leave_count}次`)
  if (row.correction_count) reasons.push(`考勤修正${row.correction_count}条`)
  return reasons.join('、')
}
const exceptionMetrics = [
  { type: 'late', countKey: 'late_count', label: '迟到' },
  { type: 'early_leave', countKey: 'early_leave_count', label: '早退' },
  { type: 'missing', countKey: 'missing_punch_count', label: '缺卡' },
] as const
type ExceptionMetric = (typeof exceptionMetrics)[number]
type ActiveExceptionTip = {
  key: string
  row: AttendanceEmployee
  metric: ExceptionMetric
  top: number
  left: number
}
const activeExceptionTip = ref<ActiveExceptionTip | null>(null)
const exceptionTipPanel = ref<HTMLElement | null>(null)
const employeeExceptionDetails = (
  row: AttendanceEmployee,
  type: AttendanceExceptionType,
) => row.exception_details?.[type] || []
const activeExceptionDetails = computed(() => {
  const tip = activeExceptionTip.value
  return tip ? employeeExceptionDetails(tip.row, tip.metric.type) : []
})

async function toggleExceptionTip(
  event: MouseEvent,
  row: AttendanceEmployee,
  metric: ExceptionMetric,
) {
  event.stopPropagation()
  const key = `${row.employee_key || row.name}:${metric.type}`
  if (activeExceptionTip.value?.key === key) {
    activeExceptionTip.value = null
    return
  }
  const trigger = event.currentTarget as HTMLElement
  const rect = trigger.getBoundingClientRect()
  const panelWidth = Math.min(430, window.innerWidth - 24)
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - panelWidth - 12))
  activeExceptionTip.value = { key, row, metric, top: rect.bottom + 8, left }
  await nextTick()
  const currentTip = activeExceptionTip.value
  if (!currentTip || currentTip.key !== key) return
  const panelHeight = exceptionTipPanel.value?.getBoundingClientRect().height || 0
  if (rect.bottom + 8 + panelHeight > window.innerHeight - 12) {
    activeExceptionTip.value = {
      ...currentTip,
      top: Math.max(12, rect.top - panelHeight - 8),
    }
  }
}

function closeExceptionTip(event?: Event) {
  if (
    event?.target instanceof Element
    && event.target.closest('.exception-tip-trigger')
  ) return
  if (
    event?.target instanceof Node
    && exceptionTipPanel.value?.contains(event.target)
  ) return
  activeExceptionTip.value = null
}

function handleExceptionTipKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeExceptionTip()
}
const runStatusText = computed(() => {
  if (isLocalUploadRun(activeRun.value)) {
    return activeRun.value?.status === 'failed' ? '附件处理失败' : '正在处理附件'
  }
  const labels: Record<string, string> = {
    pending: '等待执行',
    running: '执行中',
    waiting_approval: '等待审批',
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已停止',
  }
  return labels[activeRun.value?.status || ''] || '空闲'
})

// Agent 与会话列表互不依赖，初始化时并行加载以缩短首屏等待。
onMounted(async () => {
  document.addEventListener('pointerdown', closeExceptionTip)
  document.addEventListener('keydown', handleExceptionTipKeydown)
  window.addEventListener('resize', closeExceptionTip)
  window.addEventListener('scroll', closeExceptionTip, true)
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

function openArtifactPreview(artifact: RunArtifact): void {
  selectedArtifact.value = artifact
  sidebarMode.value = 'preview'
  executionCollapsed.value = false
  window.localStorage.setItem(EXECUTION_COLLAPSED_KEY, 'false')
}

function readExecutionWidth(): number {
  if (typeof window === 'undefined') return 340
  const rawStored = window.localStorage.getItem(EXECUTION_WIDTH_KEY)
  if (rawStored === null) return 340
  const stored = Number(rawStored)
  return Number.isFinite(stored)
    ? Math.min(MAX_EXECUTION_WIDTH, Math.max(MIN_EXECUTION_WIDTH, stored))
    : 340
}

function maxExecutionWidth(): number {
  if (typeof window === 'undefined') return MAX_EXECUTION_WIDTH
  const sessionsWidth = sessionsCollapsed.value
    ? 0
    : window.matchMedia('(max-width: 1020px)').matches ? 220 : 252
  return Math.max(
    MIN_EXECUTION_WIDTH,
    Math.min(MAX_EXECUTION_WIDTH, window.innerWidth - sessionsWidth - MIN_CHAT_WIDTH),
  )
}

function setExecutionWidth(value: number, persist = false): void {
  executionWidth.value = Math.min(maxExecutionWidth(), Math.max(MIN_EXECUTION_WIDTH, value))
  if (persist) {
    window.localStorage.setItem(EXECUTION_WIDTH_KEY, String(Math.round(executionWidth.value)))
  }
}

function startExecutionResize(event: PointerEvent): void {
  if (window.matchMedia('(max-width: 760px)').matches) return
  event.preventDefault()
  executionResizeStartX = event.clientX
  executionResizeStartWidth = executionWidth.value
  isExecutionResizing.value = true
  window.addEventListener('pointermove', handleExecutionResize)
  window.addEventListener('pointerup', stopExecutionResize)
  window.addEventListener('pointercancel', stopExecutionResize)
}

function handleExecutionResize(event: PointerEvent): void {
  if (!isExecutionResizing.value) return
  setExecutionWidth(executionResizeStartWidth + executionResizeStartX - event.clientX)
}

function stopExecutionResize(): void {
  if (!isExecutionResizing.value) return
  isExecutionResizing.value = false
  window.removeEventListener('pointermove', handleExecutionResize)
  window.removeEventListener('pointerup', stopExecutionResize)
  window.removeEventListener('pointercancel', stopExecutionResize)
  window.localStorage.setItem(EXECUTION_WIDTH_KEY, String(Math.round(executionWidth.value)))
}

function resizeExecutionBy(delta: number): void {
  setExecutionWidth(executionWidth.value + delta, true)
}

function openCitationSources(
  citations: SourceCitation[],
  selectedUrl = '',
): void {
  if (!citations.length) return
  sourcePanelCitations.value = citations
  selectedCitation.value = citations.find((citation) => sameUrl(citation.url, selectedUrl))
    || citations[0]
    || null
  sidebarMode.value = 'sources'
  executionCollapsed.value = false
  window.localStorage.setItem(EXECUTION_COLLAPSED_KEY, 'false')
}

function openRunCitations(run: RunSummary): void {
  openCitationSources(runCitations(run))
}

function handleCitationClick(event: MouseEvent, run?: RunSummary): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest<HTMLAnchorElement>('a.citation-link')
  if (!anchor) return
  const citations = run ? runCitations(run) : activeCitations.value
  const citation = citations.find((item) => sameUrl(item.url, anchor.href))
  if (!citation) return
  event.preventDefault()
  openCitationSources(citations, citation.url)
}

function selectCitation(citation: SourceCitation): void {
  selectedCitation.value = citation
}

function showExecutionTrace(): void {
  sidebarMode.value = 'trace'
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeExceptionTip)
  document.removeEventListener('keydown', handleExceptionTipKeydown)
  window.removeEventListener('resize', closeExceptionTip)
  window.removeEventListener('scroll', closeExceptionTip, true)
  closeEventSource()
  stopAnswerTimers()
  stopReasoningTimers()
  stopExecutionResize()
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

async function createConversationForSubmission() {
  const conversation = await apiPost<Conversation>('/api/conversations', { title: '新的会话' })
  conversations.value = [conversation, ...conversations.value]
  selectedConversationId.value = conversation.id
  messages.value = []
  runs.value = []
}

async function selectConversation(id: string) {
  // 切换会话前关闭旧 SSE，防止旧运行事件写入新会话界面。
  closeExceptionTip()
  selectedConversationId.value = id
  closeEventSource()
  events.value = []
  toolRequests.value = []
  approvalError.value = ''
  retryError.value = ''
  pendingUploadFiles.value = []
  isStopping.value = false
  cancelEditing()
  activeRun.value = null
  selectedArtifact.value = null
  sourcePanelCitations.value = []
  selectedCitation.value = null
  sidebarMode.value = 'trace'
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
    pendingUploadFiles.value = []
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
  if (isTable) {
    event.preventDefault()
    attachments.value = []
    tableHtml.value = html
    tableText.value = text
    submitError.value = ''
    return
  }

  const target = event.target
  if (!(target instanceof HTMLTextAreaElement) || !text) return
  event.preventDefault()
  const normalizedText = normalizePastedText(text)
  const selectionStart = target.selectionStart ?? question.value.length
  const selectionEnd = target.selectionEnd ?? selectionStart
  question.value = question.value.slice(0, selectionStart)
    + normalizedText
    + question.value.slice(selectionEnd)
  const caret = selectionStart + normalizedText.length
  void nextTick(() => {
    target.focus()
    target.setSelectionRange(caret, caret)
  })
}

function normalizePastedText(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f\u3000]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
  if (looksLikeCodePaste(normalized)) return normalized
  return normalized
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

function looksLikeCodePaste(value: string): boolean {
  if (/\x60{3}/.test(value)) return true
  const lines = value.split('\n').filter((line) => line.trim())
  if (lines.length < 2) return false
  const codeSignals = lines.filter((line) => (
    /^\s*(?:def|class|function|const|let|var|import|from|export|interface|type|SELECT|WITH)\b/i.test(line)
    || /^\s*[}\])]?[;,]?$/.test(line)
    || /^\s*[\w.-]+:\s+\S+/.test(line)
    || /[{};]|=>|===|:=/.test(line)
  )).length
  return codeSignals >= 2
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
  if (isSubmitting.value) return
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length) addAttachments(files)
}

function addAttachments(files: File[]) {
  if (isSubmitting.value) return
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
  if (isSubmitting.value) return
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
  if (isSubmitting.value) return
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

function selectResponseMode(mode: ResponseMode) {
  if (isResponseActive.value || isSubmitting.value) return
  responseMode.value = mode
  window.localStorage.setItem(RESPONSE_MODE_KEY, mode)
}

function runResponseMode(run: RunSummary | null | undefined): ResponseMode {
  if (run?.response_mode === 'expert' || run?.response_mode === 'fast') return run.response_mode
  if (run?.result?.response_mode === 'expert' || run?.result?.response_mode === 'fast') {
    return run.result.response_mode
  }
  if (run?.result?.execution_mode === 'planner') return 'expert'
  return responseMode.value
}

function isLocalUploadRun(run: RunSummary | null | undefined): boolean {
  return Boolean(run?.id.startsWith('local-upload-'))
}

function localUploadEvent(
  runId: string,
  sequence: number,
  type: string,
  stage: string,
  message: string,
): RunEvent {
  return {
    event_id: `local-${runId}-${sequence}`,
    run_id: runId,
    sequence,
    type,
    occurred_at: new Date().toISOString(),
    payload: { stage, message },
  }
}

function updateLocalUploadStage(
  runId: string,
  fileCount: number,
  totalBytes: number,
  percent: number,
  stage: UploadStage,
) {
  if (activeRun.value?.id !== runId) return
  if (stage === 'uploading') {
    const uploadedBytes = Math.round(totalBytes * percent / 100)
    const message = `正在上传 ${fileCount} 个附件 · ${percent}% · ${formatFileSize(uploadedBytes)} / ${formatFileSize(totalBytes)}`
    const current = events.value.find((event) => event.run_id === runId && event.payload.stage === 'upload_files')
    if (current) current.payload.message = message
    return
  }
  events.value = [
    localUploadEvent(runId, 1, 'tool.started', 'prepare_upload', `正在准备 ${fileCount} 个附件`),
    localUploadEvent(runId, 2, 'tool.completed', 'prepare_upload', '附件准备完成'),
    localUploadEvent(runId, 3, 'tool.started', 'upload_files', `正在上传 ${fileCount} 个附件`),
    localUploadEvent(runId, 4, 'tool.completed', 'upload_files', '附件上传完成'),
    localUploadEvent(runId, 5, 'tool.started', 'parse_attachments', '文件已传输完成，正在读取并解析附件内容'),
  ]
}

async function submitRun() {
  // 普通问题不要求表格；只要问题非空且当前没有提交任务即可发送。
  if (!canSubmit.value) return
  isSubmitting.value = true
  closeExceptionTip()
  submitError.value = ''
  const submittedQuestion = question.value.trim()
  const submittedFiles = [...attachments.value]
  const requestedAgent = selectedAgent.value
  const submittedMode =responseMode.value
  const totalUploadBytes = submittedFiles.reduce((total, file) => total + file.size, 0)
  let localUploadRunId = ''
  try {
    if (submittedFiles.length) {
      localUploadRunId = `local-upload-${crypto.randomUUID()}`
      pendingUploadFiles.value = submittedFiles
      closeEventSource()
      activeRunId.value = localUploadRunId
      activeRun.value = {
        id: localUploadRunId,
        status: 'pending',
        question: submittedQuestion,
        agent_key: requestedAgent || undefined,
        response_mode: submittedMode,
        created_at: new Date().toISOString(),
        events: [],
        attachments: submittedFiles.map(summarizeFile),
      }
      selectedArtifact.value = null
      sourcePanelCitations.value = []
      selectedCitation.value = null
      sidebarMode.value = 'trace'
      events.value = [
        localUploadEvent(
          localUploadRunId,
          1,
          'tool.started',
          'prepare_upload',
          `正在准备 ${submittedFiles.length} 个附件并创建任务上下文`,
        ),
      ]
      toolRequests.value = []
      approvalError.value = ''
      resetTypewriter()
      question.value = ''
      tableText.value = ''
      tableHtml.value = ''
      attachments.value = []
      await scrollMessagesToBottom(true)
    }
    if (!selectedConversationId.value) {
      await createConversationForSubmission()
    }

    let response: RunCreateResult
    if (submittedFiles.length) {
      events.value = [
        localUploadEvent(localUploadRunId, 1, 'tool.started', 'prepare_upload', `正在准备 ${submittedFiles.length} 个附件`),
        localUploadEvent(localUploadRunId, 2, 'tool.completed', 'prepare_upload', '附件准备完成'),
        localUploadEvent(localUploadRunId, 3, 'tool.started', 'upload_files', `正在上传 ${submittedFiles.length} 个附件 · 0%`),
      ]
      const form = new FormData()
      form.append('question', submittedQuestion)
      form.append('response_mode', submittedMode)
      if (requestedAgent) form.append('agent_key', requestedAgent)
      for (const file of submittedFiles) form.append('files', file, file.name)
      response = await apiPostForm<RunCreateResult>(
        `/api/conversations/${selectedConversationId.value}/runs/files`,
        form,
        {},
        (percent, stage) => {
          updateLocalUploadStage(
            localUploadRunId,
            submittedFiles.length,
            totalUploadBytes,
            percent,
            stage,
          )
        },
      )
    } else {
      response = await apiPost<RunCreateResult>(
        `/api/conversations/${selectedConversationId.value}/runs`,
        {
          question: submittedQuestion,
          response_mode: submittedMode,
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
    selectedArtifact.value = null
    sourcePanelCitations.value = []
    selectedCitation.value = null
    sidebarMode.value = 'trace'
    const pendingRun: RunSummary = {
      id: response.run_id,
      status: 'pending',
      question: submittedQuestion,
      agent_key: requestedAgent || undefined,
      response_mode: response.response_mode || submittedMode,
      created_at: new Date().toISOString(),
      events: [],
      attachments: submittedFiles.map(summarizeFile),
    }
    activeRun.value = pendingRun
    runs.value = [pendingRun, ...runs.value]
    if (!localUploadRunId) resetTypewriter()
    // 先乐观显示用户消息，后台持久化版本会在下次刷新会话时替换它。
    messages.value.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: submittedQuestion,
      created_at: new Date().toISOString(),
      extra: { run_id: response.run_id },
    })
    events.value = []
    pendingUploadFiles.value = []
    toolRequests.value = []
    approvalError.value = ''
    if (!localUploadRunId) {
      question.value = ''
      clearTable()
    }
    connectEvents(response.run_id)
    await scrollMessagesToBottom(true)
  } catch (error) {
    const detail = error instanceof Error ? error.message : '提交失败，请稍后重试。'
    if (localUploadRunId && activeRun.value?.id === localUploadRunId) {
      activeRun.value.status = 'failed'
      activeRun.value.error = detail
      retryError.value = ''
    } else {
      submitError.value = detail
    }
  } finally {
    isSubmitting.value = false
  }
}

async function rerunRun(sourceRun: RunSummary, revisedQuestion?: string) {
  if (isRetrying.value || isResponseActive.value) return
  const submittedQuestion = (revisedQuestion ?? sourceRun.question).trim()
  if (!submittedQuestion) {
    editError.value = '问题内容不能为空。'
    return
  }
  isRetrying.value = true
  retryError.value = ''
  editError.value = ''
  try {
    const response = await apiPost<RunCreateResult>(
      `/api/runs/${sourceRun.id}/rerun`,
      { question: submittedQuestion, response_mode: runResponseMode(sourceRun) },
    )
    const currentConversation = conversations.value.find(
      (conversation) => conversation.id === response.conversation_id,
    )
    if (currentConversation) currentConversation.title = response.conversation_title
    activeRunId.value = response.run_id
    selectedArtifact.value = null
    sourcePanelCitations.value = []
    selectedCitation.value = null
    sidebarMode.value = 'trace'
    const pendingRun: RunSummary = {
      id: response.run_id,
      status: 'pending',
      question: submittedQuestion,
      agent_key: sourceRun.agent_key,
      response_mode: response.response_mode || runResponseMode(sourceRun),
      created_at: new Date().toISOString(),
      events: [],
      attachments: sourceRun.attachments || [],
    }
    activeRun.value = pendingRun
    runs.value = [pendingRun, ...runs.value]
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
    cancelEditing()
    resetTypewriter()
    connectEvents(response.run_id)
    await scrollMessagesToBottom(true)
  } catch (error) {
    const message = error instanceof Error ? error.message : '重新生成失败，请稍后重试。'
    if (editingRunId.value === sourceRun.id) editError.value = message
    else retryError.value = message
  } finally {
    isRetrying.value = false
  }
}

async function cancelActiveRun() {
  const run = activeRun.value
  if (!run || !isResponseActive.value || isStopping.value) return
  const shouldCancelBackend = isRunActive.value
  isStopping.value = true
  submitError.value = ''

  // 点击后立即冻结可见内容；后端取消不应成为停止按钮的视觉延迟。
  freezeCurrentAnswer()
  freezeCurrentReasoning()
  closeEventSource()

  if (!shouldCancelBackend) {
    isStopping.value = false
    return
  }

  try {
    await apiPost(`/api/runs/${run.id}/cancel`, {})
    if (activeRun.value?.id === run.id) activeRun.value.status = 'cancelled'
    await refreshRun(run.id, false, true)
    await Promise.all([
      loadConversations(),
      refreshConversationContent(selectedConversationId.value),
    ])
  } catch (error) {
    try {
      // 请求期间任务可能已经自然完成；保留用户刚刚停止的位置，只刷新真实状态。
      await refreshRun(run.id, false, true)
      if (isRunActive.value) {
        submitError.value = error instanceof Error ? error.message : '停止生成失败，请稍后重试。'
        connectEvents(run.id)
      }
    } catch {
      submitError.value = error instanceof Error ? error.message : '停止生成失败，请稍后重试。'
      connectEvents(run.id)
    }
  } finally {
    isStopping.value = false
  }
}

function freezeCurrentAnswer() {
  stopAnswerTimers()
  answerTarget.value = typedAnswer.value
  answerStreamCompleted.value = true
  answerPlaybackCompleted.value = true
  isTyping.value = false
  scheduleMarkdownRender(true)
}

function isTerminalRun(run: RunSummary): boolean {
  return ['completed', 'failed', 'cancelled'].includes(run.status)
}

function startEditing(run: RunSummary) {
  editingRunId.value = run.id
  editingQuestion.value = run.question
  editError.value = ''
}

function cancelEditing() {
  editingRunId.value = ''
  editingQuestion.value = ''
  editError.value = ''
}

async function submitEditedRun(run: RunSummary) {
  await rerunRun(run, editingQuestion.value)
}

function handleEditKeydown(event: KeyboardEvent, run: RunSummary) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!isRetrying.value) void submitEditedRun(run)
}

async function copyRunQuestion(run: RunSummary) {
  try {
    await navigator.clipboard.writeText(run.question)
    copiedRunId.value = run.id
    window.setTimeout(() => {
      if (copiedRunId.value === run.id) copiedRunId.value = ''
    }, 1500)
  } catch {
    window.alert('复制失败，请手动选择问题文本。')
  }
}

async function retryRun(sourceRun: RunSummary | null = activeRun.value) {
  if (!sourceRun || !['failed', 'cancelled'].includes(sourceRun.status) || isRetrying.value || isResponseActive.value) return
  isRetrying.value = true
  retryError.value = ''
  try {
    const response = await apiPost<RunCreateResult>(
      `/api/runs/${sourceRun.id}/retry`,
      { response_mode: runResponseMode(sourceRun) },
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
      response_mode: response.response_mode || runResponseMode(sourceRun),
      created_at: new Date().toISOString(),
      events: [],
      retry_of_run_id: sourceRun.id,
      attachments: sourceRun.attachments || [],
    }
    activeRun.value = pendingRun
    runs.value = [pendingRun, ...runs.value]
    // 新运行使用独立事件序列；旧运行通过 retry_of_run_id 保留并归入同一轮。
    events.value = []
    toolRequests.value = []
    approvalError.value = ''
    resetTypewriter()
    connectEvents(response.run_id)
    await scrollMessagesToBottom(true)
  } catch (error) {
    const fallback = sourceRun.status === 'cancelled' ? '重新开始失败，请稍后重试。' : '重新执行失败，请稍后重试。'
    retryError.value = error instanceof Error ? error.message : fallback
  } finally {
    isRetrying.value = false
  }
}

async function retryFailedRun() {
  const run = activeRun.value
  if (!isLocalUploadRun(run)) {
    await retryRun(run)
    return
  }
  if (!run || !pendingUploadFiles.value.length) {
    retryError.value = '原始附件已不可用，请重新选择文件后发送。'
    return
  }
  question.value = run.question
  attachments.value = [...pendingUploadFiles.value]
  selectedAgent.value = run.agent_key || ''
  responseMode.value = runResponseMode(run)
  activeRunId.value = ''
  activeRun.value = null
  events.value = []
  retryError.value = ''
  await nextTick()
  await submitRun()
}
function connectEvents(runId: string) {
  // 一个页面只保留一个活动连接，避免重复订阅和事件重复渲染。
  closeEventSource()
  const source = new EventSource(`/api/runs/${runId}/events`)
  eventSource.value = source
  source.onmessage = (message) => enqueueRunEvent(message.data)
  // 服务端发送了具名 SSE 事件，必须逐类监听；onmessage 仅兼容默认事件。
  const names = [
    'run.started',
    'run.progress',
    'message.reasoning.delta',
    'message.delta',
    'citation.created',
    'artifact.created',
    'tool.started',
    'tool.completed',
    'approval.required',
    'approval.resolved',
    'input.required',
    'run.completed',
    'run.failed',
    'run.cancelled',
  ]
  for (const name of names) {
    source.addEventListener(name, (message) => enqueueRunEvent((message as MessageEvent).data))
  }
}

function enqueueRunEvent(raw: string) {
  // EventSource 回调不能 await；显式排队可保证完成事件不会越过前面的文本分片。
  eventQueue = eventQueue
    .then(() => appendEvent(raw))
    .catch((error) => {
      console.error('处理运行事件失败', error)
    })
}

async function appendEvent(raw: string) {
  const event = JSON.parse(raw) as RunEvent
  if (event.run_id !== activeRunId.value) return
  // SSE 重连可能补发历史事件；重复终态事件也不能再次刷新并打断播放。
  const isNewEvent = !events.value.some((item) => item.sequence === event.sequence)
  if (isNewEvent) {
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
      const content = String(event.payload.content || '')
      if (String(event.payload.stage || '') === 'final') {
        finishReasoning(event.occurred_at)
        enqueueAnswerChunk(content)
      } else {
        // 兼容旧后端：非 final 的普通文本仍属于多轮思考，不能启动最终答复。
        enqueueReasoningChunk(content, event.occurred_at)
      }
    }
    if (event.type === 'message.reasoning.delta') {
      enqueueReasoningChunk(String(event.payload.content || ''), event.occurred_at)
    }
    if (event.type === 'artifact.created') {
      const artifact = event.payload.artifact as RunArtifact | undefined
      if (artifact?.id && activeRun.value) {
        activeRun.value.artifacts = mergeRunArtifacts(activeRun.value.artifacts || [], [artifact])
      }
      const run = runs.value.find((item) => item.id === event.run_id)
      if (artifact?.id && run) {
        run.artifacts = mergeRunArtifacts(run.artifacts || [], [artifact])
      }
    }
  }
  if (!isNewEvent) return
  await scrollMessagesToBottom()
  if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
    const conversationId = selectedConversationId.value
    const wasCancelled = event.type === 'run.cancelled'
    if (activeRun.value) activeRun.value.status = wasCancelled ? 'cancelled' : activeRun.value.status
    if (wasCancelled) {
      freezeCurrentAnswer()
      freezeCurrentReasoning()
    } else {
      answerStreamCompleted.value = true
      completeAnswerPlayback()
      finishReasoning(event.occurred_at)
    }
    closeEventSource()
    await refreshRun(event.run_id, !wasCancelled, wasCancelled)
    await Promise.all([loadConversations(), refreshConversationContent(conversationId)])
    if (wasCancelled) isStopping.value = false
  }
}

async function refreshRun(runId: string, animateAnswer = true, preservePartialAnswer = false) {
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
  const liveArtifacts = activeRun.value?.id === runId ? activeRun.value.artifacts || [] : []
  detail.run.artifacts = mergeRunArtifacts(
    liveArtifacts,
    (detail.artifacts || []).filter((artifact) => artifact.kind === 'generated-file'),
  )
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
  const persistedAnswer = String(detail.run.result?.answer || '')
  const recoveredAnswer = persistedAnswer || answerFromEvents(events.value)
  if (preservePartialAnswer && typedAnswer.value) {
    freezeCurrentAnswer()
  } else {
    setAnswerTarget(recoveredAnswer, animateAnswer)
  }
  restoreReasoning(detail.run, events.value, animateAnswer)
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
  const firstChunk = !answerTarget.value && !typedAnswer.value
  // 兼容真实增量事件和旧版累计全文事件，始终只维护一份 Markdown 源文本。
  answerTarget.value = content.startsWith(answerTarget.value)
    ? content
    : `${answerTarget.value}${content}`
  answerStreamCompleted.value = false
  answerPlaybackCompleted.value = false
  startAnswerPlaybackIfReady(firstChunk ? FIRST_ANSWER_DELAY_MS : 0)
}

function startAnswerPlaybackIfReady(delay = TYPEWRITER_INTERVAL_MS) {
  if (isReasoning.value || reasoningText.value.length < reasoningTarget.value.length) return
  if (typedAnswer.value.length >= answerTarget.value.length) {
    completeAnswerPlayback()
    return
  }
  isTyping.value = true
  scheduleTypewriter(delay)
}

function scheduleTypewriter(delay = TYPEWRITER_INTERVAL_MS) {
  if (typewriterTimer !== undefined) return
  typewriterTimer = window.setTimeout(runTypewriterStep, delay)
}

function runTypewriterStep() {
  typewriterTimer = undefined
  const remaining = answerTarget.value.length - typedAnswer.value.length
  if (remaining > 0) {
    const step = remaining > 480 ? 3 : remaining > 120 ? 2 : 1
    typedAnswer.value = answerTarget.value.slice(0, typedAnswer.value.length + step)
    scheduleMarkdownRender()
    typewriterScrollTick += 1
    if (typewriterScrollTick % 3 === 0) void scrollMessagesToBottom()
  }

  if (typedAnswer.value.length < answerTarget.value.length) {
    scheduleTypewriter()
    return
  }
  completeAnswerPlayback()
}

function completeAnswerPlayback() {
  if (!answerStreamCompleted.value || typedAnswer.value.length < answerTarget.value.length) return
  isTyping.value = false
  answerPlaybackCompleted.value = true
  scheduleMarkdownRender(true)
  void scrollMessagesToBottom()
}

function scheduleMarkdownRender(immediate = false) {
  if (immediate) {
    if (markdownRenderTimer !== undefined) window.clearTimeout(markdownRenderTimer)
    markdownRenderTimer = undefined
    renderedAnswer.value = renderMarkdown(typedAnswer.value)
    return
  }
  if (markdownRenderTimer !== undefined) return
  markdownRenderTimer = window.setTimeout(() => {
    markdownRenderTimer = undefined
    // 每次都重新解析当前完整 Markdown，禁止把不完整 HTML 片段直接拼进 DOM。
    renderedAnswer.value = renderMarkdown(typedAnswer.value)
  }, MARKDOWN_RENDER_INTERVAL_MS)
}

function stopAnswerTimers() {
  if (typewriterTimer !== undefined) window.clearTimeout(typewriterTimer)
  if (markdownRenderTimer !== undefined) window.clearTimeout(markdownRenderTimer)
  typewriterTimer = undefined
  markdownRenderTimer = undefined
}

function enqueueReasoningChunk(content: string, occurredAt: string) {
  if (!content) return
  if (reasoningStartedAt.value === null) {
    reasoningStartedAt.value = parseServerTime(occurredAt) || Date.now()
  }
  reasoningEndedAt.value = null
  reasoningTarget.value = content.startsWith(reasoningTarget.value)
    ? content
    : `${reasoningTarget.value}${content}`
  isReasoning.value = true
  reasoningExpanded.value = true
  scheduleReasoningTypewriter(0)
}

function finishReasoning(occurredAt?: string) {
  if (reasoningStartedAt.value !== null) {
    reasoningEndedAt.value = occurredAt ? parseServerTime(occurredAt) : Date.now()
  }
  if (!reasoningTarget.value) {
    isReasoning.value = false
    startAnswerPlaybackIfReady(FIRST_ANSWER_DELAY_MS)
    return
  }
  isReasoning.value = true
  if (reasoningText.value.length < reasoningTarget.value.length) {
    scheduleReasoningTypewriter(0)
    return
  }
  completeReasoningPlayback()
}

function scheduleReasoningTypewriter(delay = REASONING_TYPEWRITER_INTERVAL_MS) {
  if (reasoningTypewriterTimer !== undefined) return
  reasoningTypewriterTimer = window.setTimeout(runReasoningTypewriterStep, delay)
}

function runReasoningTypewriterStep() {
  reasoningTypewriterTimer = undefined
  const remaining = reasoningTarget.value.length - reasoningText.value.length
  if (remaining > 0) {
    const step = remaining > 1200 ? 8 : remaining > 600 ? 5 : remaining > 240 ? 3 : remaining > 80 ? 2 : 1
    reasoningText.value = reasoningTarget.value.slice(0, reasoningText.value.length + step)
    scheduleReasoningMarkdownRender()
    reasoningScrollTick += 1
    if (reasoningScrollTick % 3 === 0) void scrollReasoningToBottom()
  }

  if (reasoningText.value.length < reasoningTarget.value.length) {
    scheduleReasoningTypewriter()
    return
  }
  scheduleReasoningMarkdownRender(true)
  if (reasoningEndedAt.value !== null) completeReasoningPlayback()
}

function completeReasoningPlayback() {
  if (reasoningEndedAt.value === null || reasoningText.value.length < reasoningTarget.value.length) return
  isReasoning.value = false
  if (reasoningText.value) reasoningExpanded.value = false
  scheduleReasoningMarkdownRender(true)
  startAnswerPlaybackIfReady(FIRST_ANSWER_DELAY_MS)
  void scrollMessagesToBottom()
}

function scheduleReasoningMarkdownRender(immediate = false) {
  if (immediate) {
    if (reasoningMarkdownRenderTimer !== undefined) window.clearTimeout(reasoningMarkdownRenderTimer)
    reasoningMarkdownRenderTimer = undefined
    renderedReasoning.value = renderMarkdown(reasoningText.value)
    return
  }
  if (reasoningMarkdownRenderTimer !== undefined) return
  reasoningMarkdownRenderTimer = window.setTimeout(() => {
    reasoningMarkdownRenderTimer = undefined
    renderedReasoning.value = renderMarkdown(reasoningText.value)
  }, MARKDOWN_RENDER_INTERVAL_MS)
}

function stopReasoningTimers() {
  if (reasoningTypewriterTimer !== undefined) window.clearTimeout(reasoningTypewriterTimer)
  if (reasoningMarkdownRenderTimer !== undefined) window.clearTimeout(reasoningMarkdownRenderTimer)
  reasoningTypewriterTimer = undefined
  reasoningMarkdownRenderTimer = undefined
}

function freezeCurrentReasoning() {
  stopReasoningTimers()
  reasoningTarget.value = reasoningText.value
  if (reasoningStartedAt.value !== null && reasoningEndedAt.value === null) {
    reasoningEndedAt.value = Date.now()
  }
  isReasoning.value = false
  if (reasoningText.value) reasoningExpanded.value = false
  scheduleReasoningMarkdownRender(true)
}

function restoreReasoning(run: RunSummary, source: RunEvent[], preservePlayback = false) {
  const reasoningEvents = source.filter((event) => event.type === 'message.reasoning.delta')
  const restoredReasoning = String(run.result?.reasoning || '')
    || reasoningEvents.map((event) => String(event.payload.content || '')).join('')
  const first = reasoningEvents[0]
  const last = reasoningEvents[reasoningEvents.length - 1]
  const closingEvent = last ? source.find((event) => (
    event.sequence > last.sequence
    && (event.type === 'message.delta' || event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled')
  )) : undefined

  if (preservePlayback && (reasoningTarget.value || reasoningText.value)) {
    reasoningTarget.value = restoredReasoning.startsWith(reasoningTarget.value)
      ? restoredReasoning
      : reasoningTarget.value
    if (reasoningStartedAt.value === null && first) {
      reasoningStartedAt.value = parseServerTime(first.occurred_at)
    }
    if (closingEvent) reasoningEndedAt.value = parseServerTime(closingEvent.occurred_at)
    isReasoning.value = !closingEvent || reasoningText.value.length < reasoningTarget.value.length
    reasoningExpanded.value = isReasoning.value
    if (reasoningText.value.length < reasoningTarget.value.length) scheduleReasoningTypewriter(0)
    else if (closingEvent) completeReasoningPlayback()
    return
  }

  stopReasoningTimers()
  reasoningTarget.value = restoredReasoning
  reasoningText.value = restoredReasoning
  renderedReasoning.value = renderMarkdown(restoredReasoning)
  reasoningStartedAt.value = first ? parseServerTime(first.occurred_at) : null
  if (!last) {
    reasoningEndedAt.value = null
    isReasoning.value = false
    reasoningExpanded.value = false
    return
  }
  isReasoning.value = !closingEvent && ['running', 'pending'].includes(run.status)
  reasoningEndedAt.value = closingEvent ? parseServerTime(closingEvent.occurred_at) : null
  reasoningExpanded.value = isReasoning.value
}

function setAnswerTarget(answer: string, animate: boolean) {
  if (!animate) {
    stopAnswerTimers()
    answerTarget.value = answer
    typedAnswer.value = answer
    isTyping.value = false
    answerPlaybackCompleted.value = true
    renderedAnswer.value = renderMarkdown(answer)
    return
  }
  if (typedAnswer.value && !answer.startsWith(typedAnswer.value)) {
    stopAnswerTimers()
    typedAnswer.value = ''
    renderedAnswer.value = ''
  }
  answerTarget.value = answer
  answerPlaybackCompleted.value = false
  if (!answer) {
    completeAnswerPlayback()
    return
  }
  startAnswerPlaybackIfReady(typedAnswer.value ? 0 : FIRST_ANSWER_DELAY_MS)
}

function renderMarkdown(value: string): string {
  if (!value) return ''
  return DOMPurify.sanitize(markdown.render(value), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed'],
  })
}

function resetTypewriter() {
  stopAnswerTimers()
  stopReasoningTimers()
  answerTarget.value = ''
  typedAnswer.value = ''
  renderedAnswer.value = ''
  isTyping.value = false
  answerStreamCompleted.value = false
  answerPlaybackCompleted.value = false
  typewriterScrollTick = 0
  reasoningText.value = ''
  reasoningTarget.value = ''
  renderedReasoning.value = ''
  isReasoning.value = false
  reasoningExpanded.value = true
  reasoningStartedAt.value = null
  reasoningEndedAt.value = null
  reasoningAutoFollow.value = true
  reasoningScrollTick = 0
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

function handleReasoningScroll() {
  const element = reasoningScroll.value
  if (!element) return
  reasoningAutoFollow.value = element.scrollHeight - element.scrollTop - element.clientHeight < 36
}

async function scrollReasoningToBottom(force = false) {
  await nextTick()
  const element = reasoningScroll.value
  if (!element || (!force && !reasoningAutoFollow.value)) return
  element.scrollTop = element.scrollHeight
  reasoningAutoFollow.value = true
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
  onProgress?: (percent: number, stage: Exclude<UploadStage, 'idle'>) => void,
): Promise<T> {
  // Fetch 没有上传进度事件；附件请求使用 XHR，并继续由浏览器生成 multipart boundary。
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', url)
    request.responseType = 'json'
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || event.total <= 0) return
      const percent = Math.min(99, Math.round(event.loaded / event.total * 100))
      onProgress?.(percent, 'uploading')
    })
    request.upload.addEventListener('load', () => onProgress?.(100, 'processing'))
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.response as T)
        return
      }
      const detail = typeof request.response === 'string'
        ? request.response
        : JSON.stringify(request.response || {})
      reject(new Error(detail || `上传失败（HTTP ${request.status}）`))
    })
    request.addEventListener('error', () => reject(new Error('附件上传失败，请检查网络后重试。')))
    request.addEventListener('abort', () => reject(new Error('附件上传已取消。')))
    request.send(payload)
  })
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
    && (event.type === 'message.delta' || event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled')
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
  return assistantMessage?.content || answerFromEvents(run.events || [])
}

function answerFromEvents(source: RunEvent[]): string {
  let answer = ''
  for (const event of source) {
    if (event.type !== 'message.delta' || String(event.payload.stage || '') !== 'final') continue
    const content = String(event.payload.content || '')
    answer = content.startsWith(answer) ? content : `${answer}${content}`
  }
  return answer
}

function mergeRunArtifacts(...groups: RunArtifact[][]): RunArtifact[] {
  const byIdentity = new Map<string, RunArtifact>()
  for (const artifact of groups.flat()) {
    const filename = artifact.content?.file?.filename?.trim().toLocaleLowerCase()
    const identity = filename ? `file:${filename}` : `id:${artifact.id}`
    byIdentity.set(identity, artifact)
  }
  return [...byIdentity.values()]
}

function runArtifacts(run: RunSummary): RunArtifact[] {
  return mergeRunArtifacts(run.artifacts || []).filter((artifact) => (
    artifact.kind === 'generated-file' && Boolean(artifact.content?.file?.filename)
  ))
}

function runCitations(run: RunSummary): SourceCitation[] {
  return citationsFromEvents(run.events || [])
}

function citationsFromEvents(source: RunEvent[]): SourceCitation[] {
  const citations = new Map<string, SourceCitation>()
  for (const event of source) {
    if (event.type !== 'citation.created') continue
    const citation = event.payload.citation as Partial<SourceCitation> | undefined
    const url = String(citation?.url || '').trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue
    const id = String(citation?.id || url)
    if (citations.has(id)) continue
    citations.set(id, {
      id,
      citation_number: Number(citation?.citation_number || citations.size + 1),
      title: String(citation?.title || citation?.domain || url),
      url,
      domain: String(citation?.domain || citationDomain(url)),
      snippet: String(citation?.snippet || ''),
      provider: String(citation?.provider || 'web'),
    })
  }
  return [...citations.values()]
}

function citationDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

async function copyRunAnswer(run: RunSummary) {
  const content = run.id === activeRun.value?.id
    ? typedAnswer.value || runAnswer(run)
    : runAnswer(run)
  if (!content) return
  try {
    await navigator.clipboard.writeText(content)
    copiedAnswerRunId.value = run.id
    window.setTimeout(() => {
      if (copiedAnswerRunId.value === run.id) copiedAnswerRunId.value = ''
    }, 1500)
  } catch {
    window.alert('复制失败，请手动选择回答内容。')
  }
}

function sameUrl(left: string, right: string): boolean {
  if (!left || !right) return false
  try {
    return new URL(left).href === new URL(right).href
  } catch {
    return left === right
  }
}

function sourceInitial(citation: SourceCitation): string {
  return (citation.domain || citation.title || 'W').replace(/^www\./, '').slice(0, 1).toUpperCase()
}

function artifactFileType(artifact: RunArtifact): string {
  const filename = artifact.content?.file?.filename || ''
  const dot = filename.lastIndexOf('.')
  return attachmentTypeByExtension(dot >= 0 ? filename.slice(dot) : '')
}

function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '等待执行',
    running: '执行中',
    waiting_approval: '等待审批',
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已停止',
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
      const toolDisplayName = String(event.payload.tool_display_name || '')
      const args = (event.payload.args || {}) as Record<string, unknown>
      const command = String(args.command || '').trim()
      const requestId = String(event.payload.request_id || event.sequence)
      activate({
        id: `tool-${requestId}`,
        title: toolStepTitle(tool, toolDisplayName),
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
      const toolDisplayName = String(event.payload.tool_display_name || '')
      const step = [...steps].reverse().find((item) => (
        item.status === 'active'
        && (requestId ? item.id === `tool-${requestId}` : item.title === toolStepTitle(tool, toolDisplayName))
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
    if (event.type === 'run.cancelled') {
      activate({ id: 'cancelled', title: '已停止生成', detail: eventMessage(event), occurredAt, status: 'done' })
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
    select_mode: { id: 'mode', title: '选择回答模式', detail: '正在应用本次请求的执行策略' },
    fast_prepare: { id: 'fast', title: '准备快速响应', detail: '正在载入可用工具和会话信息' },
    fast_think: { id: 'fast-answer', title: '快速处理请求', detail: '正在直接回答或选择必要工具' },
    dispatch_agent: { id: 'route', title: '选择合适的处理能力', detail: '已根据内容自动分配专业 Agent' },
    analyze_task: { id: 'plan', title: '分析任务并制定计划', detail: '正在拆解目标和所需步骤' },
    create_plan: { id: 'create-plan', title: '生成执行计划', detail: '正在生成可验证的执行步骤' },
    replan: { id: 'replan', title: '调整执行计划', detail: '正在根据执行结果修复后续计划' },
    think: { id: 'reason', title: '规划下一步操作', detail: '正在判断是否需要使用工具' },
    direct_chat: { id: 'answer', title: '组织最终答复', detail: '正在生成回复内容' },
    prepare_upload: { id: 'upload-prepare', title: '准备附件', detail: '正在创建任务上下文并整理待上传文件' },
    upload_files: { id: 'upload', title: '上传附件', detail: '正在将附件安全传输到服务端' },
    parse_input: { id: 'parse', title: '读取考勤数据', detail: '正在解析输入表格' },
    parse_excel: { id: 'parse', title: '读取考勤数据', detail: '正在解析 Excel 文件' },
    detect_excel_source: { id: 'attendance-source', title: '识别考勤数据源', detail: '正在根据文件表头识别考勤机和企业微信数据' },
    parse_machine: { id: 'attendance-machine', title: '解析考勤机记录', detail: '正在读取考勤机原始打卡事件' },
    parse_wecom: { id: 'attendance-wecom', title: '解析企业微信记录', detail: '正在读取企业微信上下班打卡日报' },
    normalize_data: { id: 'normalize', title: '整理考勤字段', detail: '正在统一字段和数据格式' },
    normalize_attendance: { id: 'normalize', title: '整理考勤字段', detail: '正在统一字段和数据格式' },
    merge_attendance_fact: { id: 'attendance-merge', title: '匹配双源打卡事件', detail: '正在核验考勤机与企业微信记录' },
    analyze_attendance: { id: 'analyze', title: '汇总员工考勤', detail: '正在统计出勤、迟到、早退、缺卡和请假记录' },
    generate_conclusion_excel: { id: 'attendance-export', title: '生成考勤结果表', detail: '正在生成并校验完整员工考勤汇总' },
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

function toolStepTitle(tool: string, displayName = ''): string {
  if (displayName.trim()) return displayName.trim()
  const labels: Record<string, string> = {
    run_shell: '在隔离环境执行命令',
    read_file: '读取工作区文件',
    web_search: '搜索互联网',
    web_fetch: '获取网页内容',
    query_database: '查询业务数据',
    create_excel_artifact: '生成 Excel 文件',
    create_word_artifact: '生成 Word 文档',
    create_pdf_artifact: '生成 PDF 文档',
    'mcp__fuecn-internal__demo_order_lookup': '查询订单状态',
    'mcp__12306mcp__get-current-time': '获取当前时间',
    'mcp__12306mcp__query-tickets': '查询火车票',
    'mcp__12306mcp__query-transfer': '查询中转换乘',
    'mcp__12306mcp__query-train-route': '查询列车经停站',
    'mcp__12306mcp__search-stations': '查询车站信息',
    'mcp__12306mcp__query-ticket-price': '查询车票价格',
    mcp__amapmcp__maps_geo: '解析地址位置',
    mcp__amapmcp__maps_regeocode: '解析坐标位置',
    mcp__amapmcp__maps_ip_location: '查询 IP 位置',
    mcp__amapmcp__maps_weather: '查询天气',
    mcp__amapmcp__maps_search_detail: '查询地点详情',
    mcp__amapmcp__maps_text_search: '搜索地点',
    mcp__amapmcp__maps_around_search: '搜索周边地点',
    mcp__amapmcp__maps_distance: '计算路线距离',
    mcp__amapmcp__maps_direction_walking: '查询步行路线',
    mcp__amapmcp__maps_direction_driving: '查询驾车路线',
    mcp__amapmcp__maps_direction_bicycling: '查询骑行路线',
    mcp__amapmcp__maps_direction_transit_integrated: '查询公交路线',
  }
  return labels[tool] || '调用外部工具'
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
}

function eventStage(event: RunEvent): string {
  if (event.type === 'tool.started') return '调用工具'
  if (event.type === 'tool.completed') {
    return event.payload.ok === false ? '工具调用失败' : '工具调用完成'
  }
  const stage = String(event.payload.stage || event.type)
  const labels: Record<string, string> = {
    recognize_intent: '理解需求',
    direct_chat: '生成回复',
    dispatch_agent: '进入专业分析',
    analyze_task: '分析任务',
    think: '规划下一步',
    parse_excel: '解析 Excel',
    detect_excel_source: '识别考勤数据源',
    parse_machine: '解析考勤机记录',
    parse_wecom: '解析企业微信记录',
    normalize_attendance: '整理考勤字段',
    merge_attendance_fact: '匹配双源打卡事件',
    generate_conclusion_excel: '生成考勤结果表',
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
    'run.cancelled': '已停止生成',
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
  if ((event.type === 'tool.started' || event.type === 'tool.completed') && event.payload.tool) {
    const toolName = String(event.payload.tool)
    if (event.type === 'tool.started') return `开始调用：${toolName}`
    return event.payload.ok === false ? `调用失败：${toolName}` : `调用完成：${toolName}`
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
    :style="{ '--execution-width': executionCollapsed ? '0px' : executionWidth + 'px' }"
    :class="{
      'sessions-collapsed': sessionsCollapsed,
      'execution-collapsed': executionCollapsed,
      'execution-resizing': isExecutionResizing,
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

      <button class="new-chat" type="button" :disabled="isSubmitting" @click="createConversation">
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
            <button class="session-open" type="button" :disabled="isSubmitting" @click="selectConversation(conversation.id)">
              <span>{{ conversation.title }}</span>
              <small>{{ formatTime(conversation.updated_at) }}</small>
            </button>
            <button
              class="session-delete"
              type="button"
              :disabled="isSubmitting"
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
          <!-- <h1>描述目标，Agent 会自动选择处理方式。</h1> -->
          <span>直接提问，或添加 Excel 数据；系统会自动识别意图、选择能力，并清晰展示处理过程。</span>
        </section>

        <section v-for="turn in historicalTurns" :key="turn.id" class="conversation-turn historical-turn">
          <article class="message user" :class="{ 'has-question-actions': isTerminalRun(turn.latestRun) }">
            <div class="avatar">我</div>
            <div class="bubble user-bubble" :tabindex="isTerminalRun(turn.latestRun) ? 0 : undefined">
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
              <div v-if="editingRunId === turn.latestRun.id" class="user-question-editor">
                <textarea
                  v-model="editingQuestion"
                  rows="3"
                  aria-label="编辑问题"
                  @keydown="handleEditKeydown($event, turn.latestRun)"
                ></textarea>
                <span v-if="editError" class="question-edit-error">{{ editError }}</span>
                <div class="question-edit-actions">
                  <button type="button" @click="cancelEditing">取消</button>
                  <button type="button" :disabled="isRetrying || !editingQuestion.trim()" @click="submitEditedRun(turn.latestRun)">
                    {{ isRetrying ? '发送中…' : '发送' }}
                  </button>
                </div>
              </div>
              <template v-else>
                <p>{{ turn.attempts[0]?.question || turn.latestRun.question }}</p>
                <div v-if="isTerminalRun(turn.latestRun)" class="question-actions" aria-label="问题操作">
                  <button
                    class="question-action-button"
                    :class="{ 'is-copied': copiedRunId === turn.latestRun.id }"
                    type="button"
                    :aria-label="copiedRunId === turn.latestRun.id ? '已复制' : '复制问题'"
                    :title="copiedRunId === turn.latestRun.id ? '已复制' : '复制'"
                    @click="copyRunQuestion(turn.latestRun)"
                  >
                    <svg v-if="copiedRunId === turn.latestRun.id" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12.5 4.2 4.2L19 7"></path>
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="8" y="8" width="11" height="11" rx="2"></rect>
                      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
                    </svg>
                  </button>
                  <button
                    class="question-action-button"
                    type="button"
                    aria-label="编辑问题"
                    title="编辑"
                    @click="startEditing(turn.latestRun)"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M13.5 6.5 17.5 10.5"></path>
                      <path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16v4Z"></path>
                    </svg>
                  </button>
                </div>
              </template>
            </div>
          </article>
          <article class="message assistant run-message">
            <div class="avatar agent-avatar">A</div>
            <div class="agent-response-column">
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
                @click="handleCitationClick($event, turn.latestRun)"
              ></div>
              <div v-else-if="turn.latestRun.error" class="run-error compact-error">
                <p>{{ turn.latestRun.error }}</p>
              </div>
              <div v-else-if="turn.latestRun.status === 'cancelled'" class="run-cancelled compact-cancelled">
                <span>回答已停止</span>
                <button type="button" :disabled="isRetrying || isResponseActive" @click="retryRun(turn.latestRun)">重新开始</button>
              </div>
              <button
                v-if="runCitations(turn.latestRun).length"
                class="citation-summary-chip"
                type="button"
                @click="openRunCitations(turn.latestRun)"
              >
                <span class="citation-summary-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1.1l2-2A5 5 0 0 0 12 4l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"></path></svg>
                </span>
                <span class="citation-site-stack" aria-hidden="true">
                  <i v-for="citation in runCitations(turn.latestRun).slice(0, 3)" :key="citation.id">{{ sourceInitial(citation) }}</i>
                </span>
                <strong>{{ runCitations(turn.latestRun).length }} 个网页</strong>
              </button>
              <section v-if="runArtifacts(turn.latestRun).length" class="artifact-deliveries compact-artifacts">
                <header><strong>生成文件</strong><span>{{ runArtifacts(turn.latestRun).length }} 个</span></header>
                <div class="artifact-delivery-list">
                  <article
                    v-for="artifact in runArtifacts(turn.latestRun)"
                    :key="artifact.id"
                    class="artifact-delivery-card"
                    :class="{ selected: selectedArtifact?.id === artifact.id }"
                    role="button"
                    tabindex="0"
                    @click="openArtifactPreview(artifact)"
                    @keydown.enter="openArtifactPreview(artifact)"
                  >
                    <span class="artifact-file-icon" :data-kind="artifactFileType(artifact)">{{ artifactFileType(artifact).slice(0, 1) }}</span>
                    <div class="artifact-file-copy">
                      <strong>{{ artifact.title || artifact.content?.file?.filename }}</strong>
                      <small>{{ artifact.content?.file?.filename }} · {{ formatFileSize(artifact.content?.file?.size || 0) }}</small>
                    </div>
                    <a v-if="artifact.content?.file?.download_url" class="artifact-download" :href="artifact.content.file.download_url" download @click.stop>下载</a>
                    <span v-else class="artifact-pending">准备中</span>
                  </article>
                </div>
              </section>
              </section>
              <div v-if="runAnswer(turn.latestRun)" class="answer-actions" aria-label="回答操作">
                <button
                  type="button"
                  :class="{ 'is-copied': copiedAnswerRunId === turn.latestRun.id }"
                  :aria-label="copiedAnswerRunId === turn.latestRun.id ? '已复制回答' : '复制回答'"
                  :title="copiedAnswerRunId === turn.latestRun.id ? '已复制' : '复制回答'"
                  @click="copyRunAnswer(turn.latestRun)"
                >
                  <svg v-if="copiedAnswerRunId === turn.latestRun.id" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7"></path></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>
                </button>
                <button
                  type="button"
                  aria-label="重新生成回答"
                  title="重新生成"
                  :disabled="isRetrying || isResponseActive"
                  @click="rerunRun(turn.latestRun)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5"></path><path d="M19 11a7.5 7.5 0 1 0-.9 5.4"></path></svg>
                </button>
              </div>
            </div>
          </article>
        </section>

        <section v-if="activeRun" class="conversation-turn active-turn">
          <article class="message user" :class="{ 'has-question-actions': isTerminalRun(activeRun) }">
            <div class="avatar">我</div>
            <div class="bubble user-bubble" :tabindex="isTerminalRun(activeRun) ? 0 : undefined">
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
              <div v-if="editingRunId === activeRun.id" class="user-question-editor">
                <textarea
                  v-model="editingQuestion"
                  rows="3"
                  aria-label="编辑问题"
                  @keydown="handleEditKeydown($event, activeRun)"
                ></textarea>
                <span v-if="editError" class="question-edit-error">{{ editError }}</span>
                <div class="question-edit-actions">
                  <button type="button" @click="cancelEditing">取消</button>
                  <button type="button" :disabled="isRetrying || !editingQuestion.trim()" @click="submitEditedRun(activeRun)">
                    {{ isRetrying ? '发送中…' : '发送' }}
                  </button>
                </div>
              </div>
              <template v-else>
                <p>{{ activeRun.question }}</p>
                <div v-if="isTerminalRun(activeRun)" class="question-actions" aria-label="问题操作">
                  <button
                    class="question-action-button"
                    :class="{ 'is-copied': copiedRunId === activeRun.id }"
                    type="button"
                    :aria-label="copiedRunId === activeRun.id ? '已复制' : '复制问题'"
                    :title="copiedRunId === activeRun.id ? '已复制' : '复制'"
                    @click="copyRunQuestion(activeRun)"
                  >
                    <svg v-if="copiedRunId === activeRun.id" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12.5 4.2 4.2L19 7"></path>
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="8" y="8" width="11" height="11" rx="2"></rect>
                      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
                    </svg>
                  </button>
                  <button
                    class="question-action-button"
                    type="button"
                    aria-label="编辑问题"
                    title="编辑"
                    @click="startEditing(activeRun)"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M13.5 6.5 17.5 10.5"></path>
                      <path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16v4Z"></path>
                    </svg>
                  </button>
                </div>
              </template>
            </div>
          </article>
          <article class="message assistant run-message">
            <div class="avatar agent-avatar">A</div>
            <div class="agent-response-column">
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

              <section
                v-if="isPreparingResponse"
                class="reasoning-panel is-active response-preparing"
                role="status"
                aria-live="polite"
              >
                <div class="response-preparing-header">
                  <span class="reasoning-orb" aria-hidden="true">✦</span>
                  <div class="response-preparing-copy">
                    <strong>{{ preparingResponseTitle }}</strong>
                    <small>{{ preparingResponseDetail }}</small>
                  </div>
                  <span class="response-preparing-dots" aria-hidden="true">
                    <i></i><i></i><i></i>
                  </span>
                </div>
              </section>

              <section v-if="reasoningText || isReasoning" class="reasoning-panel" :class="{ 'is-active': isReasoning }">
                <button class="reasoning-toggle" type="button" @click="reasoningExpanded = !reasoningExpanded">
                  <span class="reasoning-orb" aria-hidden="true">✦</span>
                  <strong class="reasoning-status">
                    <span>{{ isReasoning ? '正在深度思考' : '已深度思考' }}</span>
                    <time>{{ reasoningElapsedText }}</time>
                  </strong>
                  <span class="reasoning-chevron" :class="{ expanded: reasoningExpanded }">⌄</span>
                </button>
                <Transition name="reasoning-collapse">
                  <div
                    v-if="reasoningExpanded"
                    ref="reasoningScroll"
                    class="reasoning-content markdown-body"
                    :class="{ 'is-reasoning': isReasoning }"
                    @scroll="handleReasoningScroll"
                    v-html="renderedReasoning"
                  ></div>
                </Transition>
              </section>

              <div v-if="summary" class="metric-grid">
                <div><span>人数</span><strong>{{ summary.employee_count }}</strong></div>
                <div><span>出勤</span><strong>{{ summary.total_attendance_days }} 天</strong></div>
                <div><span>迟到</span><strong>{{ summary.total_late_count }} 次</strong></div>
                <div><span>扣款</span><strong>{{ summary.total_deduction }} 元</strong></div>
              </div>
              <div v-if="focusEmployees.length" class="result-table-wrap">
                <div class="result-table-heading">
                  <strong>重点关注人员</strong>
                  <span>共 {{ focusEmployees.length }} 人</span>
                </div>
                <table class="result-table">
                  <thead>
                    <tr>
                      <th>姓名</th>
                      <th v-for="metric in exceptionMetrics" :key="metric.type">{{ metric.label }}</th>
                      <th>关注原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in focusEmployees" :key="row.employee_key || row.name">
                      <td>{{ row.name }}</td>
                      <td v-for="metric in exceptionMetrics" :key="metric.type">
                        <span v-if="!Number(row[metric.countKey] || 0)">0</span>
                        <button
                          v-else
                          class="exception-tip-trigger"
                          type="button"
                          :class="{ active: activeExceptionTip?.key === `${row.employee_key || row.name}:${metric.type}` }"
                          :aria-expanded="activeExceptionTip?.key === `${row.employee_key || row.name}:${metric.type}`"
                          :aria-label="`查看${row.name}${metric.label}详情`"
                          :title="`查看${metric.label}详情`"
                          @click="toggleExceptionTip($event, row, metric)"
                        >
                          <span>{{ row[metric.countKey] }}</span><i aria-hidden="true">i</i>
                        </button>
                      </td>
                      <td>{{ employeeAttentionText(row) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <Teleport to="body">
                <div
                  v-if="activeExceptionTip"
                  ref="exceptionTipPanel"
                  class="exception-tip-panel exception-tip-floating"
                  :style="{ top: `${activeExceptionTip.top}px`, left: `${activeExceptionTip.left}px` }"
                  role="dialog"
                  :aria-label="`${activeExceptionTip.row.name}${activeExceptionTip.metric.label}详情`"
                  @pointerdown.stop
                >
                  <header><strong>{{ activeExceptionTip.row.name }} · {{ activeExceptionTip.metric.label }}详情</strong></header>
                  <template v-if="activeExceptionDetails.length">
                    <article
                      v-for="(detail, detailIndex) in activeExceptionDetails"
                      :key="`${detail.date}-${detailIndex}`"
                    >
                      <strong>{{ detail.date }}</strong>
                      <ul v-if="detail.events.length">
                        <li v-for="(event, eventIndex) in detail.events" :key="eventIndex">
                          {{ event.punch_type }}：应打卡 {{ event.expected_time || '—' }}，实际 {{ event.actual_time || '未打卡' }}，状态“{{ event.status || '异常' }}”
                        </li>
                      </ul>
                      <p>考勤机：{{ detail.machine_punches.length ? detail.machine_punches.join('、') : '无有效打卡' }}</p>
                      <p>判定：{{ detail.reason || '—' }}</p>
                    </article>
                  </template>
                  <p v-else class="exception-tip-empty">旧会话未保存异常明细，请重新分析附件。</p>
                </div>
              </Teleport>

              <div
                v-if="typedAnswer || isTyping"
                class="answer-text"
                :class="{ 'without-reasoning': !reasoningText && !isReasoning }"
                aria-live="polite"
              >
                <header><strong>最终答复</strong><span :class="{ streaming: isTyping }">{{ isTyping ? '正在生成' : '生成完成' }}</span></header>
                <div
                  class="markdown-body"
                  :class="{ 'is-typing': isTyping }"
                  v-html="renderedAnswer"
                  @click="handleCitationClick($event)"
                ></div>
              </div>

              <button
                v-if="answerPlaybackCompleted && activeCitations.length"
                class="citation-summary-chip"
                type="button"
                @click="openCitationSources(activeCitations)"
              >
                <span class="citation-summary-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1.1l2-2A5 5 0 0 0 12 4l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"></path></svg>
                </span>
                <span class="citation-site-stack" aria-hidden="true">
                  <i v-for="citation in activeCitations.slice(0, 3)" :key="citation.id">{{ sourceInitial(citation) }}</i>
                </span>
                <strong>{{ activeCitations.length }} 个网页</strong>
              </button>

              <section v-if="showActiveArtifacts && runArtifacts(activeRun).length" class="artifact-deliveries">
                <header><strong>已生成文件</strong><span>可下载并继续使用</span></header>
                <div class="artifact-delivery-list">
                  <article
                    v-for="artifact in runArtifacts(activeRun)"
                    :key="artifact.id"
                    class="artifact-delivery-card"
                    :class="{ selected: selectedArtifact?.id === artifact.id }"
                    role="button"
                    tabindex="0"
                    @click="openArtifactPreview(artifact)"
                    @keydown.enter="openArtifactPreview(artifact)"
                  >
                    <span class="artifact-file-icon" :data-kind="artifactFileType(artifact)">{{ artifactFileType(artifact).slice(0, 1) }}</span>
                    <div class="artifact-file-copy">
                      <strong>{{ artifact.title || artifact.content?.file?.filename }}</strong>
                      <small>{{ artifact.content?.file?.filename }} · {{ formatFileSize(artifact.content?.file?.size || 0) }}</small>
                    </div>
                    <a v-if="artifact.content?.file?.download_url" class="artifact-download" :href="artifact.content.file.download_url" download @click.stop>下载文件</a>
                    <span v-else class="artifact-pending">准备中</span>
                  </article>
                </div>
              </section>

              <div v-if="activeRun.status === 'cancelled'" class="run-cancelled">
                <div>
                  <strong>已停止生成</strong>
                  <span>已保留当前回答、执行轨迹和已生成文件。</span>
                </div>
                <button type="button" :disabled="isRetrying" @click="retryRun(activeRun)">
                  {{ isRetrying ? '正在重新开始…' : '重新开始' }}
                </button>
              </div>

              <div v-if="failureDetail" class="run-error">
                <p>{{ failureDetail }}</p>
                <div class="run-error-actions">
                  <span v-if="retryError">{{ retryError }}</span>
                  <button type="button" :disabled="isRetrying || isSubmitting" @click="retryFailedRun">
                    {{ isSubmitting ? '正在重新发送…' : isRetrying ? '正在重新执行…' : isLocalUploadRun(activeRun) ? '重新发送' : '重新执行' }}
                  </button>
                </div>
              </div>

              </section>
              <div
                v-if="answerPlaybackCompleted && typedAnswer && !isRunActive"
                class="answer-actions"
                aria-label="回答操作"
              >
                <button
                  type="button"
                  :class="{ 'is-copied': copiedAnswerRunId === activeRun.id }"
                  :aria-label="copiedAnswerRunId === activeRun.id ? '已复制回答' : '复制回答'"
                  :title="copiedAnswerRunId === activeRun.id ? '已复制' : '复制回答'"
                  @click="copyRunAnswer(activeRun)"
                >
                  <svg v-if="copiedAnswerRunId === activeRun.id" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7"></path></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>
                </button>
                <button
                  type="button"
                  aria-label="重新生成回答"
                  title="重新生成"
                  :disabled="isRetrying || isResponseActive"
                  @click="rerunRun(activeRun)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5"></path><path d="M19 11a7.5 7.5 0 1 0-.9 5.4"></path></svg>
                </button>
              </div>
            </div>
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
        <div class="composer" :class="{ dragging: isDragging, ['mode-' + responseMode]: true }">
          <div class="response-mode-bar">
            <div
              class="response-mode-picker"
              :class="{ 'is-expert': responseMode === 'expert' }"
              role="group"
              aria-label="回答模式"
            >
              <span class="response-mode-slider" aria-hidden="true"></span>
              <button
                type="button"
                :class="{ active: responseMode === 'fast' }"
                :aria-pressed="responseMode === 'fast'"
                :disabled="isResponseActive || isSubmitting"
                title="优先响应，适合日常问答和简单工具任务"
                @click="selectResponseMode('fast')"
              ><span aria-hidden="true">⚡</span>快速模式</button>
              <button
                type="button"
                :class="{ active: responseMode === 'expert' }"
                :aria-pressed="responseMode === 'expert'"
                :disabled="isResponseActive || isSubmitting"
                title="先规划再执行，适合复杂和高准确度任务"
                @click="selectResponseMode('expert')"
              ><span aria-hidden="true">✦</span>专家模式</button>
            </div>
          </div>
          <section v-if="hasTable" class="composer-attachments" aria-label="已添加的附件">
            <div class="attachment-grid">
              <article
                v-for="(file, index) in attachments"
                :key="`${file.name}-${file.size}-${file.lastModified}`"
                class="attachment-card"
              >
                <span class="file-glyph" :data-kind="attachmentType(file)" aria-hidden="true">{{ attachmentType(file).slice(0, 1) }}</span>
                <div>
                  <strong>{{ file.name }}</strong>
                  <small>{{ attachmentType(file) }} · {{ formatFileSize(file.size) }} · 已就绪</small>
                </div>
                <button type="button" aria-label="移除附件" title="移除附件" :disabled="isSubmitting" @click="removeAttachment(index)">×</button>
              </article>
              <article v-if="hasClipboardTable" class="attachment-card">
                <span class="file-glyph" data-kind="Excel" aria-hidden="true">X</span>
                <div><strong>剪贴板表格</strong><small>{{ pasteRowCount }} 行数据 · 已就绪</small></div>
                <button type="button" aria-label="移除表格" title="移除表格" @click="clearTable">×</button>
              </article>
            </div>
            <div class="attachment-prompts">
              <template v-if="hasAttendanceData">
                <button type="button" :disabled="isSubmitting" @click="applyAttachmentPrompt('分析考勤数据，统计迟到、早退、缺卡情况')">统计考勤异常 <span>→</span></button>
                <button type="button" :disabled="isSubmitting" @click="applyAttachmentPrompt('核对打卡记录差异，标注异常员工')">核对打卡差异 <span>→</span></button>
                <button type="button" :disabled="isSubmitting" @click="applyAttachmentPrompt('汇总出勤情况并生成考勤异常报告')">生成考勤报告 <span>→</span></button>
              </template>
              <template v-else>
                <button type="button" :disabled="isSubmitting" @click="applyAttachmentPrompt('梳理附件的重点内容，并给出结构化总结')">梳理重点内容 <span>→</span></button>
                <button type="button" :disabled="isSubmitting" @click="applyAttachmentPrompt('分析附件，找出关键结论、异常和需要关注的问题')">分析并找出问题 <span>→</span></button>
              </template>
            </div>
          </section>
          <textarea
            v-model="question"
            rows="3"
            placeholder="输入您的问题，或粘贴、拖入文件进行分析…"
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
                :disabled="isSubmitting"
                @change="onFileChange"
              />
              <button
                class="attach-button"
                type="button"
                title="添加附件"
                :disabled="isSubmitting"
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
            <button
              v-if="isResponseActive"
              class="send stop-send"
              type="button"
              :disabled="isStopping"
              aria-label="停止生成"
              title="停止生成"
              @click="cancelActiveRun"
            >
              <span class="stop-glyph" aria-hidden="true"></span>
            </button>
            <button v-else class="send" type="button" :disabled="!canSubmit" @click="submitRun">
              {{ isSubmitting ? '...' : '↑' }}
            </button>
          </div>
        </div>
        <p v-if="submitError" class="composer-error">{{ submitError }}</p>
      </footer>
    </section>

    <div
      v-if="!executionCollapsed"
      class="execution-resizer"
      role="separator"
      aria-label="调整右侧面板宽度"
      aria-orientation="vertical"
      :aria-valuemin="MIN_EXECUTION_WIDTH"
      :aria-valuemax="MAX_EXECUTION_WIDTH"
      :aria-valuenow="Math.round(executionWidth)"
      tabindex="0"
      @pointerdown="startExecutionResize"
      @keydown.left.prevent="resizeExecutionBy(20)"
      @keydown.right.prevent="resizeExecutionBy(-20)"
    ></div>

    <aside
      v-if="!executionCollapsed"
      class="execution-sidebar"
      :class="{
        'is-preview-mode': sidebarMode !== 'trace',
        'is-sources-mode': sidebarMode === 'sources',
      }"
      :aria-label="sidebarTitle"
    >
      <header class="execution-sidebar-header">
        <div>
          <span>{{ sidebarEyebrow }}</span>
          <strong>{{ sidebarTitle }}</strong>
        </div>
        <div class="execution-header-actions">
          <button v-if="sidebarMode !== 'trace'" class="preview-trace-button" type="button" @click="showExecutionTrace">返回轨迹</button>
          <small v-else>{{ processProgressText }}</small>
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

      <template v-if="sidebarMode === 'sources' && selectedCitation">
        <section class="citation-browser-pane">
          <header class="citation-browser-summary">
            <span class="citation-browser-number">{{ selectedCitation.citation_number }}</span>
            <div>
              <strong>{{ selectedCitation.title }}</strong>
              <small>{{ selectedCitation.domain }}</small>
            </div>
            <a :href="selectedCitation.url" target="_blank" rel="noopener noreferrer">打开原网页</a>
          </header>

          <p v-if="selectedCitation.snippet" class="citation-browser-snippet">{{ selectedCitation.snippet }}</p>

          <div class="citation-browser-list" aria-label="引用来源列表">
            <button
              v-for="citation in sourcePanelCitations"
              :key="citation.id"
              type="button"
              :class="{ selected: citation.id === selectedCitation.id }"
              @click="selectCitation(citation)"
            >
              <span>{{ citation.citation_number }}</span>
              <span><strong>{{ citation.title }}</strong><small>{{ citation.domain }}</small></span>
            </button>
          </div>

          <div class="citation-webpage-frame">
            <div>
              <span>安全网页预览</span>
              <small>若网站禁止嵌入，请点击“打开原网页”</small>
            </div>
            <iframe
              :key="selectedCitation.url"
              :src="selectedCitation.url"
              :title="`引用网页：${selectedCitation.title}`"
              sandbox="allow-scripts allow-forms allow-popups allow-downloads"
              referrerpolicy="no-referrer"
              loading="lazy"
            ></iframe>
          </div>
        </section>
      </template>

      <template v-else-if="sidebarMode === 'preview' && selectedArtifact">
        <section class="file-preview-pane">
          <header class="file-preview-summary">
            <span class="artifact-file-icon" :data-kind="artifactFileType(selectedArtifact)">{{ artifactFileType(selectedArtifact).slice(0, 1) }}</span>
            <div>
              <strong>{{ selectedArtifact.title || selectedArtifactFile?.filename }}</strong>
              <small>{{ selectedArtifactFile?.filename }} · {{ formatFileSize(selectedArtifactFile?.size || 0) }}</small>
            </div>
            <a v-if="selectedArtifactFile?.download_url" :href="selectedArtifactFile.download_url" download>下载</a>
            <span v-else class="artifact-pending">准备中</span>
          </header>

          <section v-if="selectedArtifactPreview?.kind === 'table'" class="file-preview-content">
            <div class="file-preview-meta">
              <span>{{ selectedArtifactPreview.sheet_name || '数据' }}</span>
              <small v-if="selectedArtifactPreview.row_count">共 {{ selectedArtifactPreview.row_count }} 行</small>
            </div>
            <div class="file-preview-table-wrap">
              <table class="file-preview-table">
                <thead v-if="selectedArtifactPreview.headers?.length">
                  <tr><th v-for="header in selectedArtifactPreview.headers" :key="header">{{ header }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rowIndex) in selectedArtifactPreview.rows || []" :key="rowIndex">
                    <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>当前展示生成时保存的前 {{ selectedArtifactPreview.rows?.length || 0 }} 行安全预览。</p>
          </section>

          <section v-else-if="selectedArtifactPreview?.kind === 'document'" class="file-preview-content document-preview">
            <h2>{{ selectedArtifactPreview.title || selectedArtifact.title }}</h2>
            <article v-for="(section, sectionIndex) in selectedArtifactPreview.sections || []" :key="sectionIndex">
              <h3 v-if="section.heading">{{ section.heading }}</h3>
              <p v-for="(paragraph, paragraphIndex) in section.paragraphs || []" :key="`p-${paragraphIndex}`">{{ paragraph }}</p>
              <ul v-if="section.bullets?.length">
                <li v-for="(bullet, bulletIndex) in section.bullets" :key="bulletIndex">{{ bullet }}</li>
              </ul>
              <div v-if="section.table" class="file-preview-table-wrap">
                <table class="file-preview-table">
                  <thead><tr><th v-for="header in section.table.headers || []" :key="header">{{ header }}</th></tr></thead>
                  <tbody>
                    <tr v-for="(row, rowIndex) in section.table.rows || []" :key="rowIndex">
                      <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </article>
          </section>

          <section v-else-if="selectedArtifactPreview?.text" class="file-preview-content document-preview legacy-preview">
            <p>{{ selectedArtifactPreview.text }}</p>
          </section>
          <div v-else class="execution-sidebar-empty"><span>◇</span><p>该文件没有可展示的预览数据，请下载后查看。</p></div>
        </section>
      </template>

      <template v-else-if="activeRun">
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
