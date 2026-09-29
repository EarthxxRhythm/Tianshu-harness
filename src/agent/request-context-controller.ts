import { randomUUID } from 'node:crypto'
import { buildContextBudget } from '../context/request-budget.js'
import type { AgentLoop } from './loop.js'
import type { AgentCallbacks } from './loop-types.js'
import type { OaiChatRequest, OaiMessage } from '../api/oai-types.js'
import type { ContextBudgetSnapshot } from '../server/protocol.js'
import { prepareContextRequest } from './context-budget-preparation.js'
import { compactBudgetHistory } from './budget-compaction.js'
import { archiveContextImages } from './context-image-archive.js'
import { COMPACT_HISTORY_TOOL } from '../compact/recall-marker.js'
import { invalidateSessionReadDedup } from '../tools/read-file.js'

/** One request budget owner; ordinary observations never mutate the prompt. */
export class RequestContextController {
  snapshot?: ContextBudgetSnapshot
  private revision = 0
  activeUserMessage?: OaiMessage
  private failedAt?: { input: number; model: string; budget: number }
  constructor(private readonly agent: AgentLoop) {}

  record(budget: ContextBudgetSnapshot, beginRequest = false): ContextBudgetSnapshot {
    if (!beginRequest && this.snapshot && this.snapshot.requestId !== budget.requestId) return this.snapshot
    this.snapshot = { ...budget, revision: ++this.revision, sampledAt: Date.now() }
    return this.snapshot
  }

  async prepare(build: () => OaiChatRequest, callbacks: AgentCallbacks): Promise<OaiChatRequest> {
    const policy = this.agent.config.promptEngine.getRequestBudgetPolicy()
    if (!policy) return build()
    return prepareContextRequest({ build, policy, signal: this.agent.abortController?.signal,
      preview: request => (this.agent.config.primaryClient ?? this.agent.config.client)?.previewContextRequest?.(request) ?? request,
      publish: budget => { const current = this.record(budget, true); callbacks.onContextBudget?.(current) },
      compact: () => this.compact(),
    })
  }

  refreshSnapshot(): void {
    const self = this.agent, policy = self.config.promptEngine.getRequestBudgetPolicy()
    if (!policy) return
    const request = self.config.promptEngine.buildOaiRequest(self.session.getMessages(), self.recentToolHistory, self.config.contextWindow)
    const visible = (self.config.primaryClient ?? self.config.client)?.previewContextRequest?.(request) ?? request
    this.record(buildContextBudget(visible, policy, { requestId: randomUUID(), revision: 0 }), true)
  }

  async compact(force = false): Promise<boolean> {
    const self = this.agent, budget = this.snapshot
    if (!self.persist || !self.artifactStore || self.config.compact?.enabled === false) return false
    if (!force && budget && this.failedAt?.model === budget.model && this.failedAt.budget === budget.inputBudget
      && budget.inputTokens < this.failedAt.input + 32_768) return false
    const signal = self.abortController?.signal
    await self.drainPersistWrites()
    const source = self.session.getMessages().slice()
    const originalUser = this.activeUserMessage
    const activeUser = originalUser && (source.includes(originalUser) ? originalUser : source.find(m => m.role === 'user'
      && typeof m.content === 'string' && typeof originalUser.content === 'string'
      && m.content.startsWith(originalUser.content + '\n<system-reminder>')))
    // History repair/rewind may have moved or replaced the user boundary. An
    // unidentified boundary blocks rewriting rather than protecting a tool by index.
    if (originalUser && !activeUser) return false
    const changed = await compactBudgetHistory(source, {
      client: self.config.primaryClient ?? self.config.client,
      model: self.config.promptEngine.getModel(), signal, protectedUser: activeUser,
      targetTokens: budget ? Math.floor(budget.inputBudget * 0.7) - 16_384 : undefined,
      minReclaimTokens: 32_768,
      recordUsage: usage => self.recordSidePathUsage('compact-summary', usage, self.config.promptEngine.getModel()),
      archive: async messages => {
        const images = await archiveContextImages(self.artifactStore!, messages)
        const id = await self.artifactStore!.saveDurable({
          tool: COMPACT_HISTORY_TOOL, target: 'context-budget', rawContent: JSON.stringify(messages),
          summary: 'Full context before budget compaction (including original images and reasoning)', sections: [],
        })
        return { id, images }
      },
      commit: async messages => {
        signal?.throwIfAborted()
        await self.commitBudgetHistory(source, messages)
        this.activeUserMessage = activeUser
        self.config.promptEngine.resetAppendixBaseline()
        invalidateSessionReadDedup(self.config.sessionId)
      },
    })
    this.failedAt = changed || !budget ? undefined : { input: budget.inputTokens, model: budget.model, budget: budget.inputBudget }
    return changed
  }
}
