import type { BashToolInput, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { choice, TypeSafeClient } from '@typesafe-ai/sdk'

type CommandSafety = 'safe' | 'dangerous' | 'uncertain'

interface CommandSafetyAssessment {
  choice: CommandSafety
  confidence: number
}

type Approval = 'allow' | 'deny' | 'prompt'

interface Decision {
  approval: Approval
  reason?: string
}

const SAFE_CONFIDENCE_THRESHOLD = 0.9

function isBashToolInput(input: unknown): input is BashToolInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'command' in input &&
    typeof input.command === 'string'
  )
}

function decisionFromSafety(result: CommandSafetyAssessment): Decision {
  switch (result.choice) {
    case 'dangerous':
      return { approval: 'deny', reason: 'unsafe command' }

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
  let client: TypeSafeClient | null = null

  pi.on('session_start', (_event, ctx) => {
    client = null

    if (!process.env.TYPESAFE_API_KEY?.trim()) {
      ctx.ui.notify(
        '[omp-jev-auto-approve] Missing TYPESAFE_API_KEY, please visit https://console.typesafe.ai/keys to create and set it.',
        'error',
      )
      return
    }

    client = new TypeSafeClient()
  })

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return

    if (!isBashToolInput(event.input)) {
      return enforce(
        event.toolName,
        { approval: 'deny', reason: 'invalid bash tool input' },
        ctx,
        event.toolCallId,
        pi.events,
      )
    }

    const tool = event.toolName
    const input = event.input
    const workingDirectory = input.cwd ?? ctx.cwd

    if (!client) {
      return enforce(
        tool,
        { approval: 'prompt', reason: 'safety check unavailable' },
        ctx,
        event.toolCallId,
        pi.events,
      )
    }

    try {
      const response = await client.systemOne({
        state: {
          command: input.command,
          working_directory: workingDirectory,
        },
        questions: {
          command_safety: choice(
            'Using `command` and `working_directory`, determine the command safety level.',
            {
              safe: 'The command is read-only or has no meaningful destructive, privilege, credential, or external side-effect risk.',
              dangerous:
                'The command may cause data loss, destructive changes, privilege escalation, credential exposure, or harmful external effects.',
              uncertain:
                'The available command and working-directory context is insufficient to determine safety.',
            },
          ),
        },
      })
      const commandSafety = response.answers.command_safety

      ctx.ui.notify(
        `[omp-jev-auto-approve] choice: "${commandSafety.choice}", confidence: ${commandSafety.confidence}`,
        'info',
      )

      return enforce(tool, decisionFromSafety(commandSafety), ctx, event.toolCallId, pi.events)
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
