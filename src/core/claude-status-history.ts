import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AgentStatusObservation } from '@shared/agents/normalize'
import { TMUX_SOCKET } from './tmux-naming'

const exec = promisify(execFile)
const MAX_RECORDS = 256
const MAX_RECORD_BYTES = 64 * 1024
const PANE_FORMAT = '#{session_name}:#{window_id}.#{pane_id}|#{pane_tty}'
const normalizeSpace = (s: string): string => s.trim().replace(/\s+/g, ' ')
type Run = (bin: string, args: string[]) => Promise<string>

interface NativeSession {
  nodeId: string
  pid: number
  tmux: string
  procStart: string
  status: string
  updatedAt: number
}

function parseRecord(value: unknown, filename: string, now: number): NativeSession | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!Number.isSafeInteger(v.pid) || (v.pid as number) <= 0 || filename !== `${v.pid}.json`) return null
  if (v.pidDomain !== 'darwin' || v.kind !== 'interactive') return null
  if (typeof v.tmux !== 'string' || typeof v.procStart !== 'string' || !v.procStart.trim()) return null
  const pane = /^nt-([a-zA-Z0-9_-]+):@\d+\.%(\d+)$/.exec(v.tmux)
  if (!pane || typeof v.status !== 'string') return null
  if (typeof v.statusUpdatedAt !== 'number' || !Number.isFinite(v.statusUpdatedAt) ||
      v.statusUpdatedAt <= 0 || v.statusUpdatedAt > now) return null
  return {
    nodeId: pane[1], pid: v.pid as number, tmux: v.tmux,
    procStart: normalizeSpace(v.procStart), status: v.status, updatedAt: v.statusUpdatedAt
  }
}

/**
 * Claude's native session registry recovers display history after hooks have aged out. The
 * measured Darwin record carries a UTC `ps lstart`, the PID, and exact tmux session/window/pane.
 * Match all three against the current foreground process; a leftover file or reused PID cannot
 * label a replacement pane. This never produces a hook event, live state, or identity proof.
 *
 * Only native `idle` has a measured mapping. Other values retain their real update time but
 * remain Unknown. No transcripts, environment values, command arguments, or messages are read.
 */
export async function readClaudeStatusHistory(options: {
  tmuxBin: string | null
  configDir?: string
  now?: number
  platformName?: string
  run?: Run
}): Promise<Record<string, AgentStatusObservation>> {
  if ((options.platformName ?? process.platform) !== 'darwin' || !options.tmuxBin) return {}
  const now = options.now ?? Date.now()
  const run: Run = options.run ?? (async (bin, args) => {
    const { stdout } = await exec(bin, args, {
      timeout: 2_000, maxBuffer: 1024 * 1024,
      // Claude's procStart is UTC even when the desktop uses a local timezone (measured).
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }
    })
    return stdout
  })
  const dir = path.join(options.configDir ?? path.join(os.homedir(), '.claude'), 'sessions')
  try {
    const files = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((f) => f.isFile() && /^\d+\.json$/.test(f.name)).slice(0, MAX_RECORDS)
    const records: NativeSession[] = []
    for (const file of files) {
      try {
        const filename = path.join(dir, file.name)
        const handle = await fs.open(filename, 'r')
        try {
          const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          if (bytesRead > MAX_RECORD_BYTES) continue
          const record = parseRecord(JSON.parse(buffer.toString('utf8', 0, bytesRead)), file.name, now)
          if (record) records.push(record)
        } finally {
          await handle.close()
        }
      } catch { /* A session may exit or atomically replace its record during the scan. */ }
    }
    if (records.length === 0) return {}
    const [paneOutput, processOutput] = await Promise.all([
      run(options.tmuxBin, ['-L', TMUX_SOCKET, 'list-panes', '-a', '-F', PANE_FORMAT]),
      run('ps', ['-ww', '-p', records.map((r) => r.pid).join(','), '-o', 'pid=,lstart=,stat=,tty=,comm='])
    ])
    const panes = new Map(paneOutput.trim().split('\n').map((line) => {
      const [identity, tty] = line.split('|')
      return [identity, tty?.replace(/^\/dev\//, '')]
    }))
    const processes = new Map<number, { start: string; tty: string }>()
    for (const line of processOutput.split('\n')) {
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
      if (!m || !m[3].includes('+') || path.basename(m[5]) !== 'claude') continue
      processes.set(Number(m[1]), { start: normalizeSpace(m[2]), tty: m[4] })
    }
    const history: Record<string, AgentStatusObservation> = {}
    for (const record of records) {
      const proc = processes.get(record.pid)
      if (!proc || proc.start !== record.procStart || panes.get(record.tmux) !== proc.tty) continue
      const previous = history[record.nodeId]
      if (previous && previous.updatedAt >= record.updatedAt) continue
      history[record.nodeId] = {
        state: record.status === 'idle' ? 'done' : undefined,
        updatedAt: record.updatedAt
      }
    }
    return history
  } catch {
    return {}
  }
}
