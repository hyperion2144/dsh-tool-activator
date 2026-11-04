import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { ToolGroup } from './shared'

/** One entry of the tool catalog: what the model can still activate. */
export interface CatalogEntry {
  /** The identifier the model activates by. */
  name: string
  /** What this entry covers, in one line. */
  description: string
}

/** One publication of the tool catalog. */
export interface CatalogPublication {
  /** The model-facing text of the whole catalog. */
  text: string
  /** The entries still available in this session, in catalog order. */
  entries: readonly CatalogEntry[]
}

/**
 * The source of this plugin's own messages: the developer message that
 * declares an activated tool, and the catalog the model reads.
 *
 * The catalog form carries the entries it published, so a consumer presents
 * the list instead of re-parsing the prose, and marks a replacement catalog so
 * the consumer knows the earlier one no longer applies.
 */
export type ActivatorMessageSource
  = | { readonly kind: 'tool-activator' }
    | { readonly kind: 'tool-activator', readonly form: 'catalog', readonly entries: readonly CatalogEntry[], readonly update?: true }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-activator': ActivatorMessageSource
  }
}

/** The system prompt assembly and the catalog this plugin publishes beside it. */
export interface PreparedPrompt {
  /** The assembly with the tool-dependent sections removed: they travel with the catalog. */
  assembly: AssembledPrompt
  /** The catalog the model reads about the tools it may call. */
  catalog: CatalogPublication
}

/** Publishes the tool catalog as this plugin's own message. */
export interface CatalogPublisher {
  /** Record the catalog an agent's next step would publish. */
  prepare: (agent: Agent, catalog: CatalogPublication) => void
  /** Forget the catalog: this agent has none to publish. */
  forget: (agent: Agent) => void
  /** The message that publishes the agent's catalog, or undefined when it did not change. */
  publish: (agent: Agent) => UserMessage | undefined
}

export interface ActivateToolsParams {
  identifiers: string[]
  reason: string
}

export interface ActivateSkillParams {
  name: string
}

export interface ActivatedToolInfo {
  apiCount: number
  avatar?: string
  identifier: string
  name: string
}

export interface ActivateToolsState {
  activatedSkills: unknown[]
  activatedTools: ActivatedToolInfo[]
  alreadyActive: string[]
  notFound: string[]
}

export interface ActivationResult {
  content: string
  state?: ActivateToolsState | unknown
  success: boolean
}

export interface ToolManifestInfo {
  apiDescriptions: Array<{ description: string, name: string }>
  avatar?: string
  identifier: string
  name: string
  systemRole?: string
}

export interface ActivatorRuntimeService {
  activateSkill?: (args: ActivateSkillParams) => Promise<ActivationResult>
  explainNotFound?: (identifier: string) => string | undefined
  getActivatedToolIds: () => string[]
  getToolManifests: (identifiers: string[]) => Promise<ToolManifestInfo[]>
  markActivated: (identifiers: string[]) => void
}

export interface AvailableToolItem {
  description: string
  identifier: string
  name: string
}

export interface ToolCatalogItem extends ToolManifestInfo {
  description: string
  tools: ToolSchema[]
  sections: string[]
}

export interface ActivatedSkillInfo {
  id: string
  name: string
  description: string
  source: string
  title: string
  hasResources: boolean
  provider?: string
  instructions?: string
}

export interface ActivationEnvelope {
  producer: 'dsh-tool-activator'
  version: 1
  content: string
  success: boolean
  state: {
    activatedTools: ActivatedToolInfo[]
    activatedSkills: ActivatedSkillInfo[]
    alreadyActive: string[]
    notFound: string[]
  }
}

export interface ActivationReceipt extends ActivationEnvelope {
  authorized: true
  approvalRequired: boolean
  commit: ActivationCommit
}

export interface ActivationHistory {
  activatedToolIds: string[]
  activatedSkills: ActivatedSkillInfo[]
  pendingCalls: string[]
  pendingActivations?: Array<{ callId: string, parentCallId: string, activation: ActivationReceipt }>
  pendingRequests?: Array<{ callId: string, identifiers: string[] }>
  approvalRequests?: Array<{ id: string, callId: string }>
  approvedCalls?: string[]
}

export interface ActivationCommit {
  producer: 'dsh-tool-activator'
  version: 1
  callId: string
  activatedToolIds: string[]
  activatedSkills: ActivatedSkillInfo[]
}

export interface ActivationCatalogEntry {
  identifier: string
  name: string
  description: string
  tools: string[]
}

export interface ActivationCatalog {
  autoGroupMcp: boolean
  basicTools: string[]
  baseTools: string[]
  entries: ActivationCatalogEntry[]
  groups: ToolGroup[]
  requireApproval: boolean
}

/**
 * What the prompt-assembly waterfall actually receives. Hosts before dsh 0.2.2
 * handed over the tool declarations in the same object; from 0.2.2 the waterfall
 * receives a bare presentation and the provider-owned schemas are merged
 * afterwards, so `tools` must be treated as optional rather than assumed.
 */
export type AssembledPrompt = Omit<PromptAssembly, 'tools'> & { tools?: readonly ToolSchema[] }
