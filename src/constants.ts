import type { ContextForm } from '@deepseek-ai/dsh-llm'

export const ACTIVATOR_TOOL_NAME = 'activate_tools'
export const RUN_CODE_TOOL_NAME = 'run_code'
/**
 * Message source of this plugin's own contributions: the developer messages that
 * declare activated tools and the catalog the model reads about them.
 */
export const ACTIVATOR_SOURCE_KIND = 'tool-activator'

/** The host's own vocabulary for a republished catalog. */
export const CATALOG_FORM = 'catalog' satisfies ContextForm
export const ACTIVATION_PRODUCER = 'dsh-tool-activator'
export const ACTIVATION_VERSION = 1
export const ACTIVATION_PROJECTION_KEY = 'tool-activator:activation'
export const SETTINGS_REMOTE_NAMESPACE = 'toolActivator'

export const FIRST_PARTY_SECTION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'tool:read': ['read'],
  'tool:write': ['write'],
  'tool:edit': ['edit'],
  'tool:glob': ['glob'],
  'tool:grep': ['grep'],
  'tool:bash': ['bash'],
  'tool:pwsh': ['pwsh'],
  'tool:web_search': ['web_search'],
  'tool:web_fetch': ['web_fetch'],
  'tool:jobs': ['job_output', 'job_list', 'job_kill'],
  'tool:pty': ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'],
  'tool:goal': ['get_goal', 'create_goal', 'update_goal'],
  'tool:session-query': ['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read'],
  'tool:lsp': ['lsp'],
  'tool:ralph': ['ralph'],
  'tool:workflow': ['workflow'],
  'tool:structured_output': ['structured_output'],
  'tool:subagent': ['subagent'],
  'tool:subagent_fork': ['subagent_fork'],
}
