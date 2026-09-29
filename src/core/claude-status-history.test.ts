import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readClaudeStatusHistory } from './claude-status-history'

let dir: string
const record = {
  pid: 123, pidDomain: 'darwin', kind: 'interactive', tmux: 'nt-node-1:@1.%2',
  procStart: 'Sat Sep 12 18:02:25 2026', status: 'idle', statusUpdatedAt: 2_000
}
const ps = '123 Sat Sep 12 18:02:25 2026 S+ ttys001 claude\n'
const panes = 'nt-node-1:@1.%2|/dev/ttys001\n'
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-history-')); await fs.mkdir(path.join(dir, 'sessions')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
async function read(patch = {}, processOutput = ps, paneOutput = panes) {
  await fs.writeFile(path.join(dir, 'sessions/123.json'), JSON.stringify({ ...record, ...patch }))
  return readClaudeStatusHistory({
    tmuxBin: '/usr/bin/tmux', configDir: dir, now: 3_000, platformName: 'darwin',
    run: async (bin) => bin === 'ps' ? processOutput : paneOutput
  })
}

describe('Claude native display history recovery', () => {
  it('recovers an existing idle node from its native record without exposing any identity evidence', async () => {
    expect(await read()).toEqual({ 'node-1': { state: 'done', updatedAt: 2_000 } })
  })
  it.each([
    [{ pid: 456 }], [{ procStart: 'Sat Sep 12 18:02:26 2026' }],
    [{ tmux: 'nt-other-node:@1.%2' }], [{ tmux: 'nt-node-1:@1.%3' }],
    [{}, ps.replace('ttys001', 'ttys002')], [{}, ps.replace('S+', 'S')],
    [{}, ps.replace('claude', 'zsh')], [{}, ''], [{}, ps, ''],
    [{ pidDomain: 'linux' }], [{ kind: 'subagent' }]
  ])('ignores replaced, foreign or non-foreground identities (%j)', async (patch, processOutput = ps, paneOutput = panes) => {
    expect(await read(patch, processOutput, paneOutput)).toEqual({})
  })
  it.each([undefined, null, '2000', 0, -1, 3_001])('rejects a missing/invalid status timestamp (%s)', async (statusUpdatedAt) => {
    expect(await read({ statusUpdatedAt })).toEqual({})
  })
  it('preserves the timestamp but does not guess what an unfamiliar native state means', async () => {
    expect(await read({ status: 'shell' })).toEqual({ 'node-1': { state: undefined, updatedAt: 2_000 } })
  })
  it('fails open when metadata is unavailable without running process probes', async () => {
    const run = vi.fn()
    expect(await readClaudeStatusHistory({ tmuxBin: '/usr/bin/tmux', configDir: dir, platformName: 'darwin', run })).toEqual({})
    expect(run).not.toHaveBeenCalled()
  })
})
