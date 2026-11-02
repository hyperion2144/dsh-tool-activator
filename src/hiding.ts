import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCatalogItem } from './types'

interface HidingState {
  restriction?: () => void
  signature?: string
  warned: boolean
  applied?: number
}

export interface ToolHiding {
  /**
   * Hide every catalog tool that is not enabled yet. Recomputed from the catalog on
   * each call, and an unchanged set leaves the installed restriction in place.
   */
  sync: (agent: Agent, catalog: readonly ToolCatalogItem[], enabled: ReadonlySet<string>) => HidingResult
  /** Lift this agent's restriction and forget its state. */
  forget: (agent: Agent) => void
  /** Drop the installed restriction so the next catalog read sees every tool. */
  suspend: (agent: Agent) => void
}

/** What one sync did, so the caller can report it without a logger. */
export interface HidingResult {
  deny: number
  total: number
  installed: boolean
  error?: string
}

/**
 * Hides tool declarations on hosts that own them. From dsh 0.2.2 the assembly
 * waterfall receives a presentation without `tools` and the provider merges the
 * schemas afterwards, so rewriting the assembly hides nothing. The scoped
 * restriction is what remains: it removes the tools from one agent's model
 * surface *and* from its callable set, which is exactly what an un-activated tool
 * should be — discoverable through the directory, not declared.
 */
export function createToolHiding(_ctx: Context): ToolHiding {
  const states = new WeakMap<Agent, HidingState>()

  function stateOf(agent: Agent): HidingState {
    const existing = states.get(agent)
    if (existing !== undefined)
      return existing
    const created: HidingState = { warned: false }
    states.set(agent, created)
    return created
  }

  interface RestrictionAttempt {
    lift?: () => void
    deny: number
    error?: string
  }

  /**
   * The host refuses the whole mask over one scope-local name, but names the
   * offenders; drop them and retry until it accepts what it can restrict.
   */
  function applyRestriction(agent: Agent, candidates: readonly string[]): RestrictionAttempt {
    let pending = [...candidates]
    for (let attempt = 0; attempt < 8 && pending.length > 0; attempt += 1) {
      try {
        return { lift: agent.ctx.tools.restrict({ deny: pending }), deny: pending.length }
      }
      catch (problem) {
        const message = problem instanceof Error ? problem.message : String(problem)
        const listed = /unknown global tools? (.*?); known global tools/u.exec(message)?.[1]
        const rejected = listed === undefined
          ? []
          : [...listed.matchAll(/"([^"]+)"/gu)].map(match => match[1]!)
        if (rejected.length === 0)
          return { deny: pending.length, error: message }
        const drop = new Set(rejected)
        const next = pending.filter(name => !drop.has(name))
        if (next.length === pending.length)
          return { deny: pending.length, error: message }
        pending = next
      }
    }
    return { deny: pending.length, error: pending.length === 0 ? 'no restrictable tools' : 'restriction refused' }
  }
  return {
    sync(agent, catalog, enabled) {
      const state = stateOf(agent)
      const names = catalog
        .flatMap(entry => entry.tools)
        .map(tool => tool.name)
      // Every not-enabled name is a candidate; the host rejects the scope-local
      // ones by name and applyRestriction drops them, so nothing is lost here.
      const candidates = names.filter(name => !enabled.has(name))
      const signature = candidates.join('\u0000')
      if (signature === state.signature)
        return { deny: state.applied ?? candidates.length, total: names.length, installed: state.restriction !== undefined }
      state.restriction?.()
      state.restriction = undefined
      state.signature = signature
      if (candidates.length === 0)
        return { deny: 0, total: names.length, installed: false }
      const applied = applyRestriction(agent, candidates)
      state.applied = applied.deny
      if (applied.lift !== undefined) {
        state.restriction = applied.lift
        return { deny: applied.deny, total: names.length, installed: true }
      }
      if (!state.warned) {
        state.warned = true
        console.warn(`[dsh-tool-activator] cannot hide inactive tools with a scoped restriction: ${applied.error ?? 'unknown error'}`)
      }
      return { deny: applied.deny, total: names.length, installed: false, error: applied.error }
    },
    suspend(agent) {
      const state = states.get(agent)
      if (state === undefined)
        return
      state.restriction?.()
      state.restriction = undefined
      state.signature = undefined
    },
    forget(agent) {
      const state = states.get(agent)
      if (state === undefined)
        return
      state.restriction?.()
      states.delete(agent)
    },
  }
}
