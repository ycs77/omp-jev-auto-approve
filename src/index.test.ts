import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import extension from './index.js'

const { mockSystemOne } = vi.hoisted(() => ({ mockSystemOne: vi.fn() }))

vi.mock('@typesafe-ai/sdk', async importOriginal => ({
  ...(await importOriginal()),
  TypeSafeClient: class {
    systemOne = mockSystemOne
  },
}))

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

beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
})

afterEach(() => {
  mockSystemOne.mockReset()
  vi.unstubAllEnvs()
})

describe('bash tool approval workflow', () => {
  test('delegates every valid Bash command to Jev', async () => {
    let requestedCommand: string | undefined
    mockSystemOne.mockImplementation(async (request: { state: { command: string } }) => {
      requestedCommand = request.state.command

      return {
        answers: { operation_safety: { choice: 'dangerous', confidence: 1 } },
      }
    })
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
    mockSystemOne.mockResolvedValue({
      answers: { operation_safety: { choice: 'safe', confidence: 0.9 } },
    })
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
    mockSystemOne.mockRejectedValue(new Error('stale client was used'))
    const { ctx, start, toolCall } = registerExtension()

    await start({}, ctx)
    vi.stubEnv('TYPESAFE_API_KEY', undefined)
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
    mockSystemOne.mockResolvedValue({
      answers: { operation_safety: { choice: 'safe', confidence: 0.89 } },
    })
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
    mockSystemOne.mockRejectedValue(new Error('service unavailable'))
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

describe('path and eval approval workflow', () => {
  test('reviews a read path without reading file contents', async () => {
    let state: unknown
    mockSystemOne.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'dangerous', confidence: 1 } } }
    })
    const { ctx, start, toolCall } = registerExtension()
    await start({}, ctx)

    expect(
      await toolCall({ toolName: 'read', toolCallId: 'read', input: { path: '.env' } }, ctx),
    ).toEqual({ block: true, reason: 'Permission denied: unsafe tool call.' })
    expect(state).toEqual({
      operation: 'read',
      paths: ['.env'],
      working_directory: '/project',
    })
  })

  test('reviews only the write path, not its content', async () => {
    let state: unknown
    mockSystemOne.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'safe', confidence: 0.9 } } }
    })
    const { ctx, start, toolCall } = registerExtension()
    await start({}, ctx)

    expect(
      await toolCall(
        {
          toolName: 'write',
          toolCallId: 'write',
          input: { path: 'notes.txt', content: 'private data' },
        },
        ctx,
      ),
    ).toBeUndefined()
    expect(state).toEqual({
      operation: 'write',
      paths: ['notes.txt'],
      working_directory: '/project',
    })
  })

  test('skips URI targets even when the API is unavailable', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', undefined)
    const { ctx, start, toolCall } = registerExtension()
    await start({}, ctx)

    for (const toolName of ['read', 'write', 'edit']) {
      expect(
        await toolCall(
          {
            toolName,
            toolCallId: toolName,
            input:
              toolName === 'edit'
                ? { input: '*** Begin Patch\n["xd://debug"#ABCD]\nREM\n*** End Patch\n' }
                : { path: 'skill://typesafe-ai', content: 'ignored' },
          },
          ctx,
        ),
      ).toBeUndefined()
    }
  })

  test('reviews every local edit target including a rename destination, but not protocol targets', async () => {
    let state: unknown
    mockSystemOne.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'dangerous', confidence: 1 } } }
    })
    const { ctx, start, toolCall } = registerExtension()
    await start({}, ctx)

    expect(
      await toolCall(
        {
          toolName: 'edit',
          toolCallId: 'edit',
          input: {
            input:
              '*** Begin Patch\n[notes.txt#ABCD]\nMV .env\n[xd://debug#1234]\nREM\n*** End Patch\n',
          },
        },
        ctx,
      ),
    ).toEqual({ block: true, reason: 'Permission denied: unsafe tool call.' })
    expect(state).toEqual({
      operation: 'edit',
      paths: ['notes.txt', '.env'],
      working_directory: '/project',
    })
  })

  test('reviews apply-patch source and destination paths', async () => {
    let state: unknown
    mockSystemOne.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'safe', confidence: 0.9 } } }
    })
    const { ctx, start, toolCall } = registerExtension()
    await start({}, ctx)

    await toolCall(
      {
        toolName: 'edit',
        toolCallId: 'edit',
        input: {
          input:
            '*** Begin Patch\n*** Update File: src/app.ts\n*** Move to: private/.env\n*** End Patch\n',
        },
      },
      ctx,
    )
    expect(state).toEqual({
      operation: 'edit',
      paths: ['src/app.ts', 'private/.env'],
      working_directory: '/project',
    })
  })

  test('reviews the destination of structured edits', async () => {
    let state: unknown
    mockSystemOne.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'safe', confidence: 0.9 } } }
    })
    const { ctx, start, toolCall } = registerExtension()
    await start({}, ctx)

    await toolCall(
      {
        toolName: 'edit',
        toolCallId: 'edit',
        input: { path: 'old.txt', edits: [{ op: 'update', rename: 'new.txt' }] },
      },
      ctx,
    )
    expect(state).toEqual({
      operation: 'edit',
      paths: ['old.txt', 'new.txt'],
      working_directory: '/project',
    })
  })

  test('prompts rather than approving an edit with unknown targets', async () => {
    const { ctx, start, toolCall } = registerExtension()
    await start({}, ctx)

    expect(
      await toolCall(
        { toolName: 'edit', toolCallId: 'edit', input: { input: 'unknown patch syntax' } },
        ctx,
      ),
    ).toEqual({ block: true, reason: 'Permission denied: file targets unavailable.' })
  })

  test('reviews eval code and language even when code mentions a protocol', async () => {
    let state: unknown
    mockSystemOne.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'dangerous', confidence: 1 } } }
    })
    const { ctx, start, toolCall } = registerExtension()
    await start({}, ctx)

    expect(
      await toolCall(
        {
          toolName: 'eval',
          toolCallId: 'eval',
          input: { language: 'js', code: 'await tool.read({path:"xd://debug"})' },
        },
        ctx,
      ),
    ).toEqual({ block: true, reason: 'Permission denied: unsafe tool call.' })
    expect(state).toEqual({
      language: 'js',
      code: 'await tool.read({path:"xd://debug"})',
      working_directory: '/project',
    })
  })
})
