// Administrator-only, explicit provisioning. Uses Application Default Credentials;
// never put a service-account key, Wi-Fi password, or device password in Git.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const binId = process.argv[2];
if (!binId || !/^[a-zA-Z0-9_-]{1,48}$/.test(binId)) throw new Error('Usage: npm run provision -- bin-001');
const projectId = process.env.GCLOUD_PROJECT ?? 'swads-wastebin';
const deviceId = `esp32-${binId}`;
const email = `${deviceId}@swads.local`;
const claimCode = randomBytes(24).toString('base64url');
const password = randomBytes(24).toString('base64url');
const app = initializeApp({ credential: applicationDefault(), projectId,
  databaseURL: process.env.FIREBASE_DATABASE_URL ?? `https://${projectId}-default-rtdb.asia-southeast1.firebasedatabase.app` });
const db = getDatabase(app);
if ((await db.ref(`/swads/v1/deviceRegistry/${deviceId}`).get()).exists()) throw new Error('Device already provisioned. Refusing to replace existing credentials or ownership.');
const auth = getAuth(app);
const user = await auth.createUser({ email, password });
try {
  const result = await db.ref(`/swads/v1/deviceRegistry/${deviceId}`).transaction(current => current ?? {
    binId, firebaseUid: user.uid, claimCodeHash: createHash('sha256').update(claimCode).digest('hex'), createdAt: Date.now(),
  });
  if (!result.committed || result.snapshot.child('firebaseUid').val() !== user.uid) throw new Error('Device registry was created concurrently.');
  await db.ref(`/swads/v1/deviceUsers/${user.uid}/${deviceId}`).set(true);
  const directory = resolve('.secrets');
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${deviceId}.json`);
  await writeFile(file, JSON.stringify({ deviceId, binId, email, password, claimCode }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`Provisioned ${deviceId}. Private credentials saved in ${file}. Enter its claim code in the Android app.`);
} catch (error) {
  // Preserve a registered identity if credential-file writing failed. An admin
  // can recover its password rather than silently invalidating live mappings.
  console.error('Provisioning did not finish. Inspect the registry before retrying; credentials were not printed.');
  throw error;
}
