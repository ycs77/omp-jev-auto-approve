import type { ExtensionAPI, ExtensionContext, BashToolInput } from '@oh-my-pi/pi-coding-agent'
import { choice, TypeSafeClient } from '@typesafe-ai/sdk'

type Approval = 'allow' | 'deny' | 'prompt'

export interface PermissionRequestEvent {
  sessionId: string
  toolCallId: string
  toolName: string
  reason?: string
}

interface Decision {
  approval: Approval
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
    if (!process.env.TYPESAFE_API_KEY) {
      ctx.ui.notify(
        '[omp-jev-auto-approve] Missing TYPESAFE_API_KEY, please visit https://console.typesafe.ai/keys to create and set it.',
        'error',
      )
      return
    }

    client = new TypeSafeClient()
  })

  pi.on('tool_call', async (event, ctx) => {
    if (!client) return

    const tool = event.toolName

    if (tool === 'bash') {
      // 測試：
      // 執行 `echo "Hello, World!"`

      const input = event.input as BashToolInput

      const response = await client.systemOne({
        state: {
          command: input.command,
          pwd: input.cwd || ctx.cwd,
        },
        questions: {
          command_safety: choice('Determine whether the current command is safe to execute.', {
            safe: 'The command is safe to execute and has no dangerous or harmful effects.',
            unsafe: 'The command may cause dangerous or harmful effects.',
            prompt: 'The command may be safe, but it requires user approval before execution.',
          }),
        },
      })

      const { command_safety } = response.answers

      ctx.ui.notify(
        `[omp-jev-auto-approve] choice: "${command_safety.choice}", confidence: ${command_safety.confidence}`,
        'info',
      )

      let decision: Decision
      if (command_safety.choice === 'safe') {
        decision = { approval: 'allow' }
      } else if (command_safety.choice === 'unsafe') {
        decision = { approval: 'deny', reason: 'unsafe command' }
      } else {
        decision = { approval: 'prompt' }
      }

      return enforce(tool, decision, ctx, event.toolCallId, pi.events)
    }
  })
}
