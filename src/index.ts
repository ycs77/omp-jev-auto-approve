import type { BashToolInput, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { findScopedSettings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { resolveJudge } from '@oh-my-pi/pi-coding-agent/judgment'

type Safety = 'safe' | 'dangerous' | 'uncertain'

interface SafetyAssessment {
  choice: Safety
  confidence: number
}

type Approval = 'allow' | 'deny' | 'prompt'

interface Decision {
  approval: Approval
  reason?: string
}

const SAFE_CONFIDENCE_THRESHOLD = 0.9

function isJevModel(model: { api: string; provider: string; id: string }): boolean {
  return model.api === 'typesafe' && model.provider === 'typesafe' && /^jev(?:-|$)/.test(model.id)
}

function isBashToolInput(input: unknown): input is BashToolInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'command' in input &&
    typeof input.command === 'string'
  )
}

function isProtocolPath(path: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):(?:(\/\/)|(.+))$/i.exec(path)
  if (!match) return false
  if (match[2]) return true
  // Avoid treating read selectors such as Makefile:12 and README:raw:1-20 as URIs.
  if (match[1].includes('.')) return false
  const selector = /^(?:raw|conflicts|-?\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*)$/i
  return !match[3].split(':').every(part => selector.test(part))
}

function editTargets(input: Record<string, unknown>): string[] | null {
  if (typeof input.input === 'string') {
    const targets: string[] = []
    for (const line of input.input.split(/\r?\n/)) {
      const target =
        /^\[(.+)#[0-9a-f]{4}\]$/i.exec(line)?.[1] ??
        /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)?.[1] ??
        /^\*\*\* Move to: (.+)$/.exec(line)?.[1] ??
        /^MV (.+)$/.exec(line)?.[1]
      if (target) {
        const quoted = /^(['"])(.*)\1$/.exec(target)
        targets.push(quoted ? quoted[2] : target)
      }
    }
    return targets.length ? targets : null
  }

  if (typeof input.path !== 'string' || !input.path) return null
  const targets = [input.path]
  if (input.edits !== undefined) {
    if (!Array.isArray(input.edits)) return null
    for (const edit of input.edits) {
      if (typeof edit !== 'object' || edit === null || Array.isArray(edit)) return null
      if ('rename' in edit) {
        if (typeof edit.rename !== 'string' || !edit.rename) return null
        targets.push(edit.rename)
      }
    }
  }
  return targets
}

function decisionFromSafety(result: SafetyAssessment, tool: string): Decision {
  switch (result.choice) {
    case 'dangerous':
      return {
        approval: 'deny',
        reason: tool === 'bash' ? 'unsafe command' : 'unsafe tool call',
      }

    case 'safe':
      return result.confidence >= SAFE_CONFIDENCE_THRESHOLD
        ? { approval: 'allow' }
        : {
            approval: 'prompt',
            reason: 'low confidence safety assessment',
          }

    case 'uncertain':
      return {
        approval: 'prompt',
        reason: 'safety assessment is uncertain',
      }
  }
}

function matchesAllowedBashPattern(command: string, patterns: unknown): boolean {
  if (!Array.isArray(patterns)) return false

  const normalizedCommand = command.trim().replace(/\s+/gu, ' ')
  if (!normalizedCommand) return false

  for (const rule of patterns as unknown[]) {
    if (
      typeof rule !== 'object' ||
      rule === null ||
      Array.isArray(rule) ||
      !('match' in rule) ||
      !('approval' in rule) ||
      typeof rule.match !== 'string' ||
      typeof rule.approval !== 'string' ||
      rule.approval.trim().toLowerCase() !== 'allow'
    ) {
      continue
    }

    const match = rule.match.trim().replace(/\s+/gu, ' ')
    if (!match) continue
    if (match === normalizedCommand) return true
    if (!match.includes('*')) continue

    const escaped = match
      .split('*')
      .map(part => part.replace(/[\\^$+?.()|[\]{}]/gu, '\\$&'))
      .join('.*')
    if (new RegExp(`^${escaped}$`, 'u').test(normalizedCommand)) return true
  }
  return false
}

interface PermissionRequestEvent {
  sessionId: string
  toolCallId: string
  toolName: string
  reason?: string
}

async function enforce(
  tool: string,
  decision: Decision,
  ctx: ExtensionContext,
  toolCallId: string,
  events: ExtensionAPI['events'],
) {
  if (decision.approval === 'allow') return

  const denied = {
    block: true,
    reason: decision.reason ? `Permission denied: ${decision.reason}.` : 'Permission denied.',
  }
  if (decision.approval === 'deny' || !ctx.hasUI) return denied

  const lines = [`Allow tool: ${tool}`]

  if (decision.reason) {
    lines.push(`Reason: ${decision.reason}`)
  }

  // Emit a custom `permission_request` event to trigger the `omp-notifications`
  // extension to play the notification.
  events.emit('permission_request', {
    sessionId: ctx.sessionManager.getSessionId(),
    toolCallId,
    toolName: tool,
    ...(decision.reason ? { reason: decision.reason } : {}),
  } satisfies PermissionRequestEvent)

  const choice = await ctx.ui.select(lines.join('\n'), ['Approve', 'Deny'])
  return choice === 'Approve' ? undefined : denied
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    const tool = event.toolName
    if (!['bash', 'read', 'write', 'edit', 'eval'].includes(tool)) return

    const input = event.input as Record<string, unknown>
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return enforce(
        tool,
        { approval: 'deny', reason: `invalid ${tool} tool input` },
        ctx,
        event.toolCallId,
        pi.events,
      )
    }

    const settings = findScopedSettings(ctx.cwd)

    let state: Record<string, string | string[]>
    let question: string
    let criteria: { safe: string; dangerous: string; uncertain: string }

    if (tool === 'bash') {
      if (!isBashToolInput(input)) {
        return enforce(
          tool,
          { approval: 'deny', reason: 'invalid bash tool input' },
          ctx,
          event.toolCallId,
          pi.events,
        )
      }
      if (matchesAllowedBashPattern(input.command, settings?.get('bash.patterns'))) return

      state = { command: input.command, working_directory: input.cwd ?? ctx.cwd }
      question = 'Using `command` and `working_directory`, determine the command safety level.'
      criteria = {
        safe: 'The command is read-only or has no meaningful destructive, privilege, credential, or external side-effect risk.',
        dangerous:
          'The command may cause data loss, destructive changes, privilege escalation, credential exposure, or harmful external effects.',
        uncertain:
          'The available command and working-directory context is insufficient to determine safety.',
      }
    } else if (tool === 'eval') {
      if ((input.language !== 'py' && input.language !== 'js') || typeof input.code !== 'string') {
        return enforce(
          tool,
          { approval: 'deny', reason: 'invalid eval tool input' },
          ctx,
          event.toolCallId,
          pi.events,
        )
      }
      state = { language: input.language, code: input.code, working_directory: ctx.cwd }
      question =
        'Using `language`, `code`, and `working_directory`, assess the risks of executing this code. The kernel may retain state from earlier calls.'
      criteria = {
        safe: 'The code has no meaningful destructive, privilege, credential, or external side-effect risk.',
        dangerous:
          'The code may cause data loss, destructive changes, privilege escalation, credential exposure, or harmful external effects.',
        uncertain: 'The code or available execution context is insufficient to determine safety.',
      }
    } else {
      const targets =
        tool === 'edit'
          ? editTargets(input)
          : typeof input.path === 'string' && input.path
            ? [input.path]
            : null
      if (!targets) {
        return enforce(
          tool,
          { approval: 'prompt', reason: 'file targets unavailable' },
          ctx,
          event.toolCallId,
          pi.events,
        )
      }
      const paths = targets.filter(target => !isProtocolPath(target))
      if (paths.length === 0) return
      state = { operation: tool, paths, working_directory: ctx.cwd }
      question =
        'Using `operation`, every path in `paths`, and `working_directory`, assess whether access to these paths should be automatically allowed. File contents are not available; judge path access only.'
      criteria = {
        safe: 'Access to all listed paths for this operation is appropriate; none appear sensitive or restricted.',
        dangerous:
          'Access to at least one listed path for this operation should be blocked, such as a credential, private key, or sensitive configuration path.',
        uncertain:
          'The paths and working directory do not establish whether access should be allowed.',
      }
    }

    const model = ctx.models.resolve('@judge')
    if (!settings || !model) {
      if (ctx.hasUI)
        ctx.ui.notify(
          '[omp-jev-auto-approve] Safety check unavailable; using OMP approval settings.',
          'warning',
        )
      return
    }
    if (!isJevModel(model)) {
      if (ctx.hasUI)
        ctx.ui.notify(
          '[omp-jev-auto-approve] Unsupported judge model; using OMP approval settings.',
          'warning',
        )
      return
    }
    try {
      const response = await resolveJudge({
        settings,
        registry: ctx.modelRegistry,
        sessionId: ctx.sessionManager.getSessionId(),
      }).judge({
        state,
        questions: {
          operation_safety: { type: 'choice', instructions: question, criteria },
        },
      })
      if (!isJevModel({ api: response.api, provider: response.provider, id: response.model })) {
        if (ctx.hasUI)
          ctx.ui.notify(
            '[omp-jev-auto-approve] Unsupported judge model; using OMP approval settings.',
            'warning',
          )
        return
      }
      const assessment = response.answers.operation_safety

      if (
        ctx.hasUI &&
        (assessment.choice !== 'safe' || assessment.confidence < SAFE_CONFIDENCE_THRESHOLD)
      ) {
        ctx.ui.notify(
          `[omp-jev-auto-approve] ${assessment.choice}, confidence: ${Math.round(assessment.confidence * 100)}%`,
          'warning',
        )
      } else if (ctx.hasUI && process.env.OMP_JEV_AUTO_APPROVE_DEBUG === 'true') {
        ctx.ui.notify(
          `[omp-jev-auto-approve] ${assessment.choice}, confidence: ${Math.round(assessment.confidence * 100)}%`,
          'info',
        )
      }

      return enforce(tool, decisionFromSafety(assessment, tool), ctx, event.toolCallId, pi.events)
    } catch {
      if (ctx.hasUI) {
        ctx.ui.notify('[omp-jev-auto-approve] Safety check failed; approval required.', 'error')
      }

      return enforce(
        tool,
        { approval: 'prompt', reason: 'safety check unavailable' },
        ctx,
        event.toolCallId,
        pi.events,
      )
    }
  })
}
