// src/hook/__tests__/args.test.ts
import * as args from '../args'

describe('Hook Argument Parser', () => {
  describe('parseHookArgs', () => {
    describe('valid permission_request', () => {
      it('parses permission_request with tool and command', () => {
        const result = args.parseHookArgs(['permission_request', 'Bash', 'npm install'])
        expect(args.isOk(result)).toBe(true)

        if (args.isOk(result)) {
          expect((result as any).right).toEqual({
            type: 'permission_request',
            tool: 'Bash',
            command: 'npm install',
          })
        }
      })

      it('parses permission_request with multi-word command', () => {
        const result = args.parseHookArgs(['permission_request', 'Node', 'node --version && npm list'])
        expect(args.isOk(result)).toBe(true)

        if (args.isOk(result)) {
          const hookArgs = (result as any).right
          expect(hookArgs.type).toBe('permission_request')
          expect(hookArgs.tool).toBe('Node')
          expect(hookArgs.command).toBe('node --version && npm list')
        }
      })
    })

    describe('valid stop', () => {
      it('parses stop with no additional arguments', () => {
        const result = args.parseHookArgs(['stop'])
        expect(args.isOk(result)).toBe(true)

        if (args.isOk(result)) {
          expect((result as any).right).toEqual({
            type: 'stop',
          })
        }
      })

      it('ignores extra arguments after stop', () => {
        const result = args.parseHookArgs(['stop', 'extra', 'args'])
        expect(args.isOk(result)).toBe(true)

        if (args.isOk(result)) {
          const hookArgs = (result as any).right
          expect(hookArgs.type).toBe('stop')
          expect(hookArgs.tool).toBeUndefined()
          expect(hookArgs.command).toBeUndefined()
          expect(hookArgs.message).toBeUndefined()
        }
      })
    })

    describe('valid notification', () => {
      it('parses notification with message', () => {
        const result = args.parseHookArgs(['notification', 'Task completed'])
        expect(args.isOk(result)).toBe(true)

        if (args.isOk(result)) {
          expect((result as any).right).toEqual({
            type: 'notification',
            message: 'Task completed',
          })
        }
      })

      it('parses notification with multi-word message', () => {
        const result = args.parseHookArgs(['notification', 'Build failed with error: timeout'])
        expect(args.isOk(result)).toBe(true)

        if (args.isOk(result)) {
          const hookArgs = (result as any).right
          expect(hookArgs.type).toBe('notification')
          expect(hookArgs.message).toBe('Build failed with error: timeout')
        }
      })
    })

    describe('error cases', () => {
      it('returns Left for no arguments', () => {
        const result = args.parseHookArgs([])
        expect(args.isErr(result)).toBe(true)

        if (args.isErr(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for invalid hook type', () => {
        const result = args.parseHookArgs(['invalid_type'])
        expect(args.isErr(result)).toBe(true)

        if (args.isErr(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for permission_request without tool', () => {
        const result = args.parseHookArgs(['permission_request'])
        expect(args.isErr(result)).toBe(true)

        if (args.isErr(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for permission_request without command', () => {
        const result = args.parseHookArgs(['permission_request', 'Bash'])
        expect(args.isErr(result)).toBe(true)

        if (args.isErr(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for notification without message', () => {
        const result = args.parseHookArgs(['notification'])
        expect(args.isErr(result)).toBe(true)

        if (args.isErr(result)) {
          expect((result as any).left._tag).toBe('HookParseError')
        }
      })

      it('returns Left for empty string as hook type', () => {
        const result = args.parseHookArgs([''])
        expect(args.isErr(result)).toBe(true)
      })

      it('returns Left for empty string as tool in permission_request', () => {
        const result = args.parseHookArgs(['permission_request', '', 'npm install'])
        expect(args.isErr(result)).toBe(true)
      })

      it('returns Left for empty string as command in permission_request', () => {
        const result = args.parseHookArgs(['permission_request', 'Bash', ''])
        expect(args.isErr(result)).toBe(true)
      })

      it('returns Left for empty string as message in notification', () => {
        const result = args.parseHookArgs(['notification', ''])
        expect(args.isErr(result)).toBe(true)
      })
    })

    describe('error messages', () => {
      it('includes helpful error message for missing arguments', () => {
        const result = args.parseHookArgs(['permission_request'])

        if (args.isErr(result)) {
          const error = (result as any).left
          expect(error.message).toContain('permission_request')
          expect(error.message.toLowerCase()).toContain('argument')
        }
      })

      it('includes helpful error message for invalid hook type', () => {
        const result = args.parseHookArgs(['unknown'])

        if (args.isErr(result)) {
          const error = (result as any).left
          expect(error.message).toContain('unknown')
          expect(error.message.toLowerCase()).toContain('hook')
        }
      })
    })

    describe('integration with Either', () => {
      it('works with fold for success case', () => {
        const result = args.parseHookArgs(['stop'])
        const message = args.fold(
          (err: any) => `Parse error: ${err.message}`,
          (ok: any) => `Hook type: ${ok.type}`
        )(result)

        expect(message).toBe('Hook type: stop')
      })

      it('works with fold for error case', () => {
        const result = args.parseHookArgs(['invalid'])
        const message = args.fold(
          (err: any) => `Parse error: ${err.message}`,
          (ok: any) => `Hook type: ${ok.type}`
        )(result)

        expect(message).toContain('Parse error')
      })
    })
  })

  describe('HookArgs type', () => {
    it('has required type field', () => {
      const hookArgs: args.HookArgs = {
        type: 'stop',
      }
      expect(hookArgs.type).toBe('stop')
    })

    it('can have optional tool field', () => {
      const hookArgs: args.HookArgs = {
        type: 'permission_request',
        tool: 'Bash',
        command: 'ls',
      }
      expect(hookArgs.tool).toBe('Bash')
    })

    it('can have optional message field', () => {
      const hookArgs: args.HookArgs = {
        type: 'notification',
        message: 'Done',
      }
      expect(hookArgs.message).toBe('Done')
    })
  })

  describe('HookType', () => {
    it('accepts permission_request', () => {
      const t: args.HookType = 'permission_request'
      expect(t).toBe('permission_request')
    })

    it('accepts stop', () => {
      const t: args.HookType = 'stop'
      expect(t).toBe('stop')
    })

    it('accepts notification', () => {
      const t: args.HookType = 'notification'
      expect(t).toBe('notification')
    })
  })
})
