import { useMemo } from 'react';
import type { AgentConfiguration, Provider } from '@relay/contracts';
import { useRelay } from '../../store/store';
import {
  POLICY_DESCRIPTION, effortChoices, effortLabel, modelOf, normalizeConfig, policyChoices, policyLabel, providerAvailability, providerName, tierChoices,
} from '../../lib/groups';
import { Field } from '../ui';
import { SelectMenu } from '../SelectMenu';
import { providerModelChoices } from '../../lib/providers';

/** One agent's provider, model, effort, permissions and service tier, offering only what each provider currently advertises. */
export function ConfigFields({ value, onChange, idPrefix, lockProvider = false, disabled = false, legend }: {
  value: AgentConfiguration; onChange: (next: AgentConfiguration) => void; idPrefix: string; lockProvider?: boolean; disabled?: boolean; legend?: string;
}) {
  const providers = useRelay((s) => s.boot?.providers);
  const settings = useRelay((s) => s.boot?.settings);
  const info = providers?.find((provider) => provider.id === value.provider);
  const model = modelOf(info, value.model);
  const efforts = effortChoices(model);
  const tiers = tierChoices(model);
  const policies = policyChoices(info, model);
  const availability = providers ? providerAvailability(providers, value.provider) : { available: false, reason: 'Provider status is loading.' };

  const modelOptions = useMemo(() => {
    return providerModelChoices(info, value.model).map((item) => ({ value: item.id, label: item.name }));
  }, [info, model, value.model]);
  if (!providers || !settings) return null;
  const patch = (change: Partial<AgentConfiguration>) => onChange(normalizeConfig({ ...value, ...change }, providers, settings));
  const policyOptions = policies;

  return (
    <fieldset className="cfg" disabled={disabled}>
      {legend ? <legend className="sr-only">{legend}</legend> : null}
      <div className="cfg__grid">
        <Field label="Provider" htmlFor={`${idPrefix}-provider`}>
          <SelectMenu id={`${idPrefix}-provider`} label="Provider" value={value.provider} disabled={disabled || lockProvider}
            title={lockProvider ? 'A provider conversation already exists, so its provider cannot change.' : undefined}
            options={providers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.available ? provider.version ? `Available · ${provider.version}` : 'Available' : provider.reason ?? 'Needs setup', disabled: !provider.available && provider.id !== value.provider }))}
            onChange={(next) => patch({ provider: next as Provider })} />
        </Field>
        <Field label="Model" htmlFor={`${idPrefix}-model`}>
          <SelectMenu id={`${idPrefix}-model`} label="Model" value={model?.id ?? value.model} disabled={disabled || modelOptions.length === 0} options={modelOptions} onChange={(next) => patch({ model: next })} />
        </Field>
        <Field label="Reasoning effort" htmlFor={`${idPrefix}-effort`}>
          <SelectMenu id={`${idPrefix}-effort`} label="Reasoning effort" value={value.effort} disabled={disabled || efforts.length === 0}
            displayValue={efforts.length ? efforts.some((item) => item.id === value.effort) ? undefined : 'Not available' : 'Native/default'}
            options={efforts.map((item) => ({ value: item.id, label: effortLabel(item.id), badge: item.id === model?.defaultReasoningEffort ? 'Default' : undefined, description: item.description }))}
            onChange={(next) => patch({ effort: next })} />
        </Field>
        <Field label="Permissions" htmlFor={`${idPrefix}-policy`}>
          <SelectMenu id={`${idPrefix}-policy`} label="Permissions" value={value.policy} disabled={disabled || policies.length === 0}
            displayValue={policies.length ? policies.includes(value.policy) ? undefined : 'Not available' : 'Native/default'}
            options={policyOptions.map((item) => ({ value: item, label: policyLabel(item), description: POLICY_DESCRIPTION[item] }))}
            onChange={(next) => patch({ policy: next as AgentConfiguration['policy'] })} />
        </Field>
        <Field label="Service tier" htmlFor={`${idPrefix}-tier`}>
          <SelectMenu id={`${idPrefix}-tier`} label="Service tier" value={value.serviceTier} disabled={disabled || tiers.length === 0}
            options={tiers.map((item) => ({ value: item.id, label: item.label, badge: item.id === (model?.defaultServiceTier ?? 'standard') ? 'Default' : undefined, description: item.id === 'standard' ? undefined : item.description }))}
            onChange={(next) => patch({ serviceTier: next })} />
        </Field>
      </div>
      <p className={availability.available ? 'cfg__status' : 'cfg__status is-warn'} role="status">
        <i aria-hidden="true" />{availability.available ? `${providerName(value.provider)} is available${info?.version ? ` · ${info.version}` : ''}.` : `${providerName(value.provider)} is unavailable: ${availability.reason}`}
      </p>
    </fieldset>
  );
}
