import type { AppSettings, ProviderUsage, Session, UsageWindow } from '@mingle/contracts';
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { redactSecrets } from '../common.js';
import { withClaudeMetadataQuery } from './capabilities.js';

const MAX_WINDOWS = 100;
const MAX_LABEL = 120;

function safeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = redactSecrets(value.trim());
  return label.length > 0 && label.length <= MAX_LABEL ? label : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string' || value.length > 80) return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    return timestamp(numeric);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function finitePercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function makeWindow(
  id: string,
  label: string,
  scope: string | undefined,
  windowMinutes: number | null,
  value: { utilization?: unknown; resets_at?: unknown } | null | undefined,
): UsageWindow | null {
  if (value === undefined || value === null) return null;
  const usedPercent = finitePercent(value?.utilization);
  return {
    id,
    label,
    ...(scope ? { scope } : {}),
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetAt: timestamp(value?.resets_at),
    windowMinutes,
  };
}

function nativeWindows(response: SDKControlGetUsageResponse): { windows: UsageWindow[]; omittedScoped: boolean } {
  const limits = response.rate_limits;
  if (!limits) return { windows: [], omittedScoped: false };
  const windows: UsageWindow[] = [];
  const add = (window: UsageWindow | null) => {
    if (window && windows.length < MAX_WINDOWS) windows.push(window);
  };

  add(makeWindow('five_hour', '5-hour', undefined, 5 * 60, limits.five_hour));
  add(makeWindow('seven_day', '7-day', undefined, 7 * 24 * 60, limits.seven_day));
  add(makeWindow('seven_day_oauth_apps', '7-day OAuth apps', 'OAuth apps', 7 * 24 * 60, limits.seven_day_oauth_apps));
  add(makeWindow('seven_day_opus', '7-day Opus', 'Opus', 7 * 24 * 60, limits.seven_day_opus));
  add(makeWindow('seven_day_sonnet', '7-day Sonnet', 'Sonnet', 7 * 24 * 60, limits.seven_day_sonnet));
  if (limits.extra_usage !== undefined && limits.extra_usage !== null) {
    add(makeWindow('extra_usage', limits.extra_usage.is_enabled === false ? 'Extra usage (disabled)' : 'Extra usage', undefined, null, limits.extra_usage));
  }

  const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : [];
  const scopedLimit = Math.max(0, MAX_WINDOWS - windows.length);
  for (const [index, row] of scoped.slice(0, scopedLimit).entries()) {
    const label = safeLabel(row?.display_name);
    if (!label) continue;
    const scope = label;
    const usedPercent = finitePercent(row.utilization);
    windows.push({
      id: `model_scoped_${index}`,
      label: `7-day ${label}`,
      scope,
      usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      resetAt: timestamp(row.resets_at),
      windowMinutes: 7 * 24 * 60,
    });
  }
  return { windows, omittedScoped: scoped.length > scopedLimit };
}

function blankUsage(status: ProviderUsage['status'], notice: string): ProviderUsage {
  return {
    provider: 'claude',
    fetchedAt: new Date().toISOString(),
    status,
    plan: null,
    windows: [],
    credits: null,
    resets: null,
    notices: [notice],
  };
}

/** Read the current Claude Code /usage response without sending a prompt or scanning local transcripts. */
export async function getClaudeUsage(session: Session, settings: AppSettings): Promise<ProviderUsage> {
  try {
    const response = await withClaudeMetadataQuery(settings, session.worktreePath, session.model, async (activeQuery) => {
      const getUsage = activeQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof getUsage !== 'function') throw new Error('SDK usage lookup is not available');
      return getUsage.call(activeQuery, { skipBehaviors: true });
    });

    const { windows, omittedScoped } = response.rate_limits_available === true ? nativeWindows(response) : { windows: [], omittedScoped: false };
    const rateLimitsAvailable = response.rate_limits_available === true;
    const hasExtraUsage = rateLimitsAvailable && response.rate_limits?.extra_usage !== undefined && response.rate_limits?.extra_usage !== null;
    const hasNativeLimits = rateLimitsAvailable && windows.some((window) => window.usedPercent !== null || window.resetAt !== null);
    const notices: string[] = [];
    if (!rateLimitsAvailable) {
      notices.push('Claude plan usage is unavailable for this session; no usage or credit values were inferred.');
    } else if (!response.rate_limits) {
      notices.push('Claude did not return plan usage details for this session.');
    } else if (windows.length === 0) {
      notices.push('Claude returned no plan usage windows.');
    }
    if (hasExtraUsage) {
      notices.push('Claude reports extra-usage utilization but does not expose a spendable credit balance or credit reset date.');
    }
    if (omittedScoped) {
      notices.push('Additional Claude model-scoped usage windows were omitted from this bounded response.');
    }
    const plan = safeLabel(response.subscription_type);
    return {
      provider: 'claude',
      fetchedAt: new Date().toISOString(),
      status: hasNativeLimits ? 'available' : plan || rateLimitsAvailable ? 'partial' : 'unavailable',
      plan,
      windows,
      credits: null,
      // The SDK exposes rate-limit reset timestamps on windows, but no reset grants or credit replenishment schedule.
      resets: null,
      notices,
    };
  } catch {
    return blankUsage('unavailable', 'Claude usage could not be retrieved. Check Claude Code availability and authentication.');
  }
}
