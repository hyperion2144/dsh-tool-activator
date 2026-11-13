import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SkillDefinition, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolActivatorConfig } from './config'
import type { GroupingFacts } from './groups'
import type { ReleasePlan } from './release'
import type { ToolPolicy } from './shared'
import type { ActivateToolsParams, ActivationEnvelope, ActivationHistory, ActivationReceipt, ActivationResult, AssembledPrompt, DeactivateToolsParams, GroupApplyReceipt, GroupingToolParams, GroupingToolResult, IdleClock, ReleasedEntry, ReleaseReason, ReleaseReceipt, SessionAccount, ToolCatalogItem } from './types'
import { createDeveloperMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { activationContent, activationEnvelope, activationHistorySchema, parseActivation } from './activation'
import { createToolHiding } from './admission-gating'
import { planCapRelease } from './cap'
import { buildToolCatalog, enabledToolNames } from './catalog'
import { validatePolicy } from './config'
import { ACTIVATION_PRODUCER, ACTIVATION_PROJECTION_KEY, ACTIVATION_VERSION, ACTIVATOR_SOURCE_KIND, ACTIVATOR_TOOL_NAME, BASIC_GROUP_IDENTIFIER, DEACTIVATOR_TOOL_NAME, LOCKED_TOOL_NAMES } from './constants'
import { settingsNamespaceOf, settingsServiceOf, writeGroups } from './group-writer'
import { applyGroupOps, groupingSnapshot } from './groups'
import { emptyActivationHistory, foldActivationEvent, mergeActivation } from './history'
import { foldIdleEvent, idleClockOf, planIdleRelease } from './idle'
import { createCatalogPublisher } from './injection'
import { immediateToolNames, preparePromptAssembly } from './prompt'
import { planRelease, releaseContent, releaseReceipt } from './release'
import { provideToolActivatorRemote } from './remote'
import { ActivatorExecutionRuntime } from './runtime'
import { loadToolSdkRenderers } from './sdk-render'
import { createActivatorTool, createDeactivatorTool, createGroupingTool } from './tool'
import './session-projection'

interface ActivationExecution {
  agent: Agent
  identifiers: ReadonlySet<string>
  approved: boolean
}

interface PtcReceipt {
  agent: Agent
  parent: ToolExecutionToken
  rootCallId: string
  receipt: ActivationReceipt
}

interface DirectoryCapability {
  ensure: (agent: Agent, signal?: AbortSignal) => Promise<string>
}

/**
 * What one session's request head already declares. Activation must not rewrite
 * that head — a changed declaration list costs the provider's whole cached
 * prefix — so a newly enabled tool is announced with a `tool_addition` after the
 * cached history instead.
 */
interface AnnouncementState {
  headerSeq?: SessionSeq
  headerTools: Set<string>
  turn: number
  step: number
  /**
   * A `developer/message` is a step-scoped event: outside an open step the log
   * rejects it as corrupt. `step/end` closes the step before the next
   * `step/start`, so the last known coordinates are not writable in that gap.
   */
  stepOpen: boolean
}

/**
 * A host that owns the declarations and exposes no step admission leaves the plugin
 * nowhere to present an un-activated tool: the model would see all of them.
 */
let reportedMissingAdmission = false

function reportMissingAdmission(): void {
  if (reportedMissingAdmission)
    return
  reportedMissingAdmission = true
  console.warn('[dsh-tool-activator] this host owns the tool declarations and exposes no tool admission (tools.resolve); inactive tools cannot be hidden from the model')
}

/** Fold one session event into what this session's head already declares. */
function foldAnnouncement(state: AnnouncementState, event: SessionEvent): void {
  if (event.type === 'request/header') {
    state.headerSeq = event.seq
    state.headerTools = new Set((event.data.header.tools ?? []).map(tool => tool.name))
  }
  if ('turn' in event.data && 'step' in event.data) {
    state.turn = event.data.turn
    state.step = event.data.step
  }
  if (event.type === 'step/start')
    state.stepOpen = true
  else if (event.type === 'step/end')
    state.stepOpen = false
}

/**
 * Tools an earlier `tool_addition` already serves. Read from the current
 * surface rather than the log: a fold that drops the announcement has to be
 * re-issued, or the model silently loses a tool it already activated.
 */
function announcedNames(session: Session): Set<string> {
  const names = new Set<string>()
  for (const message of session.deriveMessages()) {
    if (message.role !== 'developer' || message.source.kind !== ACTIVATOR_SOURCE_KIND)
      continue
    for (const block of message.content) {
      if (block.type === 'tool-addition')
        names.add(block.toolName)
    }
  }
  return names
}

export function installToolActivator(ctx: Context, config: ToolActivatorConfig): void {
  const lifetime = new AbortController()
  const executions = new Map<ToolExecutionToken, ActivationExecution>()
  const receipts = new Map<string, PtcReceipt>()
  const announcements = new Map<string, AnnouncementState>()
  const hiding = createToolHiding(ctx)
  /** Publishes the tool catalog as this plugin's own message. */
  const publisher = createCatalogPublisher()
  /** Releases committed but not yet folded back into the projection. */
  const releasedBaseline = new WeakMap<Agent, { identifiers: Set<string>, names: Set<string> }>()
  /** Deactivate calls issued, waiting for their result to commit. */
  const deactivations = new Map<ToolExecutionToken, { agent: Agent, plan: ReleasePlan, reason: string }>()
  /** Release records committed but not yet published with the catalog. */
  const pendingReleased = new WeakMap<Agent, ReleasedEntry[]>()
  /** The idle clocks of live sessions, folded incrementally from their logs. */
  const idleClocks = new WeakMap<Session, IdleClock>()
  // An agent's enabled set only grows: activations are permanent, and the catalog
  // that feeds this reads a projection the commit folds on its own schedule. Without
  // the union, an assembly that runs before that fold would re-hide the tool the
  // commit just declared — visible as "I activated it and it disappeared".
  const enabledSeen = new WeakMap<Agent, Set<string>>()
  /**
   * The tools this plugin presents for one agent: every catalog name it manages,
   * and the subset the session may call. The guard reads both, so a tool the gate
   * only deferred is still refused at execution until its activation commits.
   */
  const gateState = new WeakMap<Agent, { managed: ReadonlySet<string>, enabled: ReadonlySet<string> }>()
  /**
   * Whether this agent's route can load a deferred declaration mid-conversation.
   * Only CONCLUSIVE answers are cached: an absent entry means the probe has not
   * answered yet (llm not ready, request context missing, or a transient probe
   * failure) and is re-asked on every resolve. An entry stays once written —
   * a route's capability does not change mid-session.
   */
  const routeUpdates = new WeakMap<Agent, boolean>()
  /** 探测失败只告警一次：provider/model、llm、解析错误各记各的，避免刷屏。 */
  const routeProbeWarnings = new Set<string>()
  /**
   * The agent each assembled session belongs to. `step/start` is the one moment a
   * deferred activation can be announced: the step is open, the request has not
   * been built yet, and the message lands after the previous step's tool result
   * instead of in the middle of the committing step's own result stream.
   */
  const sessionAgents = new WeakMap<Session, Agent>()
  const assembledSessions = new WeakSet<Session>()

  /**
   * Present the enabled tools for one agent, never re-hiding what it already saw.
   * The merged set is returned: the prompt has to present exactly what the gate
   * lets the model call, or a tool the gate keeps would be offered as inactive.
   */
  function applyHiding(agent: Agent, catalog: ToolCatalogItem[], enabled: ReadonlySet<string>, policy: ToolPolicy): Set<string> {
    const previous = enabledSeen.get(agent)
    const merged = new Set(enabled)
    if (previous !== undefined) {
      for (const name of previous)
        merged.add(name)
    }
    // 释放是权威口径：基线里的名字从并集里再次减掉。「已见不再隐藏」本意
    // 是防激活后的装配抢跑，但同样的合并会把刚释放的工具加回模型面与目录
    // （P6）——账目、目录、模型面必须吃同一份状态。
    for (const name of releasedBaseline.get(agent)?.names ?? [])
      merged.delete(name)
    enabledSeen.set(agent, merged)
    gateState.set(agent, { managed: new Set(catalog.flatMap(entry => entry.tools.map(tool => tool.name))), enabled: merged })
    // What stays declared without deferral is the configuration's decision, not
    // this session's: the head must not move when an activation commits.
    hiding.setImmediate(agent, immediateToolNames(policy))
    hiding.sync(agent, catalog, merged)
    return merged
  }

  /**
   * Whether this route reads tool declarations that change mid-conversation.
   *
   * On such a route every tool can stay declared, so the request head never
   * changes and the provider keeps its cached prefix; an activation then only
   * appends a `tool_addition`. A route without the capability must fall back to
   * the filtered presentation, which is the only shape that withholds a schema
   * there.
   */
  async function routeSupportsUpdates(agent: Agent): Promise<boolean> {
    const known = routeUpdates.get(agent)
    if (known !== undefined)
      return known
    const supported = await supportsToolAdditions(agent)
    // 能力未知（探测早于 llm 注册、请求上下文缺失、或解析抛错）：本步按
    // filter 兜底，但不缓存——下一步重新探测。只有明确结论才落缓存。
    if (supported === undefined) {
      hiding.setMode(agent, 'filter')
      return false
    }
    routeUpdates.set(agent, supported)
    hiding.setMode(agent, supported && hiding.installed ? 'defer' : 'filter')
    return supported
  }

  // Latched from the first assembly: hosts that own tool declarations hand the
  // waterfall a presentation without them, and only those need hiding by
  // restriction. `undefined` means no assembly has revealed the host yet.
  let declarationsOwned: boolean | undefined
  // Learn the host's declaration contract once, before any agent exists: whether the
  // waterfall still receives `tools` decides if hiding is even needed, and the first
  // turn has to know it too. A scope-less assembly is enough to tell.
  const probe = ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    declarationsOwned ??= Array.isArray((assembly as AssembledPrompt).tools)
    return next()
  }, { prepend: true })
  void Promise.resolve()
    .then(async () => ctx.systemPrompt.assemble({}))
    .catch(() => { })
    .finally(() => probe())
  // A step resolves its tool set BEFORE it assembles, so an agent that already
  // existed when this plugin loaded (a restored session) would spend its first
  // step with every tool admitted — the assembly hook then narrows them, which is
  // the one-step-late "tools added, then removed" flicker. Resolving the
  // allow-list inside the admission instead makes the first resolution correct no
  // matter who created the agent or when this plugin loaded.
  hiding.setGateResolver(async (agent) => {
    if (declarationsOwned === true)
      return
    const policy = policySnapshot()
    const catalog = catalogOf(agent, policy)
    // The route decides the presentation, and the admission awaits it: a step
    // that resolved before the capability was known would declare a filtered head
    // and then switch, which is exactly the one change this gate must not make.
    await routeSupportsUpdates(agent)
    applyPassiveRelease(agent, policy, catalog, activatedHistoryOf(agent))
    applyHiding(agent, catalog, effectiveEnabled(agent, catalog, policy, activatedHistoryOf(agent)), policy)
  })
  // A deferred declaration is only offered to the model once its activation
  // commits. Until then the tool is still in the admission — that is what keeps
  // the head stable — so execution is where an inactive tool has to be refused.
  ctx.effect(() => ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined)
      return undefined
    const state = gateState.get(agent)
    if (state === undefined || !state.managed.has(exec.name) || state.enabled.has(exec.name))
      return undefined
    return `Tool "${exec.name}" is installed but not activated in this session. Call ${ACTIVATOR_TOOL_NAME} with its identifier first, then call it again.`
  }))
  let approval: Context['approval'] | undefined
  let skills: Context['skills'] | undefined
  ctx.inject(['approval'], (owner) => {
    const service = owner.approval
    approval = service
    owner.effect(() => () => {
      if (approval === service)
        approval = undefined
    })
  })
  ctx.inject(['skills'], (owner) => {
    const service = owner.skills
    skills = service
    owner.effect(() => () => {
      if (skills === service)
        skills = undefined
    })
  })
  const tool = createActivatorTool(execute)
  tool.finalizeContent = finalize
  const groupingTool = createGroupingTool(executeGrouping)
  const deactivatorTool = createDeactivatorTool(executeDeactivate)
  deactivatorTool.finalizeContent = finalizeDeactivate

  ctx.effect(() => () => {
    lifetime.abort()
    executions.clear()
    receipts.clear()
    deactivations.clear()
    announcements.clear()
  })
  ctx.sessionProjections.register({
    key: ACTIVATION_PROJECTION_KEY,
    stateSchema: activationHistorySchema,
    stateVersion: ACTIVATION_VERSION,
    init: emptyActivationHistory,
    apply: foldActivationEvent,
  })
  ctx.tools.register(tool)
  ctx.tools.register(groupingTool)
  ctx.tools.register(deactivatorTool)
  provideToolActivatorRemote(ctx, policySnapshot)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const policy = policySnapshot()
    if (!context.agent)
      return assembly
    const agent = requireAgent(context.agent)
    sessionAgents.set(agent.session, agent)
    assembledSessions.add(agent.session)
    if (context.scope !== agent)
      throw new Error('dsh-tool-activator requires the exact agent scope for prompt assembly')
    context.signal?.throwIfAborted()
    // `tools` rides along only on hosts that still let this waterfall own the
    // declarations; newer hosts merge the provider-owned schemas afterwards.
    const ownsDeclarations = Array.isArray((assembly as AssembledPrompt).tools)
    declarationsOwned = ownsDeclarations
    const catalog = catalogOf(agent, policy)
    const history = historyOf(agent)
    const computed = effectiveEnabled(agent, catalog, policy, history)
    if (ctx.tools.get(ACTIVATOR_TOOL_NAME, agent) === undefined) {
      // Nothing named activate_tools is visible in this scope — a restriction
      // denied it or the host never exposed it. Hiding the discoverable tools
      // would then hand the model a directory it cannot act on, so present the
      // untouched assembly instead. A scope-local registration of the same name
      // merely shadows ours, and filtering stays correct there because the model
      // still has something to call under that name.
      return assembly
    }
    // The route decides how an inactive tool leaves the model's face, and the
    // decision has to be made before the gate presents this step: the head only
    // stays stable when every declaration can be deferred instead of dropped.
    // The passive policy is decided before the enabled set is computed, so what
    // it reclaims leaves the model face in this very step.
    applyPassiveRelease(agent, policy, catalog, history)
    const appending = await routeSupportsUpdates(agent)
    // On a host that owns the declarations the gate is what presents an inactive
    // tool, so the prompt reads exactly what the gate presents; a host that still
    // hands over the declarations filters them here instead.
    const enabled = ownsDeclarations ? computed : applyHiding(agent, catalog, computed, policy)
    if (!ownsDeclarations && !hiding.installed)
      reportMissingAdmission()
    const instructions = enabled.has('skill') && ctx.tools.get('skill', agent)
      ? history.activatedSkills.flatMap(skill => skill.instructions === undefined ? [] : [skill.instructions])
      : []
    const sdk = assembly.sections.some(section => section.name === 'tools:sdk' && section.text.length > 0)
      ? await renderSdk(agent, ctx.tools.schemas(agent).filter(schema => schema.name !== 'run_code' && enabled.has(schema.name)))
      : undefined
    const prepared = preparePromptAssembly(assembly, catalog, policy, enabled, sdk, instructions, appending)
    // 释放记录只取走一次：滞留的话每步都会触发目录重发。真正的发布在
    // agent/pre-step 里并入本步的 decision.messages——宿主准入时并入的消息
    // 会进历史，下一次装配才能读回，publisher 的「内容不变不重发」守卫按
    // 设计生效；在装配钩子里 append 的消息本步快照看不到，守卫必然失配。
    // pendingReleased 这里只读快照、不取走：非请求路径的装配（统计、预览）
    // 之后并没有 pre-step publish 跟随，提前删除会让释放记录在发布前丢失
    // （实测：目录更新了但 <released_tools> 段没出现）。清空发生在 pre-step
    // 的 publish 确认之后。
    publisher.prepare(agent, { ...prepared.catalog, released: pendingReleased.get(agent) ?? [] })
    if (appending)
      announce(agent, enabled, policy)
    // PreparedPrompt 的 assembly 把声明列表留成可选（0.2.2 起声明归宿主），
    // 而这条瀑布的契约仍要一份完整列表：与 filter 时代一样在此收窄类型。
    return prepared.assembly as PromptAssembly
  })
  // 装配过的会话与已准入的会话分开记账：step/start 时前者有后者无，说明
  // 宿主没有准入瀑布，目录到不了模型——显式报出来而不是静默少注入。
  const admittedSessions = new WeakSet<Session>()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted)
      return decision
    admittedSessions.add(payload.agent.session)
    const message = publisher.publish(payload.agent)
    if (message === undefined)
      return decision
    // 发布确认后才清空释放记录：非请求装配只 prepare 不 publish，记录得以
    // 存活到真正随目录发出的那一步（P6 实测丢失路径）。
    pendingReleased.delete(payload.agent)
    return { ...decision, messages: [...decision.messages, message] }
    return { ...decision, messages: [...decision.messages, message] }
  })
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const content = await next()
    const record = receipts.get(dispatch.subCallId)
    if (!record)
      return content
    receipts.delete(dispatch.subCallId)
    if (dispatch.isError || dispatch.name !== ACTIVATOR_TOOL_NAME || dispatch.agent !== record.agent
      || dispatch.exec.token !== record.parent || dispatch.exec.rootCallId !== record.rootCallId
      || lifetime.signal.aborted || ctx.agents.get(record.agent.id) !== record.agent) {
      return content
    }
    return activationContent(record.receipt)
  }, { prepend: true })
  ctx.on('tools/result', (exec) => {
    executions.delete(exec.token)
    for (const [callId, record] of receipts) {
      if (record.parent === exec.token)
        receipts.delete(callId)
    }
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    hiding.forget(agent)
    publisher.forget(agent)
    clearAgent(agent)
  })
  ctx.on('session/event', (session, event) => {
    const state = announcements.get(session.id)
    if (state)
      foldAnnouncement(state, event)
    // 宿主先跑准入瀑布再开 step：装配过却没有准入记录 = 目录到不了模型。
    if (event.type === 'step/start' && sessionAgents.has(session) && !admittedSessions.has(session))
      reportMissingAdmission()
    // The idle clock follows the log: a session that is still running folds the
    // events as they land, and a restored one is folded from its log at once.
    const clock = idleClocks.get(session)
    if (clock)
      foldIdleEvent(clock, event)
    // A host that defers keeps every declaration in place, so the activation is
    // announced here: the step just opened, its request has not been built, and a
    // `tool_addition` is exactly what turns the deferred declaration into a
    // callable tool. The head never changes, so the cached prefix survives.
    if (event.type === 'step/start') {
      const agent = sessionAgents.get(session)
      const gate = agent === undefined ? undefined : gateState.get(agent)
      if (agent !== undefined && gate !== undefined && routeUpdates.get(agent) === true)
        announce(agent, gate.enabled, policySnapshot())
    }
    if (event.type !== 'turn/end')
      return
    for (const [token, value] of executions) {
      if (value.agent.session === session)
        executions.delete(token)
    }
    for (const [callId, value] of receipts) {
      if (value.agent.session === session)
        receipts.delete(callId)
    }
  })

  /**
   * The enabled set the session actually holds: the policy/history function
   * minus what a committed-but-not-yet-folded release took out. The baseline
   * closes the gap between the commit and the projection catching up.
   */
  function effectiveEnabled(agent: Agent, catalog: ToolCatalogItem[], policy: ToolPolicy, history: ActivationHistory): Set<string> {
    const enabled = enabledToolNames(catalog, policy, history.activatedToolIds, history.activatedToolNames)
    const released = releasedBaseline.get(agent)
    if (released !== undefined) {
      for (const name of released.names)
        enabled.delete(name)
    }
    return enabled
  }

  function policySnapshot(): ToolPolicy {
    const policy = config.get()
    validatePolicy(policy)
    return policy
  }

  function requireAgent(agent: Agent | undefined): Agent {
    if (lifetime.signal.aborted || !agent || ctx.agents.get(agent.id) !== agent)
      throw new Error('dsh-tool-activator requires an exact live agent')
    return agent
  }

  /**
   * Whether this route reads tool declarations that change mid-conversation.
   * Routes without the capability must keep an exactly-filtered declaration
   * list: deferring there would either leak every hidden schema or hide a tool
   * the model can never load.
   */
  function warnRouteProbeOnce(agent: Agent, kind: string, detail: string): void {
    const key = `${agent.id}:${kind}`
    if (routeProbeWarnings.has(key))
      return
    routeProbeWarnings.add(key)
    ctx.logger.warn({ type: 'warn', scope: agent }, 'route capability probe unavailable (%s): %s — staying on the filtered presentation for this step and re-probing next step', kind, detail)
  }

  async function supportsToolAdditions(agent: Agent): Promise<boolean | undefined> {
    // Options are known before the first request; the logged request context
    // only appears after it, and the very first request must already carry the
    // stable declaration list.
    const route = agent.session.requestContext()
    const provider = agent.options.provider ?? route?.provider
    const model = agent.options.model ?? route?.model
    const llm = ctx.get('llm')
    // 三类「能力未知」各告警一次：本步按 filter 兜底，但不缓存——否则首次
    // 探测早于 llm 注册会把会话永久锁死在 filter，缓存前缀白白失效。
    if (!provider || !model) {
      warnRouteProbeOnce(agent, 'no-route', `provider=${String(provider)} model=${String(model)}`)
      return undefined
    }
    if (!llm) {
      warnRouteProbeOnce(agent, 'no-llm', 'the llm service has not registered yet')
      return undefined
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      return info.toolUpdate !== undefined
    }
    catch (error) {
      warnRouteProbeOnce(agent, 'probe-failed', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /**
   * Announce newly enabled tools after the cached history. One `tool_addition`
   * loads a deferred declaration without touching the request head, so the
   * provider's cached prefix survives.
   */
  function announce(agent: Agent, enabled: ReadonlySet<string>, policy: ToolPolicy): void {
    const session = agent.session
    const state = announcementState(session)
    if (state.headerSeq === undefined || !state.stepOpen)
      return
    const immediate = immediateToolNames(policy)
    const candidates = [...enabled].filter(name => !immediate.has(name) && state.headerTools.has(name))
    if (candidates.length === 0)
      return
    const announced = announcedNames(session)
    const pending = candidates.filter(name => !announced.has(name))
    if (pending.length === 0)
      return
    session.append('developer/message', {
      turn: state.turn,
      step: state.step,
      headerSeq: state.headerSeq,
      message: createDeveloperMessage({
        source: { kind: ACTIVATOR_SOURCE_KIND },
        content: pending.map(name => ({ type: 'tool-addition' as const, toolName: name })),
      }),
    }, { surfaceOp: 'append' })
  }

  function announcementState(session: Session): AnnouncementState {
    const existing = announcements.get(session.id)
    if (existing)
      return existing
    const created: AnnouncementState = { headerTools: new Set(), turn: 0, step: 0, stepOpen: false }
    for (const event of session.snapshotEvents())
      foldAnnouncement(created, event)
    announcements.set(session.id, created)
    return created
  }

  function requiresApproval(agent: Agent, policy: ToolPolicy): boolean {
    return policy.requireApproval && ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode !== 'danger-full-access'
  }

  function requireExecution(agent: Agent, record: ActivationExecution, signal: AbortSignal): ToolPolicy {
    signal.throwIfAborted()
    requireAgent(agent)
    const policy = policySnapshot()
    if ((requiresApproval(agent, policy) && !record.approved) || ctx.tools.get(ACTIVATOR_TOOL_NAME, agent) !== tool)
      throw new Error('Tool activation is disabled or its configuration changed before the request could commit')
    return policy
  }

  /**
   * The idle clock of one session.
   *
   * The clock is folded from the log, so a session that was restored continues
   * with the clock its log describes instead of starting over.
   */
  function idleClockOfSession(session: Session): IdleClock {
    const existing = idleClocks.get(session)
    if (existing)
      return existing
    const clock = idleClockOf(session.snapshotEvents())
    idleClocks.set(session, clock)
    return clock
  }

  function historyOf(agent: Agent): ActivationHistory {
    const history = ctx.sessionProjections.stateOf(agent.session, ACTIVATION_PROJECTION_KEY)
    if (!history)
      throw new Error('dsh-tool-activator activation projection is unavailable')
    return history
  }

  /**
   * The activation history this session recovered. An empty history is the safe
   * answer: the gate then hides what was never activated, and the next assembly
   * widens it from the recovered history.
   */
  function activatedHistoryOf(agent: Agent): ActivationHistory {
    try {
      return historyOf(agent)
    }
    catch {
      return emptyActivationHistory()
    }
  }

  function catalogOf(agent: Agent, policy: ToolPolicy): ToolCatalogItem[] {
    return buildToolCatalog(ctx.tools.schemas(agent), policy)
  }

  async function renderSdk(agent: Agent, candidates: ReturnType<Context['tools']['schemas']>): Promise<string> {
    const { renderToolsSdk, renderToolsSdkPy } = await loadToolSdkRenderers()
    const schemas: Parameters<typeof renderToolsSdk>[0] = []
    for (const schema of candidates) {
      if (schema.name === 'run_code')
        continue
      const definition = ctx.tools.get(schema.name, agent)
      if (definition)
        schemas.push({ ...schema, output: definition.output.schema })
    }
    const language = ctx.get('ptcRuntime')?.language
    if (language === 'typescript')
      return renderToolsSdk(schemas)
    if (language === 'python')
      return renderToolsSdkPy(schemas)
    throw new Error(`dsh-tool-activator cannot present the PTC SDK for language ${String(language)}`)
  }

  async function lookupOptions(agent: Agent, signal: AbortSignal): Promise<SkillViewOptions> {
    const directory = ctx.get('workingDirectory') as DirectoryCapability | undefined
    const cwd = directory && typeof directory.ensure === 'function'
      ? await directory.ensure(agent, signal)
      : agent.session.header.cwd
    signal.throwIfAborted()
    requireAgent(agent)
    return { scope: agent, signal, ...(cwd === undefined ? {} : { cwd }) }
  }

  async function loadSkill(service: Context['skills'], name: string, options: SkillViewOptions): Promise<SkillDefinition | undefined> {
    const summary = (await service.list(options)).find(skill => skill.name === name && skill.invocation.modelInvocable)
    if (!summary || skills !== service)
      return undefined
    const definition = await service.get(name, options)
    return definition?.invocation.modelInvocable ? definition : undefined
  }

  async function execute(args: ActivateToolsParams, exec: ToolRunContext): Promise<ActivationEnvelope> {
    const agent = requireAgent(exec.agent)
    const signal = AbortSignal.any([exec.signal, lifetime.signal])
    signal.throwIfAborted()
    const initialPolicy = policySnapshot()
    if (ctx.tools.get(ACTIVATOR_TOOL_NAME, agent) !== tool)
      throw new Error('Tool activation is disabled by the current plugin configuration or scope')
    const record: ActivationExecution = { agent, identifiers: new Set(args.identifiers), approved: false }
    executions.set(exec.token, record)
    if (requiresApproval(agent, initialPolicy)) {
      const approver = approval
      if (!approver)
        throw new Error('Tool activation requires approval, but the approval service is unavailable')
      const outcome = await approver.request({ agent, toolName: ACTIVATOR_TOOL_NAME, callId: exec.callId, reason: args.reason, signal })
      signal.throwIfAborted()
      if (outcome !== 'allowed-once' || approval !== approver)
        throw new Error(`Tool activation was not approved (${outcome})`)
      record.approved = true
    }
    const policy = requireExecution(agent, record, signal)
    const catalog = catalogOf(agent, policy)
    const history = historyOf(agent)
    const enabled = effectiveEnabled(agent, catalog, policy, history)
    const active = catalog.filter(entry => entry.tools.every(schema => enabled.has(schema.name))).map(entry => entry.identifier)
    const skillDefinition = ctx.tools.get('skill', agent)
    const skillService = skills
    let skillCall = 0
    const runtime = new ActivatorExecutionRuntime({
      getActivatedToolIds: () => active,
      getToolManifests: async identifiers => catalog.filter(entry => identifiers.includes(entry.identifier)),
      markActivated: () => {},
      ...(enabled.has('skill') && skillDefinition && skillService
        ? {
            activateSkill: async ({ name }: { name: string }): Promise<ActivationResult> => {
              const options = await lookupOptions(agent, signal)
              const skill = await loadSkill(skillService, name, options)
              const current = requireExecution(agent, record, signal)
              const currentEnabled = enabledToolNames(catalogOf(agent, current), current, historyOf(agent).activatedToolIds, historyOf(agent).activatedToolNames)
              if (!skill || !currentEnabled.has('skill') || ctx.tools.get('skill', agent) !== skillDefinition || skills !== skillService)
                return { content: `Skill ${name} is not available.`, success: false }
              const result = await ctx.tools.execute({
                agent,
                name: 'skill',
                callId: ToolCallId(`${exec.callId}:skill:${++skillCall}`),
                rootCallId: exec.rootCallId,
                parent: exec.token,
                arguments: { name },
                signal,
              })
              requireExecution(agent, record, signal)
              if (result.isError)
                return { content: result.error.message, success: false }
              const instructions = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')
              return {
                content: `Skill ${name} activated. Usage instructions for the activated items are in the system prompt.`,
                success: true,
                state: {
                  id: skill.name,
                  name: skill.name,
                  description: skill.description,
                  source: skill.source,
                  title: skill.name,
                  hasResources: skill.resourceBase !== undefined,
                  provider: skill.provider,
                  instructions,
                },
              }
            },
          }
        : {}),
    })
    const result = activationEnvelope(await runtime.activateTools(args))
    requireExecution(agent, record, signal)
    return result
  }

  /**
   * Whether an applied batch changed anything at all. A batch that changed
   * nothing has no reason to be written back into the configuration.
   */
  function changedAnything(receipt: GroupApplyReceipt): boolean {
    return receipt.created.length > 0 || receipt.updated.length > 0
      || receipt.removed.length > 0 || receipt.renamed.length > 0
  }

  /**
   * The tool names a rename or a removal would drop from the activation account.
   *
   * A group identifier dies with the group, so a session that activated the group
   * loses its claim on the members once the group is renamed or removed. The names
   * travel with the result instead: the session log folds them into the account,
   * and the tools the session already had stay callable.
   */
  function migrationNames(facts: GroupingFacts, receipt: GroupApplyReceipt, history: ActivationHistory): string[] {
    const targets = [...receipt.renamed.map(item => item.from), ...receipt.removed]
    const known = new Set(history.activatedToolNames ?? [])
    const names: string[] = []
    for (const identifier of targets) {
      if (!history.activatedToolIds.includes(identifier))
        continue
      const group = facts.groups.find(entry => entry.identifier === identifier)
      if (!group)
        continue
      for (const tool of group.tools) {
        if (!known.has(tool)) {
          known.add(tool)
          names.push(tool)
        }
      }
    }
    return names
  }

  /**
   * Read the grouping state of the current scope, or write a batch of group
   * edits into the plugin's own configuration.
   *
   * The batch is all-or-nothing: a rejected batch answers with every problem it
   * has and writes nothing, and an accepted batch is written as one conditional
   * document mutation.
   */
  async function executeGrouping(args: GroupingToolParams, exec: ToolRunContext): Promise<GroupingToolResult> {
    const agent = requireAgent(exec.agent)
    const signal = AbortSignal.any([exec.signal, lifetime.signal])
    signal.throwIfAborted()
    const policy = policySnapshot()
    const catalog = catalogOf(agent, policy)
    const facts: GroupingFacts = {
      groups: policy.groups,
      tools: catalog.flatMap(entry => entry.tools.map(tool => tool.name)),
      basicTools: policy.basicTools,
      lockedTools: LOCKED_TOOL_NAMES,
    }
    if (args.action !== 'apply')
      return { action: 'list', ...groupingSnapshot(facts) }
    // `apply` without an operation is a malformed call, not a no-op: answering
    // with an empty receipt would tell the model it changed something it did not.
    if ((args.ops ?? []).length === 0)
      throw new Error('The "apply" action needs at least one operation in "ops"; no change was made.')
    const outcome = applyGroupOps(facts, args.ops ?? [])
    if (outcome.problems.length > 0)
      return { action: 'apply', problems: outcome.problems }
    // The members of a renamed or removed group would drop out of the account with
    // the identifier that died with the group, so they travel with the result and
    // the session log folds them back in.
    const migrated = migrationNames(facts, outcome.receipt, activatedHistoryOf(agent))
    // A batch that changed nothing is not written back: the write is a
    // read-modify-write of the whole document, and rewriting it unchanged
    // could only overwrite what the user changed in the meantime. The names still
    // travel: they are the only thing such a call has to account for.
    if (!changedAnything(outcome.receipt))
      return { action: 'apply', receipt: outcome.receipt, ...(migrated.length > 0 ? { migrated } : {}) }
    const service = settingsServiceOf(ctx)
    if (!service) {
      throw new Error('dsh-tool-activator cannot write tool groups: this host does not provide the settings service, so no change was made. Ask the user to edit the groups in the tool activator settings.')
    }
    const ns = settingsNamespaceOf(ctx)
    if (!ns) {
      throw new Error('dsh-tool-activator cannot write tool groups: this plugin instance has no settings namespace, so no change was made. Ask the user to edit the groups in the tool activator settings.')
    }
    signal.throwIfAborted()
    // The always-loaded set is written in the same mutation as the groups, but
    // only when this batch actually touched it.
    const basicChanged = outcome.receipt.updated.includes(BASIC_GROUP_IDENTIFIER)
    await writeGroups(service, ns, outcome.next, signal, basicChanged ? outcome.nextBasicTools : undefined)
    return { action: 'apply', receipt: outcome.receipt, ...(migrated.length > 0 ? { migrated } : {}) }
  }

  /**
   * Lift a release: the session activated the entry again, so the tools it
   * brings back are enabled again.
   */
  function liftReleased(agent: Agent, identifier: string, names: readonly string[]): void {
    const baseline = releasedBaseline.get(agent)
    if (baseline !== undefined) {
      baseline.identifiers.delete(identifier)
      for (const name of names)
        baseline.names.delete(name)
    }
    // A record that names a tool the session holds again would take it away on
    // the next fold: the lift shrinks the pending records along with the base.
    const pending = pendingReleased.get(agent)
    if (pending !== undefined) {
      const kept: ReleasedEntry[] = []
      for (const entry of pending) {
        if (entry.identifier === identifier)
          continue
        const remaining = entry.names.filter(name => !names.includes(name))
        if (remaining.length === 0)
          continue
        kept.push({ ...entry, names: remaining })
      }
      pendingReleased.set(agent, kept)
    }
  }

  async function executeDeactivate(args: DeactivateToolsParams, exec: ToolRunContext): Promise<ReleaseReceipt> {
    const agent = requireAgent(exec.agent)
    const signal = AbortSignal.any([exec.signal, lifetime.signal])
    signal.throwIfAborted()
    const policy = policySnapshot()
    if (ctx.tools.get(DEACTIVATOR_TOOL_NAME, agent) !== deactivatorTool)
      throw new Error('Tool release is disabled by the current plugin configuration or scope')
    const catalog = catalogOf(agent, policy)
    const plan = planRelease({ catalog, policy, history: historyOf(agent), released: releasedBaseline.get(agent) }, args.identifiers)
    deactivations.set(exec.token, { agent, plan, reason: args.reason })
    return releaseReceipt(plan)
  }

  /**
   * Turn the release the model asked for into the commit it stands for: the
   * baseline takes the entries out of the enabled set and the gate narrows
   * right away; the result the log carries is what the projection folds.
   */
  function applyPassiveRelease(agent: Agent, policy: ToolPolicy, catalog: ToolCatalogItem[], history: ActivationHistory): void {
    if (!policy.passiveRelease.enabled)
      return
    const released = releasedBaseline.get(agent)
    const facts: SessionAccount = { catalog, policy, history, clock: idleClockOfSession(agent.session), released }
    const idle = planIdleRelease(facts)
    // The cap counts what the session holds once the idle entries have left:
    // both batches are committed together, so the count must not ask for them twice.
    const cap = planCapRelease({ ...facts, excluded: idle.map(candidate => candidate.identifier) })
    const reasons = new Map<string, ReleaseReason>()
    for (const candidate of idle) {
      reasons.set(candidate.identifier, { kind: 'idle', text: `idle ${candidate.idleTurns} turns` })
    }
    for (const candidate of cap) {
      // An entry that is idle anyway keeps the reason that describes it.
      if (!reasons.has(candidate.identifier))
        reasons.set(candidate.identifier, { kind: 'cap', text: 'cap exceeded' })
    }
    if (reasons.size === 0)
      return
    const plan = planRelease({ catalog, policy, history, released }, [...reasons.keys()])
    if (plan.released.length === 0)
      return
    const entries = plan.released.flatMap((entry) => {
      const reason = reasons.get(entry.identifier)
      return reason === undefined ? [] : [{ identifier: entry.identifier, names: entry.names, reason }]
    })
    commitRelease(agent, entries, policy, history)
    // The policy runs behind the model's back, so the log is the only place the
    // user learns what happened.
    for (const entry of entries) {
      ctx.logger.info({ type: 'info', scope: agent }, 'session %s released %s [%s]: %s', agent.session.id, entry.identifier, entry.names.join(','), entry.reason.text)
    }
  }

  /**
   * Commit one release: the tools leave the session's enabled set, the gate is
   * narrowed right away, and the records wait for the next catalog to carry
   * them to the model and into the log.
   *
   * The active release and the passive policy commit the same way: one shape of
   * record, one place the enabled set shrinks.
   */
  function commitRelease(
    agent: Agent,
    entries: ReadonlyArray<ReleasedEntry>,
    policy: ToolPolicy,
    history: ActivationHistory,
  ): void {
    const baseline = releasedBaseline.get(agent) ?? { identifiers: new Set<string>(), names: new Set<string>() }
    const pending = pendingReleased.get(agent) ?? []
    for (const entry of entries) {
      baseline.identifiers.add(entry.identifier)
      for (const name of entry.names)
        baseline.names.add(name)
      pending.push({ identifier: entry.identifier, names: [...entry.names], reason: entry.reason })
    }
    releasedBaseline.set(agent, baseline)
    pendingReleased.set(agent, pending)
    // The next step resolves its tool set before the assembly hook runs, so the
    // gate is narrowed on the commit: the released tools leave the model face
    // on the very next step.
    const catalog = catalogOf(agent, policy)
    applyHiding(agent, catalog, effectiveEnabled(agent, catalog, policy, history), policy)
  }

  function finalizeDeactivate(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined {
    if (result.isError)
      return undefined
    try {
      const issued = deactivations.get(exec.token)
      const agent = requireAgent(exec.agent)
      if (!issued || issued.agent !== agent || exec.signal.aborted || ctx.tools.get(DEACTIVATOR_TOOL_NAME, agent) !== deactivatorTool)
        return [{ type: 'text', text: 'Tool release was not committed because the live scope or configuration changed. Retry after checking the current tool catalog.' }]
      const receipt = releaseReceipt(issued.plan)
      const policy = policySnapshot()
      // The same executor the passive policy uses: one shape of record, one
      // place the enabled set shrinks.
      commitRelease(agent, issued.plan.released.map(entry => ({
        identifier: entry.identifier,
        names: entry.names,
        reason: { kind: 'active' as const, text: issued.reason },
      })), policy, historyOf(agent))
      return releaseContent(receipt)
    }
    catch {
      return [{ type: 'text', text: 'Tool release was not committed because its final state could not be validated. Retry after checking the current tool catalog.' }]
    }
  }

  function finalize(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined {
    if (result.isError)
      return undefined
    try {
      const issued = executions.get(exec.token)
      const agent = requireAgent(exec.agent)
      const policy = policySnapshot()
      if (!issued || issued.agent !== agent || exec.signal.aborted
        || (requiresApproval(agent, policy) && !issued.approved) || ctx.tools.get(ACTIVATOR_TOOL_NAME, agent) !== tool) {
        return [{ type: 'text', text: 'Tool activation was not committed because the live scope, approval, or configuration changed. Retry after checking the current tool catalog.' }]
      }
      const activation = parseActivation(result.value)
      if (!activation?.success)
        return undefined
      const catalog = catalogOf(agent, policy)
      const available = new Set(catalog.map(item => item.identifier))
      const enabled = enabledToolNames(catalog, policy, historyOf(agent).activatedToolIds, historyOf(agent).activatedToolNames)
      const accepted: ActivationEnvelope = {
        ...activation,
        state: {
          ...activation.state,
          activatedTools: activation.state.activatedTools.filter(item => issued.identifiers.has(item.identifier) && available.has(item.identifier)),
          activatedSkills: activation.state.activatedSkills.filter(item => issued.identifiers.has(item.name) && enabled.has('skill') && ctx.tools.get('skill', agent)),
        },
      }
      for (const entry of accepted.state.activatedTools) {
        // 回执不带成员名单（defer 时代声明恒定，名字由目录给出）：用目录成员
        // 兜底，否则基线里的名字会一直压着重新激活的工具。
        const members = catalog.filter(item => item.identifier === entry.identifier).flatMap(item => item.tools.map(tool => tool.name))
        liftReleased(agent, entry.identifier, entry.tools ?? members)
      }
      const history = mergeActivation(historyOf(agent), accepted)
      const receipt: ActivationReceipt = {
        ...accepted,
        authorized: true,
        approvalRequired: requiresApproval(agent, policy),
        commit: {
          producer: ACTIVATION_PRODUCER,
          version: ACTIVATION_VERSION,
          callId: exec.callId,
          activatedToolIds: history.activatedToolIds.filter(id => available.has(id)),
          activatedSkills: history.activatedSkills,
        },
      }
      if (exec.parent)
        receipts.set(exec.callId, { agent, parent: exec.parent, rootCallId: exec.rootCallId, receipt })
      return activationContent(receipt)
    }
    catch {
      return [{ type: 'text', text: 'Tool activation was not committed because its final state could not be validated. Retry after checking the current tool catalog.' }]
    }
  }

  function clearAgent(agent: Agent): void {
    for (const [token, value] of executions) {
      if (value.agent === agent)
        executions.delete(token)
    }
    for (const [callId, value] of receipts) {
      if (value.agent === agent)
        receipts.delete(callId)
    }
    announcements.delete(agent.session.id)
  }
}
