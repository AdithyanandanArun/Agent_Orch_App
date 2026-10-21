import { useEffect, useId, useMemo, useState } from 'react';
import type { AgentConfiguration, AppSettings, GroupDefaults, ProviderInfo } from '@mingle/contracts';
import { Button } from './ui';
import { SelectMenu } from './SelectMenu';
import { SettingRow } from './SettingRow';
import { ConfigFields } from './group/ConfigFields';
import { defaultConfigFor, effectiveTurnCeiling, normalizeConfig, sameConfig } from '../lib/groups';
import type { AutonomyConfig, AutonomyMode } from '../lib/api';

const LIMITS = {
  maxParallel: { min: 1, max: 6, fallback: 2, label: 'Simultaneous runs', description: 'Most member runs that may execute at the same time in one group.' },
  maxTurns: { min: 2, max: 10_000, fallback: 80, label: 'Automatic turns', description: 'Model turns one request may use before coordination pauses for you.' },
  maxHops: { min: 1, max: 12, fallback: 6, label: 'Message hops', description: 'Agent-to-agent forwarding rounds before automatic work pauses.' },
} as const;
type LimitKey = keyof typeof LIMITS;

const inRange = (key: LimitKey, text: string): boolean => {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) && value >= LIMITS[key].min && value <= LIMITS[key].max;
};

const autonomyOptions: { value: AutonomyMode; label: string; description: string }[] = [
  { value: 'supervised', label: 'Supervised', description: 'Pause after each planned delegation batch so you can review and acknowledge it before more work starts.' },
  { value: 'balanced', label: 'Balanced', description: 'Finish the planned batch within its scope; pause for new scope, a recorded stall, or a recovery decision.' },
  { value: 'extended', label: 'Extended', description: 'Continue milestones within the original objective and limits; pause for scope changes or a recorded stall.' },
];

/** Defaults for new groups and new participants; existing participants keep their saved settings. */
export function AgentsSettings({ settings, providers, disabled, update }: {
  settings: AppSettings; providers: readonly ProviderInfo[]; disabled: boolean; update: (patch: Partial<AppSettings>, key: string) => Promise<boolean>;
}) {
  const saved: GroupDefaults | undefined = settings.groupDefaults;
  const id = useId();
  const fallback = useMemo(() => defaultConfigFor(settings.defaultProvider, settings, providers), [settings, providers]);
  const [orchestrator, setOrchestrator] = useState<AgentConfiguration | null>(saved?.orchestrator ?? null);
  const [worker, setWorker] = useState<AgentConfiguration | null>(saved?.worker ?? null);
  const [limits, setLimits] = useState<Record<LimitKey, string>>({
    maxParallel: String(saved?.maxParallel ?? LIMITS.maxParallel.fallback), maxTurns: String(saved?.maxTurns ?? LIMITS.maxTurns.fallback), maxHops: String(saved?.maxHops ?? LIMITS.maxHops.fallback),
  });
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>(saved?.autonomy?.mode ?? 'balanced');
  const [emergencyMode, setEmergencyMode] = useState<'inherit' | 'disabled' | 'custom'>(saved?.autonomy?.emergencyTurnLimit === null ? 'disabled' : typeof saved?.autonomy?.emergencyTurnLimit === 'number' ? 'custom' : 'inherit');
  const [emergencyLimit, setEmergencyLimit] = useState(saved?.autonomy?.emergencyTurnLimit == null ? '' : String(saved.autonomy.emergencyTurnLimit));
  const savedKey = JSON.stringify(saved ?? null);
  useEffect(() => {
    setOrchestrator(saved?.orchestrator ?? null);
    setWorker(saved?.worker ?? null);
    setLimits({ maxParallel: String(saved?.maxParallel ?? LIMITS.maxParallel.fallback), maxTurns: String(saved?.maxTurns ?? LIMITS.maxTurns.fallback), maxHops: String(saved?.maxHops ?? LIMITS.maxHops.fallback) });
    setAutonomyMode(saved?.autonomy?.mode ?? 'balanced');
    setEmergencyMode(saved?.autonomy?.emergencyTurnLimit === null ? 'disabled' : typeof saved?.autonomy?.emergencyTurnLimit === 'number' ? 'custom' : 'inherit');
    setEmergencyLimit(saved?.autonomy?.emergencyTurnLimit == null ? '' : String(saved.autonomy.emergencyTurnLimit));
    // Re-sync only when the stored value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const valid = (Object.keys(LIMITS) as LimitKey[]).every((key) => inRange(key, limits[key]));
  const emergencyValid = emergencyMode !== 'custom' || (emergencyLimit.trim() !== '' && Number.isInteger(Number(emergencyLimit)) && Number(emergencyLimit) >= 2 && Number(emergencyLimit) <= 10_000);
  const savedEmergency = saved?.autonomy?.emergencyTurnLimit;
  const effectiveTurns = effectiveTurnCeiling(
    Number(limits.maxTurns),
    emergencyMode === 'inherit' ? undefined : emergencyMode === 'disabled' ? null : emergencyValid ? Number(emergencyLimit) : null,
  );
  const effectiveTurnsLabel = emergencyMode === 'custom' && !emergencyValid ? 'set a valid value' : effectiveTurns === null ? 'uncapped' : String(effectiveTurns);
  const autonomyDirty = autonomyMode !== (saved?.autonomy?.mode ?? 'balanced')
    || emergencyMode !== (savedEmergency === null ? 'disabled' : typeof savedEmergency === 'number' ? 'custom' : 'inherit')
    || (emergencyMode === 'custom' && Number(emergencyLimit) !== savedEmergency);
  const changedConfig = (a: AgentConfiguration | null | undefined, b: AgentConfiguration | null | undefined) => (a && b ? !sameConfig(a, b) : Boolean(a) !== Boolean(b));
  const dirty = changedConfig(orchestrator, saved?.orchestrator) || changedConfig(worker, saved?.worker)
    || (Object.keys(LIMITS) as LimitKey[]).some((key) => Number(limits[key]) !== (saved?.[key] ?? LIMITS[key].fallback)) || autonomyDirty;

  const save = () => {
    if (!dirty || !valid || !emergencyValid) return;
    const autonomy: AutonomyConfig = {
      ...(saved?.autonomy ?? {}), mode: autonomyMode,
      ...(emergencyMode === 'disabled' ? { emergencyTurnLimit: null } : emergencyMode === 'custom' ? { emergencyTurnLimit: Number(emergencyLimit) } : { emergencyTurnLimit: undefined }),
    };
    const next = {
      ...(orchestrator ? { orchestrator } : {}), ...(worker ? { worker } : {}),
      maxParallel: Number(limits.maxParallel), maxTurns: Number(limits.maxTurns), maxHops: Number(limits.maxHops),
      autonomy,
    } as GroupDefaults & { autonomy: AutonomyConfig };
    void update({ groupDefaults: next }, 'groups');
  };
  const revert = () => {
    setOrchestrator(saved?.orchestrator ?? null);
    setWorker(saved?.worker ?? null);
    setLimits({ maxParallel: String(saved?.maxParallel ?? LIMITS.maxParallel.fallback), maxTurns: String(saved?.maxTurns ?? LIMITS.maxTurns.fallback), maxHops: String(saved?.maxHops ?? LIMITS.maxHops.fallback) });
    setAutonomyMode(saved?.autonomy?.mode ?? 'balanced');
    setEmergencyMode(saved?.autonomy?.emergencyTurnLimit === null ? 'disabled' : typeof saved?.autonomy?.emergencyTurnLimit === 'number' ? 'custom' : 'inherit');
    setEmergencyLimit(saved?.autonomy?.emergencyTurnLimit == null ? '' : String(saved.autonomy.emergencyTurnLimit));
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
      <div className="settings-page__section-head"><h2>Agents & orchestration</h2><p>Defaults for new groups and new participants. Existing groups and participants keep their saved settings.</p></div>
      {configRow('Default orchestrator', 'Used only when Orchestrated mode creates a separate coordinator. It is previewed before anything is added.', orchestrator, setOrchestrator, 'orchestrator', 'Choose when adding')}
      {configRow('Default worker', 'Starting point for each new agent, using what its provider currently advertises.', worker, setWorker, 'worker', 'Use new-session defaults')}
      <SettingRow title="Autonomy" description="How far a new group can continue within its explicit scope. This does not change member permissions or provider identity." htmlFor={`${id}-autonomy`}>
        <SelectMenu id={`${id}-autonomy`} label="Default group autonomy" value={autonomyMode} disabled={disabled} options={autonomyOptions} onChange={(value) => setAutonomyMode(value as AutonomyMode)} />
      </SettingRow>
      <SettingRow title="Emergency turn ceiling" description="Inherit the automatic-turn limit below, or explicitly set a higher/lower ceiling. “No ceiling” removes this turn bound; other scheduler limits still apply." htmlFor={`${id}-emergency-mode`}>
        <SelectMenu id={`${id}-emergency-mode`} label="Emergency turn ceiling" value={emergencyMode} disabled={disabled} options={[{ value: 'inherit', label: 'Use automatic-turn limit' }, { value: 'disabled', label: 'No emergency ceiling' }, { value: 'custom', label: 'Custom ceiling' }]} onChange={(value) => setEmergencyMode(value as typeof emergencyMode)} />
      </SettingRow>
      {emergencyMode === 'custom' ? <SettingRow title="Emergency turns" description="Whole-number ceiling for a new group, from 2 to 10,000." htmlFor={`${id}-emergency-limit`}>
        <input id={`${id}-emergency-limit`} className="input" type="number" min={2} max={10_000} step={1} inputMode="numeric" value={emergencyLimit} disabled={disabled} aria-invalid={!emergencyValid || undefined} onChange={(event) => setEmergencyLimit(event.target.value)} />
        {!emergencyValid ? <p className="settings-percent__error" role="alert">Enter a whole number from 2 to 10,000.</p> : null}
      </SettingRow> : null}
      <div className="settings-page__section-head settings-page__section-head--next"><h2>Limits</h2><p>Automatic work pauses with a visible reason when a bound is reached. Mingle cannot enforce an exact spend cap because provider cost is not always reported.</p></div>
      {(Object.keys(LIMITS) as LimitKey[]).map((key) => (
        <SettingRow key={key} title={LIMITS[key].label} description={`${LIMITS[key].description}${key === 'maxTurns' ? ` Effective new-group ceiling: ${effectiveTurnsLabel}.` : ''} From ${LIMITS[key].min} to ${LIMITS[key].max}.`} htmlFor={`${id}-${key}`}>
          <input id={`${id}-${key}`} className="input" type="number" inputMode="numeric" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={limits[key]} disabled={disabled}
            aria-invalid={inRange(key, limits[key]) ? undefined : true} onChange={(event) => setLimits((current) => ({ ...current, [key]: event.target.value }))} />
          {inRange(key, limits[key]) ? null : <p className="settings-percent__error" role="alert">Enter a whole number from {LIMITS[key].min} to {LIMITS[key].max}.</p>}
        </SettingRow>
      ))}
      <div className="agents-actions">
        <Button size="sm" variant="ghost" disabled={!dirty || disabled} onClick={revert}>Revert</Button>
        <Button size="sm" variant="primary" disabled={!dirty || !valid || !emergencyValid || disabled} why={!valid || !emergencyValid ? 'Fix the highlighted limits' : 'No changes to save'} onClick={save}>Save defaults</Button>
      </div>
    </div>
  );
}
