import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestEvent, processDispatch, verifiedContacts, validContact, currentCycle, AmbiguousDeliveryError, LEASE_MS, ROOT } from '../lib/dispatch.js';
import { mirrorState } from '../lib/events.js';
import { parseRegistration } from '../lib/registration.js';

class MemoryStore {
  data = {};
  async get(path) { return structuredClone(path.split('/').filter(Boolean).reduce((v, k) => v?.[k], this.data) ?? null); }
  async update(values) {
    for (const [path, value] of Object.entries(values)) {
      const keys = path.split('/').filter(Boolean); const last = keys.pop(); let node = this.data;
      for (const key of keys) node = node[key] ??= {};
      if (value === null) delete node[last]; else node[last] = structuredClone(value);
    }
  }
  async transaction(path, fn) {
    // Synchronous read/commit models RTDB serialization; no await inside it.
    const keys = path.split('/').filter(Boolean); const previous = keys.reduce((v, k) => v?.[k], this.data) ?? null;
    const next = fn(structuredClone(previous));
    if (next === undefined) return { committed: false, value: structuredClone(previous) };
    const last = keys.pop(); let node = this.data; for (const key of keys) node = node[key] ??= {};
    if (next === null) delete node[last]; else node[last] = structuredClone(next);
    return { committed: true, value: structuredClone(next) };
  }
}
async function fixture() {
  let now = 1000000; const store = new MemoryStore(); const sent = []; const notifications = [];
  const event = { eventId: 'device-1-1', type: 'ALERT_80', deviceId: 'esp32-bin-001', binId: 'bin-001', alertCycleId: 'device-1-1', deviceEventSequence: 1, measurement: { fillPercent: 85 } };
  const contact = { organization: 'Test collection office', email: 'collection@example.test', sourceUrl: 'https://example.test/contact', verified: true };
  const state = { deviceId: event.deviceId, binId: event.binId, state: 'CRITICAL', alertCycleId: event.alertCycleId, latestEventSequence: 1,
    measurement: { valid: true, fillPercent: 85, sensorHealth: 'OK' }, lastUpdatedAt: now };
  await store.update({ [`${ROOT}/bins/bin-001`]: { ownerUid: 'owner-1', deviceId: event.deviceId, location: { pinCode: '600001' }, dispatchContacts: [contact] },
    [`${ROOT}/deviceRegistry/${event.deviceId}`]: { ownerUid: 'owner-1', binId: event.binId }, [`${ROOT}/devices/${event.deviceId}/state`]: state });
  const services = { store, now: () => now, send: async (...args) => { sent.push(args); return { messageId: 'gmail-1', threadId: 'thread-1' }; }, notify: async (...args) => { notifications.push(args); } };
  return { services, store, sent, notifications, event, state, contact, advance: ms => { now += ms; } };
}
const cyclePath = `${ROOT}/alertCycles/device-1-1`;
const jobPath = `${ROOT}/dispatchJobs/device-1-1`;
test('a confirmed alert sends once even when the trigger is delivered twice', async () => {
  const f = await fixture(); await ingestEvent(f.services, f.event.eventId, f.event); await ingestEvent(f.services, f.event.eventId, f.event);
  assert.equal(f.sent.length, 1); assert.equal((await f.store.get(cyclePath)).status, 'AwaitingClearance'); assert.equal(await f.store.get(jobPath), null);
});
test('concurrent alert deliveries share one transactional lease', async () => {
  const f = await fixture(); await Promise.all([ingestEvent(f.services, f.event.eventId, f.event), ingestEvent(f.services, f.event.eventId, f.event)]); assert.equal(f.sent.length, 1);
});
test('a reset delivered before its alert prevents that alert from sending', async () => {
  const f = await fixture(); const reset = { ...f.event, eventId: 'device-1-2', type: 'RESET', deviceEventSequence: 2 };
  await ingestEvent(f.services, reset.eventId, reset); await ingestEvent(f.services, f.event.eventId, f.event);
  assert.equal(f.sent.length, 0); assert.equal((await f.store.get(cyclePath)).status, 'Cleared');
});
test('Gmail completion cannot reopen a cycle reset during sending', async () => {
  const f = await fixture(); f.services.send = async () => {
    const reset = { ...f.event, eventId: 'device-1-2', type: 'RESET', deviceEventSequence: 2 };
    await ingestEvent(f.services, reset.eventId, reset); return { messageId: 'gmail-1', threadId: 'thread-1' };
  };
  await ingestEvent(f.services, f.event.eventId, f.event); const cycle = await f.store.get(cyclePath);
  assert.equal(cycle.status, 'Cleared'); assert.equal(cycle.gmailMessageId, 'gmail-1');
});
test('a definite pre-delivery failure is retried and later succeeds', async () => {
  const f = await fixture(); const send = f.services.send; let calls = 0;
  f.services.send = async (...args) => { if (++calls === 1) throw new Error('OAuth temporarily unavailable'); return send(...args); };
  await ingestEvent(f.services, f.event.eventId, f.event); assert.equal((await f.store.get(cyclePath)).status, 'RetryPending');
  f.advance(60001); await processDispatch(f.services, f.event.alertCycleId); assert.equal(f.sent.length, 1);
});
test('ambiguous Gmail delivery requires review and is never automatically resent', async () => {
  const f = await fixture(); let calls = 0; f.services.send = async () => { ++calls; throw new AmbiguousDeliveryError('response lost'); };
  await ingestEvent(f.services, f.event.eventId, f.event); f.advance(LEASE_MS + 1); await ingestEvent(f.services, f.event.eventId, f.event);
  assert.equal(calls, 1); assert.equal((await f.store.get(cyclePath)).status, 'ReviewRequired');
});
test('crash recovery refuses to resend after persisted send intent', async () => {
  const f = await fixture(); await f.store.update({ [cyclePath]: { ownerUid: 'owner-1', status: 'Dispatching', sendStartedAt: 1, leaseUntil: 1 }, [jobPath]: { event: f.event, eventId: f.event.eventId, nextAttemptAt: 1 } });
  await processDispatch(f.services, f.event.alertCycleId); assert.equal(f.sent.length, 0); assert.equal((await f.store.get(cyclePath)).status, 'ReviewRequired');
});
test('offline historical alert is skipped when newer state reports empty', async () => {
  const f = await fixture(); await f.store.update({ [`${ROOT}/devices/${f.event.deviceId}/state`]: { ...f.state, state: 'NORMAL', alertCycleId: null, latestEventSequence: 2 } });
  await ingestEvent(f.services, f.event.eventId, f.event); assert.equal(f.sent.length, 0); assert.equal((await f.store.get(cyclePath)).status, 'Superseded');
});
test('stale or invalid measurements do not initiate email delivery', async () => {
  const f = await fixture(); f.advance(180001); await ingestEvent(f.services, f.event.eventId, f.event);
  assert.equal(f.sent.length, 0); assert.equal((await f.store.get(cyclePath)).status, 'WaitingForDevice');
  assert.equal(currentCycle({ ...f.state, measurement: { valid: false } }, f.event, 1000000), 'wait');
});
test('AI-like unverified contacts do not become recipients; no regional fallback', async () => {
  const f = await fixture(); await f.store.update({ [`${ROOT}/bins/bin-001/dispatchContacts`]: [{ ...f.contact, verified: false }] });
  await ingestEvent(f.services, f.event.eventId, f.event); assert.equal(f.sent.length, 0); assert.equal((await f.store.get(cyclePath)).status, 'NeedsContacts');
  assert.equal(validContact({ ...f.contact, email: 'a@example.test\r\nBcc:x@example.test' }), false);
  assert.equal(verifiedContacts([f.contact, { ...f.contact, email: f.contact.email.toUpperCase() }]).length, 1);
});
test('forged events and mismatched device ownership are rejected', async () => {
  const f = await fixture(); await ingestEvent(f.services, 'wrong-id', f.event);
  await f.store.update({ [`${ROOT}/deviceRegistry/${f.event.deviceId}/ownerUid`]: 'other-owner' });
  await ingestEvent(f.services, f.event.eventId, f.event); assert.equal(f.sent.length, 0); assert.equal((await f.store.get(`${ROOT}/eventBackend/${f.event.eventId}`)).status, 'Rejected');
});
test('notification outage does not turn successful email into a retry', async () => {
  const f = await fixture(); f.services.notify = async () => { throw new Error('FCM unavailable'); };
  await ingestEvent(f.services, f.event.eventId, f.event); assert.equal((await f.store.get(cyclePath)).status, 'AwaitingClearance'); assert.equal(f.sent.length, 1);
});
test('state mirror preserves last valid fill and exposes sensor failure', async () => {
  const f = await fixture(); await mirrorState(f.store, f.event.deviceId); f.advance(60000);
  await f.store.update({ [`${ROOT}/devices/${f.event.deviceId}/state`]: { ...f.state, lastUpdatedAt: f.services.now(), measurement: { valid: false, sensorHealth: 'TIMEOUT' } } });
  await mirrorState(f.store, f.event.deviceId); const bin = await f.store.get(`${ROOT}/bins/bin-001`);
  assert.equal(bin.currentFillPercent, 85); assert.equal(bin.measurementValid, false); assert.equal(bin.lastValidMeasurementAt, 1000000);
});
test('out-of-order state mirroring cannot overwrite newer telemetry', async () => {
  const f = await fixture(); await f.store.update({ [`${ROOT}/bins/bin-001/lastTelemetryAt`]: 2000000, [`${ROOT}/bins/bin-001/currentFillPercent`]: 95 });
  await mirrorState(f.store, f.event.deviceId); assert.equal((await f.store.get(`${ROOT}/bins/bin-001`)).currentFillPercent, 95);
});
test('registration rejects invalid IDs, coordinates, height and unverified contact', () => {
  const base = { binId: 'bin-001', heightCm: 50, location: { pinCode: '600001' } };
  assert.equal(parseRegistration(base).deviceId, 'esp32-bin-001');
  for (const input of [{ ...base, binId: 'bad/id' }, { ...base, heightCm: 'NaN' }, { ...base, location: { pinCode: '12' } }, { ...base, location: { latitude: 91, longitude: 80 } }, { ...base, dispatchContacts: [{ email: 'x@example.test' }] }]) assert.throws(() => parseRegistration(input));
});

test('a database failure after Gmail acceptance cannot schedule a second email', async () => {
  const f = await fixture(); const originalUpdate = f.store.update.bind(f.store); let fail = true;
  f.store.update = async values => {
    if (fail && f.sent.length === 1 && Object.hasOwn(values, jobPath)) { fail = false; throw new Error('database temporarily unavailable'); }
    return originalUpdate(values);
  };
  await ingestEvent(f.services, f.event.eventId, f.event);
  await ingestEvent(f.services, f.event.eventId, f.event);
  assert.equal(f.sent.length, 1); assert.equal((await f.store.get(cyclePath)).gmailMessageId, 'gmail-1');
});

test('a missing device report reaches a bounded terminal failure', async () => {
  const f = await fixture(); await f.store.update({ [`${ROOT}/devices/${f.event.deviceId}/state`]: null });
  await ingestEvent(f.services, f.event.eventId, f.event);
  for (let attempt = 1; attempt < 5; attempt++) { f.advance(1000000); await processDispatch(f.services, f.event.alertCycleId); }
  assert.equal(f.sent.length, 0); assert.equal((await f.store.get(cyclePath)).status, 'DispatchFailed'); assert.equal(await f.store.get(jobPath), null);
});
