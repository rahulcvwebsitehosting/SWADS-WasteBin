// Pure dispatch orchestration. Production supplies RTDB/Gmail adapters; tests use
// an in-memory transactional store and never contact or email real recipients.
export type RecordValue = Record<string, any>;
export interface Store {
  get(path: string): Promise<any>;
  update(values: Record<string, unknown>): Promise<void>;
  transaction(path: string, change: (current: any) => any): Promise<{ committed: boolean; value: any }>;
}
export interface Services {
  store: Store;
  now(): number;
  send(ownerUid: string, subject: string, body: string, recipients: string[]): Promise<{ messageId: string; threadId: string }>;
  notify(ownerUid: string, title: string, body: string, data: Record<string, string>): Promise<void>;
}
export class AmbiguousDeliveryError extends Error {}
export const ROOT = '/swads/v1';
export const LEASE_MS = 180_000;
export const MAX_ATTEMPTS = 5;

export function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[.#$\[\]/\u0000-\u001f\u007f]/.test(value);
}
export function validContact(value: any): boolean {
  if (!value || value.verified !== true || typeof value.email !== 'string' ||
      !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value.email) || value.email.length > 254 ||
      typeof value.organization !== 'string' || !value.organization.trim() || value.organization.length > 200) return false;
  try { return new URL(value.sourceUrl).protocol === 'https:'; } catch { return false; }
}
export function verifiedContacts(value: unknown): RecordValue[] {
  const contacts = Array.isArray(value) ? value : Object.values(value ?? {});
  return [...new Map(contacts.filter(validContact).map((c: any) => [c.email.toLowerCase(), c])).values()].slice(0, 10);
}
export function validEvent(event: any, eventId: string): boolean {
  return !!event && isKey(eventId) && event.eventId === eventId && isKey(event.binId) && isKey(event.deviceId) &&
    isKey(event.alertCycleId) && ['ALERT_80', 'RESET'].includes(event.type) &&
    Number.isInteger(event.deviceEventSequence) && event.deviceEventSequence > 0;
}
export function currentCycle(state: any, event: any, now: number): 'current' | 'superseded' | 'wait' {
  if (!state || state.binId !== event.binId) return 'wait';
  if (state.state === 'CRITICAL' && state.alertCycleId === event.alertCycleId) {
    return state.measurement?.valid === true && Number.isFinite(state.lastUpdatedAt) &&
      now - state.lastUpdatedAt <= 180_000 && state.lastUpdatedAt <= now + 10_000 ? 'current' : 'wait';
  }
  return Number(state.latestEventSequence) >= event.deviceEventSequence ? 'superseded' : 'wait';
}
async function notify(services: Services, ownerUid: string, title: string, body: string, data: Record<string, string>) {
  // Email/state processing must survive notification-service outages.
  try { await services.notify(ownerUid, title, body, data); } catch { /* recorded by production adapter */ }
}
async function metadata(store: Store, eventId: string, status: string, now: number, extra: RecordValue = {}) {
  await store.update({ [`${ROOT}/eventBackend/${eventId}`]: { status, ...extra, updatedAt: now } });
}

export async function ingestEvent(services: Services, eventId: string, event: RecordValue): Promise<void> {
  const { store } = services;
  if (!validEvent(event, eventId)) {
    await metadata(store, eventId, 'Rejected', services.now(), { error: 'Invalid event contract' });
    return;
  }
  const [bin, registry] = await Promise.all([
    store.get(`${ROOT}/bins/${event.binId}`), store.get(`${ROOT}/deviceRegistry/${event.deviceId}`),
  ]);
  if (!bin?.ownerUid || bin.deviceId !== event.deviceId || registry?.binId !== event.binId || registry.ownerUid !== bin.ownerUid) {
    await metadata(store, eventId, 'Rejected', services.now(), { error: 'Device ownership does not match bin' });
    return;
  }
  const cyclePath = `${ROOT}/alertCycles/${event.alertCycleId}`;
  if (event.type === 'RESET') {
    // Create a tombstone even when RESET arrives before ALERT. No later alert
    // may resurrect this cycle, and an in-flight Gmail completion preserves it.
    const result = await store.transaction(cyclePath, current => {
      if (current && (current.binId !== event.binId || current.deviceId !== event.deviceId)) return;
      return { ...current, alertCycleId: event.alertCycleId, binId: event.binId, deviceId: event.deviceId,
        ownerUid: bin.ownerUid, status: 'Cleared', resetEventId: eventId, clearedAt: services.now(), updatedAt: services.now() };
    });
    if (!result.committed) return;
    await store.update({ [`${ROOT}/dispatchJobs/${event.alertCycleId}`]: null });
    await store.transaction(`${ROOT}/activeAlerts/${event.binId}`, current =>
      current?.alertCycleId === event.alertCycleId ? null : undefined);
    await metadata(store, eventId, 'Cleared', services.now(), { alertCycleId: event.alertCycleId });
    await notify(services, bin.ownerUid, 'Bin Cleared', `Bin ${event.binId} has been emptied.`, { type: 'BIN_CLEARED', binId: event.binId });
    return;
  }
  const result = await store.transaction(cyclePath, current => {
    if (current) return;
    return { alertCycleId: event.alertCycleId, eventId, binId: event.binId, deviceId: event.deviceId,
      ownerUid: bin.ownerUid, status: 'Pending', attempts: 0, createdAt: services.now(), updatedAt: services.now() };
  });
  if (result.value?.status === 'Cleared' || result.value?.gmailMessageId) return;
  await store.transaction(`${ROOT}/dispatchJobs/${event.alertCycleId}`, current => current ?? {
    event, eventId, nextAttemptAt: services.now(), createdAt: services.now(),
  });
  if (result.committed) {
    await notify(services, bin.ownerUid, 'Bin needs collection', `Bin ${event.binId} reached its fill threshold.`, { type: 'BIN_FULL', binId: event.binId });
  }
  await processDispatch(services, event.alertCycleId);
}

export async function processDispatch(services: Services, cycleId: string): Promise<void> {
  const { store } = services;
  const jobPath = `${ROOT}/dispatchJobs/${cycleId}`;
  const cyclePath = `${ROOT}/alertCycles/${cycleId}`;
  const job = await store.get(jobPath);
  if (!job || job.nextAttemptAt > services.now() || !validEvent(job.event, job.eventId)) return;
  const { event, eventId } = job;
  const now = services.now();
  const claim = await store.transaction(cyclePath, cycle => {
    if (!cycle || ['Cleared', 'Superseded', 'AwaitingClearance', 'ReviewRequired', 'DispatchFailed'].includes(cycle.status) || cycle.gmailMessageId) return;
    if (cycle.leaseUntil > now) return;
    if (cycle.sendStartedAt) {
      return { ...cycle, status: 'ReviewRequired', error: 'Previous send outcome is unknown; inspect Gmail before retrying.', leaseUntil: 0, updatedAt: now };
    }
    return { ...cycle, status: 'Dispatching', attempts: (cycle.attempts ?? 0) + 1, leaseUntil: now + LEASE_MS, updatedAt: now };
  });
  if (!claim.committed) {
    if (claim.value && ['Cleared', 'Superseded', 'AwaitingClearance', 'ReviewRequired', 'DispatchFailed'].includes(claim.value.status)) {
      await store.update({ [jobPath]: null });
    }
    return;
  }
  if (claim.value.status === 'ReviewRequired') {
    await store.update({ [jobPath]: null });
    await metadata(store, eventId, 'ReviewRequired', now);
    return;
  }
  // A scheduled recovery can reclaim a crashed worker after its lease expires.
  await store.update({ [`${jobPath}/nextAttemptAt`]: now + LEASE_MS });
  const [bin, registry, state] = await Promise.all([
    store.get(`${ROOT}/bins/${event.binId}`), store.get(`${ROOT}/deviceRegistry/${event.deviceId}`),
    store.get(`${ROOT}/devices/${event.deviceId}/state`),
  ]);
  const disposition = currentCycle(state, event, services.now());
  if (disposition === 'superseded') {
    await store.transaction(cyclePath, c => c?.status === 'Cleared' ? undefined : { ...c, status: 'Superseded', leaseUntil: 0, updatedAt: services.now() });
    await store.update({ [jobPath]: null });
    await metadata(store, eventId, 'Superseded', services.now());
    return;
  }
  const retry = async (status: string, error: string) => {
    const attempts = claim.value.attempts;
    const terminal = attempts >= MAX_ATTEMPTS;
    const result = await store.transaction(cyclePath, c => c?.status === 'Cleared' ? undefined : {
      ...c, status: terminal ? 'DispatchFailed' : status, error, leaseUntil: 0, sendStartedAt: null, updatedAt: services.now(),
    });
    if (result.value?.status === 'Cleared' || terminal) await store.update({ [jobPath]: null });
    else await store.update({ [`${jobPath}/nextAttemptAt`]: services.now() + Math.min(15 * 60_000, 60_000 * 2 ** (attempts - 1)) });
    await metadata(store, eventId, result.value?.status ?? status, services.now(), { error });
  };
  if (!bin?.ownerUid || bin.deviceId !== event.deviceId || registry?.binId !== event.binId || registry.ownerUid !== bin.ownerUid) {
    await retry('RetryPending', 'Device registration changed'); return;
  }
  if (disposition === 'wait') { await retry('WaitingForDevice', 'Waiting for a fresh measurement for this alert cycle'); return; }
  const contacts = verifiedContacts(bin.dispatchContacts);
  if (!contacts.length) {
    await retry('NeedsContacts', 'Add a verified collection contact in the bin settings.');
    if (claim.value.attempts === 1) await notify(services, bin.ownerUid, 'Collection contact needed', `Edit ${event.binId} to add a verified collection email.`, { type: 'CONTACT_NEEDED', binId: event.binId });
    return;
  }
  let sentResult: { messageId: string; threadId: string } | undefined;
  try {
    const location = bin.location?.address ?? (bin.location?.pinCode ? `PIN ${bin.location.pinCode}` : `GPS ${bin.location?.latitude}, ${bin.location?.longitude}`);
    // Recheck immediately before sending; reset processing may have happened
    // while we were reading contacts. Persist intent before external side effect.
    const start = await store.transaction(cyclePath, c =>
      c?.status === 'Dispatching' && c.leaseUntil === claim.value.leaseUntil ? { ...c, sendStartedAt: services.now() } : undefined);
    if (!start.committed) return;
    const freshState = await store.get(`${ROOT}/devices/${event.deviceId}/state`);
    if (currentCycle(freshState, event, services.now()) !== 'current') { await retry('WaitingForDevice', 'Bin state changed before sending'); return; }
    const result = await services.send(bin.ownerUid,
      `Collection requested: Bin ${event.binId} at ${String(location).replace(/[\r\n]/g, ' ')}`,
      `SWADS detected a confirmed fill alert.\r\nBin: ${event.binId}\r\nLocation: ${location}\r\nFill at detection: ${event.measurement?.fillPercent ?? 'unknown'}%\r\nPlease arrange collection.\r\nReference: ${cycleId}`,
      contacts.map(c => c.email.toLowerCase()));
    sentResult = result;
    const complete = await store.transaction(cyclePath, c => ({ ...c,
      status: c?.status === 'Cleared' ? 'Cleared' : 'AwaitingClearance', gmailMessageId: result.messageId,
      gmailThreadId: result.threadId, recipientEmails: contacts.map(c => c.email), dispatchedAt: services.now(), leaseUntil: 0, updatedAt: services.now() }));
    await store.update({ [jobPath]: null });
    await metadata(store, eventId, complete.value.status === 'Cleared' ? 'Cleared' : 'EmailsSent', services.now(), { gmailMessageId: result.messageId });
    await notify(services, bin.ownerUid, 'Collection request sent', `A collection email was sent for ${event.binId}.`, { type: 'DISPATCH_SENT', binId: event.binId });
  } catch (error) {
    if (sentResult) {
      // A database/logging failure AFTER Gmail accepted the message must never
      // enter the pre-delivery retry path or clear persisted send intent.
      const result = await store.transaction(cyclePath, c => ({ ...c,
        status: c?.status === 'Cleared' ? 'Cleared' : 'AwaitingClearance',
        gmailMessageId: sentResult!.messageId, gmailThreadId: sentResult!.threadId,
        dispatchedAt: services.now(), leaseUntil: 0, updatedAt: services.now() }));
      await store.update({ [jobPath]: null });
      await metadata(store, eventId, result.value.status === 'Cleared' ? 'Cleared' : 'EmailsSent', services.now(), { gmailMessageId: sentResult.messageId });
      return;
    }
    if (error instanceof AmbiguousDeliveryError) {
      const result = await store.transaction(cyclePath, c => ({ ...c, status: c?.status === 'Cleared' ? 'Cleared' : 'ReviewRequired', error: error.message, leaseUntil: 0, updatedAt: services.now() }));
      await store.update({ [jobPath]: null });
      await metadata(store, eventId, result.value.status, services.now(), { error: error.message });
      await notify(services, bin.ownerUid, 'Check collection email', 'Delivery outcome is uncertain. Check Sent mail before retrying.', { type: 'DISPATCH_REVIEW', binId: event.binId });
    } else await retry('RetryPending', error instanceof Error ? error.message : 'Dispatch failed');
  }
}
