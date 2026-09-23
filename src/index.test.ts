import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { afterEach, describe, expect, test } from 'bun:test'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import extension from './index.js'

const originalApiKey = process.env.TYPESAFE_API_KEY
const originalSystemOneDescriptor = Object.getOwnPropertyDescriptor(
  TypeSafeClient.prototype,
  'systemOne',
)!

function registerExtension() {
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>> = {}
  const notifications: Array<{ message: string; level: string }> = []
  const pi = {
    events: { emit() {} },
    on(event: string, handler: unknown) {
      handlers[event] = handler as (event: unknown, ctx: ExtensionContext) => Promise<unknown>
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: '/project',
    hasUI: true,
    sessionManager: { getSessionId: () => 'session' },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level })
      },
      async select() {
        return 'Deny'
      },
    },
  } as unknown as ExtensionContext

  extension(pi)

  return {
    notifications,
    start: handlers.session_start!,
    toolCall: handlers.tool_call!,
    ctx,
  }
}

afterEach(() => {
  Object.defineProperty(TypeSafeClient.prototype, 'systemOne', originalSystemOneDescriptor)

  if (originalApiKey === undefined) {
    delete process.env.TYPESAFE_API_KEY
  } else {
    process.env.TYPESAFE_API_KEY = originalApiKey
  }
})

describe('bash tool approval workflow', () => {
  test('delegates every valid Bash command to Jev', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key'
    let requestedCommand: string | undefined
    TypeSafeClient.prototype.systemOne = (async (request: { state: { command: string } }) => {
      requestedCommand = request.state.command

      return {
        answers: { command_safety: { choice: 'dangerous', confidence: 1 } },
      }
    }) as unknown as typeof TypeSafeClient.prototype.systemOne
    const { ctx, notifications, start, toolCall } = registerExtension()

    await start({}, ctx)

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'rm -rf build' } },
      ctx,
    )

    expect(requestedCommand).toBe('rm -rf build')
    expect(result).toEqual({
      block: true,
      reason: 'Permission denied: unsafe command.',
    })
    expect(notifications).toContainEqual({
      message: '[omp-jev-auto-approve] dangerous, confidence=1.00',
      level: 'warning',
    })
  })

  test('does not notify for a high-confidence safe assessment', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key'
    TypeSafeClient.prototype.systemOne = (async () => ({
      answers: { command_safety: { choice: 'safe', confidence: 0.9 } },
    })) as unknown as typeof TypeSafeClient.prototype.systemOne
    const { ctx, notifications, start, toolCall } = registerExtension()

    await start({}, ctx)

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'git status' } },
      ctx,
    )

    expect(result).toBeUndefined()
    expect(notifications).toEqual([])
  })

  test('resets a previous client when a new session lacks an API key', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key'
    TypeSafeClient.prototype.systemOne = (async () => {
      throw new Error('stale client was used')
    }) as unknown as typeof TypeSafeClient.prototype.systemOne
    const { ctx, start, toolCall } = registerExtension()

    await start({}, ctx)
    delete process.env.TYPESAFE_API_KEY
    await start({}, ctx)

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'git status' } },
      ctx,
    )

    expect(result).toEqual({
      block: true,
      reason: 'Permission denied: safety check unavailable.',
    })
  })

  test('prompts rather than auto-approving a low-confidence safe assessment', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key'
    TypeSafeClient.prototype.systemOne = (async () => ({
      answers: { command_safety: { choice: 'safe', confidence: 0.89 } },
    })) as unknown as typeof TypeSafeClient.prototype.systemOne
    const { ctx, notifications, start, toolCall } = registerExtension()

    await start({}, ctx)

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'git status' } },
      ctx,
    )

    expect(result).toEqual({
      block: true,
      reason: 'Permission denied: low confidence safety assessment.',
    })
    expect(notifications).toContainEqual({
      message: '[omp-jev-auto-approve] safe, confidence=0.89',
      level: 'warning',
    })
  })

  test('prompts when the TypeSafe API fails', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key'
    TypeSafeClient.prototype.systemOne = (async () => {
      throw new Error('service unavailable')
    }) as unknown as typeof TypeSafeClient.prototype.systemOne
    const { ctx, notifications, start, toolCall } = registerExtension()

    await start({}, ctx)

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'git status' } },
      ctx,
    )

    expect(result).toEqual({
      block: true,
      reason: 'Permission denied: safety check unavailable.',
    })
    expect(notifications).toContainEqual({
      message: '[omp-jev-auto-approve] Safety check failed; approval required.',
      level: 'error',
    })
  })
})
