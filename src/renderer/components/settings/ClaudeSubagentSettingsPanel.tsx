import { useState } from 'react'
import { modelsForAgent, sanitizeClaudeSubagents, type ClaudeSubagentSettings } from '@shared/agents/model-gateway'
import { useSettings, flushSettingsSave } from '../../state/settings'
import { useModelGateway } from '../../state/modelGateway'
import { useProjects } from '../../state/projects'
import { CLAUDE_SUBAGENT_RESTART_EVENT } from '../../terminal/claude-subagent-restart'
import { Select } from '@renderer/ui/Select'
import { Switch } from '@renderer/ui/Switch'
import { Button } from '@renderer/ui/Button'
import { FieldRow } from './FieldRow'

export function ClaudeSubagentSettingsPanel(): React.JSX.Element {
  const saved = useSettings((s) => s.settings.claudeSubagents)
  const update = useSettings((s) => s.update)
  const models = modelsForAgent(useModelGateway((s) => s.models), 'claude')
  const projectId = useProjects((s) => s.activeProjectId)
  const policy = sanitizeClaudeSubagents(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const patch = (change: Partial<ClaudeSubagentSettings>): void => update({ claudeSubagents: { ...policy, ...change } })
  const restart = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await flushSettingsSave()
      window.dispatchEvent(new CustomEvent(CLAUDE_SUBAGENT_RESTART_EVENT, { detail: { projectId } }))
    } catch {
      setError('Could not save the settings. No sessions were restarted. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return <div className="space-y-4">
    <FieldRow label="Claude subagents"
      description="Choose how Claude selects subagent models in gateway sessions. Subscription sessions keep Claude’s own settings."
      control={<Select aria-label="Claude subagent model policy" value={policy.mode} disabled={busy}
        onChange={(e) => patch({ mode: e.target.value as ClaudeSubagentSettings['mode'] })}>
        <option value="parent">Same as parent (recommended)</option>
        <option value="model">Specific model</option>
        <option value="claude">Let Claude choose</option>
      </Select>} />
    {policy.mode === 'parent' && <p className="text-sm text-muted">Subagents follow the parent’s model, including changes made inside Claude. Context budgets are set when the session starts.</p>}
    {policy.mode === 'claude' && <p className="text-sm text-muted">Claude can use per-agent and per-call model choices. Those models must be available through your gateway.</p>}
    {policy.mode === 'model' && <>
      <FieldRow label="Subagent model"
        description="Context limits come from model discovery. A smaller model also lowers the parent’s compaction budget because Claude shares that setting."
        control={<Select aria-label="Claude subagent model" value={policy.model ?? ''} disabled={busy}
          onChange={(e) => patch({ model: e.target.value || undefined })}>
          <option value="">Choose a model — otherwise use parent</option>
          {policy.model && !models.some((m) => m.id === policy.model) && <option value={policy.model}>{policy.model} (not in current catalogue)</option>}
          {models.map((m) => <option key={m.id} value={m.id}>
            {m.id} ({m.contextWindow ? `${m.contextWindow.toLocaleString()} tokens` : 'context unknown'})
          </option>)}
        </Select>} />
      {!models.length && <p className="text-sm text-muted">Discover models in Settings → Model gateway to populate this list.</p>}
      <FieldRow label="Always use this model"
        description="Override per-agent and per-call model choices. Turn off to use this model as a default that Claude can override."
        control={<Switch ariaLabel="Always use this subagent model" checked={policy.force} disabled={busy}
          onChange={(force) => patch({ force })} />} />
    </>}
    <p className="text-sm text-muted">Same as parent and Always use this model require Claude Code 2.1.257 or later.</p>
    <p className="text-sm text-muted">Changes apply to new sessions. You can restart idle Claude sessions in the current project to apply them now. Working, waiting, and unknown sessions are skipped, along with sessions running subagents or background tasks. Scheduled sessions are also skipped.</p>
    <Button disabled={busy || !projectId} onClick={() => void restart()}>Restart idle Claude sessions…</Button>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>
}
