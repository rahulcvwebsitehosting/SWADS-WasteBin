import { createHash, timingSafeEqual } from 'node:crypto';
import { getDatabase } from 'firebase-admin/database';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { isKey, validContact, ROOT } from './dispatch.js';

export function parseRegistration(data: any) {
  const binId = typeof data?.binId === 'string' ? data.binId.trim() : '';
  if (!isKey(binId) || binId.length > 48) throw new Error('Enter a valid bin ID (up to 48 characters).');
  const heightCm = Number(data.heightCm);
  if (!Number.isFinite(heightCm) || heightCm < 10 || heightCm > 350) throw new Error('Height must be between 10 and 350 cm.');
  const location = data.location;
  if (!location || typeof location !== 'object') throw new Error('Enter a valid location.');
  let cleanLocation;
  if (typeof location.address === 'string' && location.address.trim() && location.address.length <= 500) cleanLocation = { address: location.address.trim() };
  else if (typeof location.pinCode === 'string' && /^[1-9][0-9]{5}$/.test(location.pinCode)) cleanLocation = { pinCode: location.pinCode };
  else if (typeof location.latitude === 'number' && typeof location.longitude === 'number' &&
    Number.isFinite(location.latitude) && Number.isFinite(location.longitude) &&
    Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180) cleanLocation = { latitude: location.latitude, longitude: location.longitude };
  else throw new Error('Enter a six-digit PIN, address, or valid latitude/longitude.');
  const contacts = data.dispatchContacts;
  if (contacts !== undefined && (!Array.isArray(contacts) || contacts.length > 10 || !contacts.every(validContact))) throw new Error('Confirm each collection email and provide its organization and HTTPS source.');
  return { binId, deviceId: `esp32-${binId}`, heightCm, location: cleanLocation, contacts };
}

export const registerBin = onCall({ region: 'asia-southeast1' }, async request => {
  const ownerUid = request.auth?.uid;
  if (!ownerUid) throw new HttpsError('unauthenticated', 'Sign in first.');
  let input;
  try { input = parseRegistration(request.data); }
  catch (error) { throw new HttpsError('invalid-argument', (error as Error).message); }
  const db = getDatabase();
  const registryRef = db.ref(`${ROOT}/deviceRegistry/${input.deviceId}`);
  const before = (await registryRef.get()).val();
  if (!before || before.binId !== input.binId) throw new HttpsError('failed-precondition', 'This device must be provisioned before registration.');
  if (before.ownerUid && before.ownerUid !== ownerUid) throw new HttpsError('permission-denied', 'This device belongs to another account.');
  if (!before.ownerUid) {
    const claimCode = typeof request.data.claimCode === 'string' ? request.data.claimCode.trim() : '';
    const hash = createHash('sha256').update(claimCode).digest('hex');
    const expected = typeof before.claimCodeHash === 'string' ? before.claimCodeHash : '';
    if (!claimCode || expected.length !== hash.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(expected))) throw new HttpsError('permission-denied', 'Enter the device claim code supplied during provisioning.');
  }
  const claimed = await registryRef.transaction(current => {
    if (!current || current.binId !== input.binId || (current.ownerUid && current.ownerUid !== ownerUid) ||
        (!current.ownerUid && current.claimCodeHash !== before.claimCodeHash)) return;
    return { ...current, ownerUid, claimCodeHash: null, claimedAt: current.claimedAt ?? Date.now() };
  });
  if (!claimed.committed) throw new HttpsError('permission-denied', 'The device claim changed. Try again.');
  const [binSnapshot, configSnapshot] = await Promise.all([
    db.ref(`${ROOT}/bins/${input.binId}`).get(), db.ref(`${ROOT}/devices/${input.deviceId}/config`).get(),
  ]);
  const bin = binSnapshot.val();
  if (bin && (bin.ownerUid !== ownerUid || bin.deviceId !== input.deviceId)) throw new HttpsError('permission-denied', 'Bin ownership does not match.');
  const config = configSnapshot.val();
  const binPath = `${ROOT}/bins/${input.binId}`;
  const updates: Record<string, unknown> = {
    [`${binPath}/binId`]: input.binId, [`${binPath}/deviceId`]: input.deviceId,
    [`${binPath}/ownerUid`]: ownerUid, [`${binPath}/heightCm`]: input.heightCm,
    [`${binPath}/location`]: input.location,
    [`${ROOT}/devices/${input.deviceId}/config`]: { schemaVersion: 1, binId: input.binId, binHeightCm: input.heightCm,
      calibrationVersion: (config?.calibrationVersion ?? 0) + 1, updatedAt: Date.now() },
  };
  if (!bin) Object.assign(updates, { [`${binPath}/currentFillPercent`]: 0, [`${binPath}/currentState`]: 'NORMAL', [`${binPath}/createdAt`]: Date.now(), [`${binPath}/measurementValid`]: false });
  if (input.contacts !== undefined) updates[`${binPath}/dispatchContacts`] = input.contacts;
  await db.ref().update(updates);
  return { saved: true, binId: input.binId };
});

export const retryCollectionRequest = onCall({ region: 'asia-southeast1' }, async request => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const binId = request.data?.binId;
  if (!isKey(binId)) throw new HttpsError('invalid-argument', 'Invalid bin ID.');
  const db = getDatabase();
  const bin = (await db.ref(`${ROOT}/bins/${binId}`).get()).val();
  if (bin?.ownerUid !== uid) throw new HttpsError('permission-denied', 'This bin belongs to another account.');
  const state = (await db.ref(`${ROOT}/devices/${bin.deviceId}/state`).get()).val();
  if (state?.state !== 'CRITICAL' || !isKey(state.alertCycleId)) throw new HttpsError('failed-precondition', 'There is no current alert.');
  const cycleRef = db.ref(`${ROOT}/alertCycles/${state.alertCycleId}`);
  const result = await cycleRef.transaction(cycle => {
    if (!cycle || cycle.ownerUid !== uid || cycle.gmailMessageId || cycle.status === 'Cleared' || cycle.leaseUntil > Date.now()) return;
    if (cycle.sendStartedAt && request.data?.checkedSentMail !== true) return;
    return { ...cycle, status: 'Pending', sendStartedAt: null, attempts: 0, leaseUntil: 0, updatedAt: Date.now() };
  });
  if (!result.committed) throw new HttpsError('failed-precondition', 'Request is already sent, processing, or needs confirmation that no email was sent.');
  const eventId = result.snapshot.child('eventId').val();
  const event = (await db.ref(`${ROOT}/events/${eventId}`).get()).val();
  if (!event) throw new HttpsError('failed-precondition', 'Alert event is missing.');
  await db.ref(`${ROOT}/dispatchJobs/${state.alertCycleId}`).set({ event, eventId, nextAttemptAt: Date.now(), createdAt: Date.now() });
  return { queued: true };
});
