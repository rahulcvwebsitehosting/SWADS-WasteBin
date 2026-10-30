import { getDatabase } from 'firebase-admin/database';
import { logger } from 'firebase-functions';
import { onValueCreated, onValueWritten } from 'firebase-functions/v2/database';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { SecretParam } from 'firebase-functions/params';
import { ingestEvent, processDispatch, isKey, ROOT, type Services, type Store } from './dispatch.js';

export function databaseStore(): Store {
  return {
    get: async path => (await getDatabase().ref(path).get()).val(),
    update: async values => { await getDatabase().ref().update(values); },
    transaction: async (path, change) => {
      const result = await getDatabase().ref(path).transaction(change);
      return { committed: result.committed, value: result.snapshot.val() };
    },
  };
}

export async function mirrorState(store: Store, deviceId: string): Promise<void> {
  // Read the latest record instead of trusting delivery order of RTDB triggers.
  const state = await store.get(`${ROOT}/devices/${deviceId}/state`);
  if (!state || !isKey(state.binId) || !Number.isFinite(state.lastUpdatedAt)) return;
  const registry = await store.get(`${ROOT}/deviceRegistry/${deviceId}`);
  if (registry?.binId !== state.binId) return;
  const cycle = isKey(state.alertCycleId) ? await store.get(`${ROOT}/alertCycles/${state.alertCycleId}`) : null;
  await store.transaction(`${ROOT}/bins/${state.binId}`, bin => {
    if (!bin?.ownerUid || registry.ownerUid !== bin.ownerUid || bin.deviceId !== deviceId ||
        (bin.lastTelemetryAt ?? 0) > state.lastUpdatedAt) return;
    const fill = state.measurement?.fillPercent;
    const valid = state.measurement?.valid === true && typeof fill === 'number' && Number.isFinite(fill) && fill >= 0 && fill <= 100;
    return { ...bin,
      currentFillPercent: valid ? fill : (bin.currentFillPercent ?? 0),
      currentState: state.state === 'CRITICAL' ? 'ALERT_80' : valid && fill <= 20 ? 'CLEARED' : 'NORMAL',
      sensorHealth: state.measurement?.sensorHealth ?? 'INVALID',
      measurementValid: valid,
      activeAlertCycleId: state.alertCycleId ?? null,
      dispatchStatus: cycle?.ownerUid === bin.ownerUid ? cycle.status :
        bin.activeAlertCycleId === state.alertCycleId ? (bin.dispatchStatus ?? '') : '',
      dispatchUpdatedAt: cycle?.ownerUid === bin.ownerUid ? (cycle.updatedAt ?? 0) : 0,
      lastTelemetryAt: state.lastUpdatedAt,
      lastValidMeasurementAt: valid ? state.lastUpdatedAt : (bin.lastValidMeasurementAt ?? 0),
    };
  });
}

export function createEventHandlers(services: Services, secrets: SecretParam[]) {
  const region = process.env.FUNCTIONS_EMULATOR === 'true' ? 'us-central1' : 'asia-southeast1';
  const common = { region, instance: 'swads-wastebin-default-rtdb', retry: true };
  const dispatchOnAlert = onValueCreated({ ...common, ref: `${ROOT}/events/{eventId}`, secrets, timeoutSeconds: 120 }, async trigger => {
    const event = trigger.data.val();
    if (event?.type === 'ALERT_80') await ingestEvent(services, trigger.params.eventId, event);
  });
  const clearOnReset = onValueCreated({ ...common, ref: `${ROOT}/events/{eventId}` }, async trigger => {
    const event = trigger.data.val();
    if (event?.type === 'RESET') await ingestEvent(services, trigger.params.eventId, event);
  });
  const syncBinState = onValueWritten({ ...common, ref: `${ROOT}/devices/{deviceId}/state` }, async trigger => {
    await mirrorState(services.store, trigger.params.deviceId);
  });
  const retryDispatchJobs = onSchedule({ region, schedule: 'every 1 minutes', secrets, timeoutSeconds: 120, maxInstances: 1 }, async () => {
    const snapshot = await getDatabase().ref(`${ROOT}/dispatchJobs`).orderByChild('nextAttemptAt').endAt(Date.now()).limitToFirst(25).get();
    const jobs: string[] = [];
    snapshot.forEach(child => { if (child.key) jobs.push(child.key); });
    // Bound simultaneous Gmail requests and leave remaining due jobs for the next run.
    for (let offset = 0; offset < jobs.length; offset += 5) {
      const results = await Promise.allSettled(jobs.slice(offset, offset + 5).map(id => processDispatch(services, id)));
      for (const result of results) if (result.status === 'rejected') logger.error('Dispatch recovery failed', result.reason);
    }
  });
  const syncDispatchStatus = onValueWritten({ ...common, ref: `${ROOT}/alertCycles/{cycleId}` }, async trigger => {
    const cycle = await services.store.get(`${ROOT}/alertCycles/${trigger.params.cycleId}`);
    if (!cycle || !isKey(cycle.binId)) return;
    await services.store.transaction(`${ROOT}/bins/${cycle.binId}`, bin =>
      bin?.ownerUid === cycle.ownerUid && bin.activeAlertCycleId === trigger.params.cycleId &&
      (bin.dispatchUpdatedAt ?? 0) <= (cycle.updatedAt ?? 0) ?
        { ...bin, dispatchStatus: cycle.status, dispatchUpdatedAt: cycle.updatedAt ?? 0 } : undefined);
  });
  return { dispatchOnAlert, clearOnReset, syncBinState, retryDispatchJobs, syncDispatchStatus };
}
