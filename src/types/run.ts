// Agent 运行的稳定状态集合，页面可据此决定是否继续订阅实时事件。
export type RunStatus = 'queued' | 'running' | 'waiting_input' | 'waiting_approval' | 'completed' | 'failed'

// 持久化事件序号 sequence 用于排序、去重和 SSE 断点续传。
export interface RunEvent {
  eventId: string
  runId: string
  sequence: number
  type: string
  occurredAt: string
  payload: Record<string, unknown>
}

export interface AgentSummary {
  key: string
  displayName: string
  version: string
  description: string
}
