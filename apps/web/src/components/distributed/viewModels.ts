import type { DistributedRecord } from './api';

export function asRecord(value: unknown): DistributedRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DistributedRecord : null;
}

export function readText(source: unknown, keys: readonly string[], fallback = ''): string {
  const record = asRecord(source);
  if (!record) return fallback;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

export function readValue(source: unknown, keys: readonly string[]): unknown {
  const record = asRecord(source);
  if (!record) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

/** Reads either a direct service array or a named array inside a service snapshot. */
export function readList(source: unknown, keys: readonly string[] = []): DistributedRecord[] {
  if (Array.isArray(source)) return source.map(asRecord).filter((row): row is DistributedRecord => row !== null);
  const record = asRecord(source);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.map(asRecord).filter((row): row is DistributedRecord => row !== null);
    const nested = asRecord(value);
    if (nested) {
      const items = Object.values(nested).find(Array.isArray);
      if (Array.isArray(items)) return items.map(asRecord).filter((row): row is DistributedRecord => row !== null);
    }
  }
  return [];
}

export function unwrap(source: unknown, ...keys: string[]): DistributedRecord {
  const record = asRecord(source);
  if (!record) return {};
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested) return nested;
  }
  return record;
}

/** Unknown remains explicit; a missing field is never rendered as an invented value. */
export function displayValue(value: unknown, unknownLabel = 'Unknown'): string {
  if (value === null || value === undefined || value === '') return unknownLabel;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  const record = asRecord(value);
  if (record) {
    const label = readText(record, ['label', 'name', 'status', 'remaining', 'value']);
    if (label) return label;
    const amount = readText(record, ['amount', 'remainingPercent', 'usedPercent']);
    const unit = readText(record, ['unit', 'currency']);
    if (amount) return `${amount}${unit ? ` ${unit}` : ''}`;
  }
  return unknownLabel;
}

export function idOf(row: unknown, keys: readonly string[] = ['id', 'teamId', 'deviceId', 'memberId', 'requestId']): string {
  return readText(row, keys);
}

export function nameOf(row: unknown, fallback = 'Unnamed'): string {
  return readText(row, ['name', 'title', 'displayName', 'handle', 'email', 'label'], fallback);
}
