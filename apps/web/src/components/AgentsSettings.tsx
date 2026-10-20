import { useEffect, useId, useMemo, useState } from 'react';
import type { AgentConfiguration, AppSettings, GroupDefaults, ProviderInfo } from '@relay/contracts';
import { Button } from './ui';
import { SelectMenu } from './SelectMenu';
import { SettingRow } from './SettingRow';
import { ConfigFields } from './group/ConfigFields';
import { defaultConfigFor, normalizeConfig, sameConfig } from '../lib/groups';

const LIMITS = {
  maxParallel: { min: 1, max: 6, fallback: 2, label: 'Simultaneous runs', description: 'Most member runs that may execute at the same time in one group.' },
  maxTurns: { min: 2, max: 80, fallback: 16, label: 'Automatic turns', description: 'Model turns one request may use before coordination pauses for you.' },
  maxHops: { min: 1, max: 12, fallback: 6, label: 'Message hops', description: 'Agent-to-agent forwarding rounds before automatic work pauses.' },
} as const;
type LimitKey = keyof typeof LIMITS;

const inRange = (key: LimitKey, text: string): boolean => {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) && value >= LIMITS[key].min && value <= LIMITS[key].max;
};

/** Defaults for new groups and new participants; existing participants keep their saved settings. */
export function AgentsSettings({ settings, providers, disabled, update }: {
  settings: AppSettings; providers: readonly ProviderInfo[]; disabled: boolean; update: (patch: Partial<AppSettings>, key: string) => Promise<boolean>;
}) {
  const saved = settings.groupDefaults;
  const id = useId();
  const fallback = useMemo(() => defaultConfigFor(settings.defaultProvider, settings, providers), [settings, providers]);
  const [orchestrator, setOrchestrator] = useState<AgentConfiguration | null>(saved?.orchestrator ?? null);
  const [worker, setWorker] = useState<AgentConfiguration | null>(saved?.worker ?? null);
  const [limits, setLimits] = useState<Record<LimitKey, string>>({
    maxParallel: String(saved?.maxParallel ?? LIMITS.maxParallel.fallback), maxTurns: String(saved?.maxTurns ?? LIMITS.maxTurns.fallback), maxHops: String(saved?.maxHops ?? LIMITS.maxHops.fallback),
  });
  const savedKey = JSON.stringify(saved ?? null);
  useEffect(() => {
    setOrchestrator(saved?.orchestrator ?? null);
    setWorker(saved?.worker ?? null);
    setLimits({ maxParallel: String(saved?.maxParallel ?? LIMITS.maxParallel.fallback), maxTurns: String(saved?.maxTurns ?? LIMITS.maxTurns.fallback), maxHops: String(saved?.maxHops ?? LIMITS.maxHops.fallback) });
    // Re-sync only when the stored value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const valid = (Object.keys(LIMITS) as LimitKey[]).every((key) => inRange(key, limits[key]));
  const changedConfig = (a: AgentConfiguration | null | undefined, b: AgentConfiguration | null | undefined) => (a && b ? !sameConfig(a, b) : Boolean(a) !== Boolean(b));
  const dirty = changedConfig(orchestrator, saved?.orchestrator) || changedConfig(worker, saved?.worker)
    || (Object.keys(LIMITS) as LimitKey[]).some((key) => Number(limits[key]) !== (saved?.[key] ?? LIMITS[key].fallback));

  const save = () => {
    if (!dirty || !valid) return;
    const next: GroupDefaults = {
      ...(orchestrator ? { orchestrator } : {}), ...(worker ? { worker } : {}),
      maxParallel: Number(limits.maxParallel), maxTurns: Number(limits.maxTurns), maxHops: Number(limits.maxHops),
    };
    void update({ groupDefaults: next }, 'groups');
  };
  const revert = () => {
    setOrchestrator(saved?.orchestrator ?? null);
    setWorker(saved?.worker ?? null);
    setLimits({ maxParallel: String(saved?.maxParallel ?? LIMITS.maxParallel.fallback), maxTurns: String(saved?.maxTurns ?? LIMITS.maxTurns.fallback), maxHops: String(saved?.maxHops ?? LIMITS.maxHops.fallback) });
  };

  const configRow = (title: string, description: string, value: AgentConfiguration | null, set: (next: AgentConfiguration | null) => void, key: string, unsetLabel: string) => (
    <>
      <SettingRow title={title} description={description} htmlFor={`${id}-${key}`}>
        <SelectMenu id={`${id}-${key}`} label={title} value={value ? 'custom' : 'unset'} disabled={disabled}
          options={[{ value: 'unset', label: unsetLabel }, { value: 'custom', label: 'Custom configuration' }]}
          onChange={(next) => set(next === 'custom' ? normalizeConfig(value ?? fallback, providers, settings) : null)} />
      </SettingRow>
      {value ? <div className="agents-config"><ConfigFields idPrefix={`${id}-${key}-cfg`} legend={`${title} configuration`} value={value} disabled={disabled} onChange={set} /></div> : null}
    </>
  );

  return (
    <div className="settings-page__section">
      <div className="settings-page__section-head"><h2>Agents & orchestration</h2><p>Defaults for new groups and new participants. Existing participants and independent sessions keep their own settings.</p></div>
      {configRow('Default orchestrator', 'Used only when Orchestrated mode creates a separate coordinator. It is previewed before anything is added.', orchestrator, setOrchestrator, 'orchestrator', 'Choose when adding')}
      {configRow('Default worker', 'Starting point for each new agent, using what its provider currently advertises.', worker, setWorker, 'worker', 'Use new-session defaults')}
      <div className="settings-page__section-head settings-page__section-head--next"><h2>Limits</h2><p>Automatic work pauses with a visible reason when a bound is reached. Relay cannot enforce an exact spend cap because provider cost is not always reported.</p></div>
      {(Object.keys(LIMITS) as LimitKey[]).map((key) => (
        <SettingRow key={key} title={LIMITS[key].label} description={`${LIMITS[key].description} From ${LIMITS[key].min} to ${LIMITS[key].max}.`} htmlFor={`${id}-${key}`}>
          <input id={`${id}-${key}`} className="input" type="number" inputMode="numeric" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={limits[key]} disabled={disabled}
            aria-invalid={inRange(key, limits[key]) ? undefined : true} onChange={(event) => setLimits((current) => ({ ...current, [key]: event.target.value }))} />
          {inRange(key, limits[key]) ? null : <p className="settings-percent__error" role="alert">Enter a whole number from {LIMITS[key].min} to {LIMITS[key].max}.</p>}
        </SettingRow>
      ))}
      <div className="agents-actions">
        <Button size="sm" variant="ghost" disabled={!dirty || disabled} onClick={revert}>Revert</Button>
        <Button size="sm" variant="primary" disabled={!dirty || !valid || disabled} why={!valid ? 'Fix the highlighted limits' : 'No changes to save'} onClick={save}>Save defaults</Button>
      </div>
    </div>
  );
}
