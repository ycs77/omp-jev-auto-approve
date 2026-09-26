import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { afterEach, describe, expect, test, vi } from 'vitest'
import extension from './index.js'

const { mockJudge, mockFindScopedSettings } = vi.hoisted(() => ({
  mockJudge: vi.fn(),
  mockFindScopedSettings: vi.fn((): { patterns: unknown[] } | undefined => ({ patterns: [] })),
}))

vi.mock('@oh-my-pi/pi-coding-agent', () => ({ settings: {} }))
vi.mock('@oh-my-pi/pi-coding-agent/config/settings', () => ({
  findScopedSettings: mockFindScopedSettings,
}))
vi.mock('@oh-my-pi/pi-coding-agent/exec/settings', () => ({
  cfgBashPatterns: { get: () => mockFindScopedSettings()?.patterns ?? [] },
}))
vi.mock('@oh-my-pi/pi-coding-agent/judgment', () => ({
  resolveJudge: () => ({
    judge: async (request: unknown) => ({
      api: 'typesafe',
      provider: 'typesafe',
      model: 'jev-1.13.0',
      ...(await mockJudge(request)),
    }),
  }),
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
    models: { resolve: vi.fn(() => ({ api: 'typesafe', provider: 'typesafe', id: 'jev-latest' })) },
    modelRegistry: {
      getAvailable: () => [{ provider: 'typesafe', id: 'jev-latest' }],
    },
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
    toolCall: handlers.tool_call!,
    ctx,
  }
}

afterEach(() => {
  mockJudge.mockReset()
  mockFindScopedSettings.mockReset()
  mockFindScopedSettings.mockReturnValue({ patterns: [] } as never)
  vi.unstubAllEnvs()
})

describe('bash tool approval workflow', () => {
  test('delegates Bash commands without a matching allow rule to Jev', async () => {
    let requestedCommand: string | undefined
    mockJudge.mockImplementation(async (request: { state: { command: string } }) => {
      requestedCommand = request.state.command

      return {
        answers: { operation_safety: { choice: 'dangerous', confidence: 1 } },
      }
    })
    const { ctx, notifications, toolCall } = registerExtension()

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
      message: '[omp-jev-auto-approve] dangerous, confidence: 100%',
      level: 'warning',
    })
  })

  test('skips Jev for an exact Bash allow pattern', async () => {
    mockFindScopedSettings.mockReturnValue({
      patterns: [{ match: 'git status', approval: 'allow' }],
    } as never)
    const { ctx, notifications, toolCall } = registerExtension()

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'git status' } },
      ctx,
    )

    expect(result).toBeUndefined()
    expect(mockJudge).not.toHaveBeenCalled()
    expect(notifications).toEqual([])
  })

  test('skips Jev for a matching wildcard allow even when other rules are restrictive', async () => {
    mockFindScopedSettings.mockReturnValue({
      patterns: [
        { match: 'git status*', approval: 'deny' },
        { match: 'git * --short', approval: 'allow' },
      ],
    } as never)
    const { ctx, toolCall } = registerExtension()

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'git status --short' } },
      ctx,
    )

    expect(result).toBeUndefined()
    expect(mockJudge).not.toHaveBeenCalled()
  })

  test('only allow rules bypass Jev, without trimming or collapsing command whitespace', async () => {
    mockFindScopedSettings.mockReturnValue({
      patterns: [
        { match: 'bun fmt', approval: 'prompt' },
        { match: 'git status', approval: 'deny' },
        { match: 'bun fmt*', approval: 'allow' },
        { match: 'git  status', approval: 'allow' },
      ],
    } as never)
    mockJudge.mockResolvedValue({
      answers: { operation_safety: { choice: 'dangerous', confidence: 1 } },
    })
    const { ctx, toolCall } = registerExtension()

    for (const command of ['git status', 'git status ', 'bun  fmt', ' bun fmt']) {
      expect(
        await toolCall({ toolName: 'bash', toolCallId: command, input: { command } }, ctx),
      ).toEqual({ block: true, reason: 'Permission denied: unsafe command.' })
    }
    for (const command of ['bun fmt', 'bun fmt --check', 'git  status']) {
      expect(
        await toolCall({ toolName: 'bash', toolCallId: command, input: { command } }, ctx),
      ).toBeUndefined()
    }
    expect(mockJudge).toHaveBeenCalledTimes(4)
  })

  test('treats only * as a wildcard and matches the whole command', async () => {
    mockFindScopedSettings.mockReturnValue({
      patterns: [{ match: 'echo a.b* done', approval: 'allow' }],
    })
    mockJudge.mockResolvedValue({
      answers: { operation_safety: { choice: 'dangerous', confidence: 1 } },
    })
    const { ctx, toolCall } = registerExtension()

    for (const command of ['echo a.b done', 'echo a.b more done']) {
      expect(
        await toolCall({ toolName: 'bash', toolCallId: command, input: { command } }, ctx),
      ).toBeUndefined()
    }
    for (const command of ['echo axb done', 'before echo a.b done', 'echo a.b done after']) {
      expect(
        await toolCall({ toolName: 'bash', toolCallId: command, input: { command } }, ctx),
      ).toEqual({ block: true, reason: 'Permission denied: unsafe command.' })
    }
    expect(mockJudge).toHaveBeenCalledTimes(3)
  })

  test('keeps unmatched, restrictive, and regex-like rules on the Jev path', async () => {
    mockFindScopedSettings.mockReturnValue({
      patterns: [
        { match: 'git status', approval: 'prompt' },
        { match: 'git log', approval: 'deny' },
        { match: 'git show a.b', approval: 'allow' },
        { match: 'git diff*', approval: 'allow' },
      ],
    } as never)
    mockJudge.mockResolvedValue({
      answers: { operation_safety: { choice: 'dangerous', confidence: 1 } },
    })
    const { ctx, toolCall } = registerExtension()

    for (const command of ['git status', 'git log', 'git show axb', 'git log --oneline']) {
      const result = await toolCall(
        { toolName: 'bash', toolCallId: command, input: { command } },
        ctx,
      )
      expect(result).toEqual({ block: true, reason: 'Permission denied: unsafe command.' })
    }
    expect(mockJudge).toHaveBeenCalledTimes(4)
  })

  test('does not notify for a high-confidence safe assessment', async () => {
    mockJudge.mockResolvedValue({
      answers: { operation_safety: { choice: 'safe', confidence: 0.9 } },
    })
    const { ctx, notifications, toolCall } = registerExtension()

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'git status' } },
      ctx,
    )

    expect(result).toBeUndefined()
    expect(notifications).toEqual([])
  })

  test('shows safe assessments as info only when debug is true and UI is available', async () => {
    mockJudge.mockResolvedValue({
      answers: { operation_safety: { choice: 'safe', confidence: 0.95 } },
    })
    const { ctx, notifications, toolCall } = registerExtension()
    const event = { toolName: 'bash', toolCallId: 'call', input: { command: 'git status' } }

    vi.stubEnv('OMP_JEV_AUTO_APPROVE_DEBUG', 'false')
    await toolCall(event, ctx)
    expect(notifications).toEqual([])

    vi.stubEnv('OMP_JEV_AUTO_APPROVE_DEBUG', 'true')
    expect(await toolCall(event, ctx)).toBeUndefined()
    expect(notifications).toEqual([
      { message: '[omp-jev-auto-approve] safe, confidence: 95%', level: 'info' },
    ])

    await toolCall(event, { ...ctx, hasUI: false } as ExtensionContext)
    expect(notifications).toHaveLength(1)
  })

  test('prompts rather than auto-approving a low-confidence safe assessment', async () => {
    mockJudge.mockResolvedValue({
      answers: { operation_safety: { choice: 'safe', confidence: 0.89 } },
    })
    const { ctx, notifications, toolCall } = registerExtension()

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'git status' } },
      ctx,
    )

    expect(result).toEqual({
      block: true,
      reason: 'Permission denied: low confidence safety assessment.',
    })
    expect(notifications).toContainEqual({
      message: '[omp-jev-auto-approve] safe, confidence: 89%',
      level: 'warning',
    })
  })

  test('prompts when the judge request fails', async () => {
    mockJudge.mockRejectedValue(new Error('service unavailable'))
    const { ctx, notifications, toolCall } = registerExtension()

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

  test('unavailable judge returns to OMP approval without a UI or warning', async () => {
    const { ctx, notifications, toolCall } = registerExtension()
    ctx.modelRegistry.getAvailable = vi.fn(() => []) as never
    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'call', input: { command: 'git status' } },
      { ...ctx, hasUI: false } as ExtensionContext,
    )
    expect(result).toBeUndefined()
    expect(mockJudge).not.toHaveBeenCalled()
    expect(notifications).toEqual([])
  })
})

describe('path and eval approval workflow', () => {
  test('reviews a read path without reading file contents', async () => {
    let state: unknown
    mockJudge.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'dangerous', confidence: 1 } } }
    })
    const { ctx, toolCall } = registerExtension()

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
    mockJudge.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'safe', confidence: 0.9 } } }
    })
    const { ctx, toolCall } = registerExtension()

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

  test('skips URI targets without a judge role', async () => {
    const { ctx, toolCall } = registerExtension()
    mockFindScopedSettings.mockReturnValue(undefined as never)
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
    mockJudge.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'dangerous', confidence: 1 } } }
    })
    const { ctx, toolCall } = registerExtension()

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
    mockJudge.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'safe', confidence: 0.9 } } }
    })
    const { ctx, toolCall } = registerExtension()

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
    mockJudge.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'safe', confidence: 0.9 } } }
    })
    const { ctx, toolCall } = registerExtension()

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
    const { ctx, toolCall } = registerExtension()

    expect(
      await toolCall(
        { toolName: 'edit', toolCallId: 'edit', input: { input: 'unknown patch syntax' } },
        ctx,
      ),
    ).toEqual({ block: true, reason: 'Permission denied: file targets unavailable.' })
  })

  test('reviews eval code and language even when code mentions a protocol', async () => {
    let state: unknown
    mockJudge.mockImplementation(async (request: { state: unknown }) => {
      state = request.state
      return { answers: { operation_safety: { choice: 'dangerous', confidence: 1 } } }
    })
    const { ctx, toolCall } = registerExtension()

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
