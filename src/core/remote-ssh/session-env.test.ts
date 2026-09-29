import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  isSafeEnvName,
  remoteSessionEnvPath,
  sessionEnvFileContent
} from './session-env'

describe('sessionEnvFileContent', () => {
  it('renders `export K=\'v\'` with values single-quoted so metacharacters are inert', () => {
    const out = sessionEnvFileContent({
      ANTHROPIC_AUTH_TOKEN: 'vk-123',
      OPENAI_BASE_URL: 'https://gw.example/v1'
    })
    expect(out).toBe(
      "export ANTHROPIC_AUTH_TOKEN='vk-123'\nexport OPENAI_BASE_URL='https://gw.example/v1'\n"
    )
  })

  it.skipIf(process.platform === 'win32')('clears inherited routing before applying the new policy and custom overrides', () => {
    const source = sessionEnvFileContent({ CLAUDE_CODE_SUBAGENT_MODEL: 'custom-model' }, [
      'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'BAD;NAME'
    ])
    const output = execFileSync('/bin/sh', ['-c', source +
      'printf "%s|%s" "$CLAUDE_CODE_SUBAGENT_MODEL" "${CLAUDE_CODE_SUBAGENT_MODEL_FORCE-unset}"'], {
      env: { CLAUDE_CODE_SUBAGENT_MODEL: 'old-route', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }, encoding: 'utf8'
    })
    expect(output).toBe('custom-model|unset')
  })

  it('fences a hostile value into a single-quoted literal (no command substitution escapes)', () => {
    const out = sessionEnvFileContent({ K: "a'; rm -rf ~; echo '" })
    // The embedded quote is closed/escaped/reopened, never terminating the assignment.
    expect(out).toBe("export K='a'\\''; rm -rf ~; echo '\\'''\n")
  })

  it('drops a pair whose NAME is not a shell identifier (a name is spliced bare)', () => {
    const out = sessionEnvFileContent({ 'BAD;NAME': 'x', GOOD: 'y' })
    expect(out).toBe("export GOOD='y'\n")
  })
})

describe('isSafeEnvName', () => {
  it('accepts identifiers, rejects anything that could break out of the left-hand side', () => {
    expect(isSafeEnvName('ANTHROPIC_AUTH_TOKEN')).toBe(true)
    expect(isSafeEnvName('_x1')).toBe(true)
    expect(isSafeEnvName('1BAD')).toBe(false)
    expect(isSafeEnvName('BAD;NAME')).toBe(false)
    expect(isSafeEnvName('BAD NAME')).toBe(false)
    expect(isSafeEnvName('')).toBe(false)
  })
})

describe('remoteSessionEnvPath', () => {
  it('builds a per-session path under the validated remote home', () => {
    expect(remoteSessionEnvPath('/home/deploy', 'nt-abc')).toBe(
      '/home/deploy/.nodeterm/env/nt-abc.env'
    )
  })
})
