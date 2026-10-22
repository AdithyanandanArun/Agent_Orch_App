import test from 'node:test';
import assert from 'node:assert/strict';
import { displayValue, idOf, nameOf, readList, readText, unwrap } from './viewModels.ts';

test('snapshot adapters tolerate missing and malformed service sections', () => {
  assert.deepEqual(readList(undefined, ['devices']), []);
  assert.deepEqual(readList({ devices: [null, 'not a device', { id: 'd-1' }] }, ['devices']), [{ id: 'd-1' }]);
  assert.equal(readText({ status: null, state: 'offline' }, ['status', 'state'], 'unknown'), 'offline');
});

test('snapshot adapters read direct and nested service arrays without making up values', () => {
  const snapshot = { teams: { devices: [{ device: { deviceId: 'dev-7', name: 'Studio' } }] } };
  const [outer] = readList(snapshot.teams, ['devices']);
  const device = unwrap(outer, 'device');
  assert.equal(idOf(device, ['id', 'deviceId']), 'dev-7');
  assert.equal(nameOf(device), 'Studio');
  assert.equal(displayValue(null), 'Unknown');
  assert.equal(displayValue({ remaining: 'reported 4' }), 'reported 4');
});
