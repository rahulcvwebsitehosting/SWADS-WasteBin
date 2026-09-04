import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  equalTo,
  get,
  orderByChild,
  query,
  ref,
  set,
  update,
} from "firebase/database";

const projectId = "swads-wastebin";
const rootPath = "swads/v1";
let testEnv;

function bin(ownerUid, binId = "bin-001", deviceId = "esp32-bin-001") {
  return {
    binId,
    deviceId,
    heightCm: 50,
    location: { pinCode: "641001" },
    ownerUid,
    currentFillPercent: 0,
    currentState: "NORMAL",
  };
}

function event(eventId = "esp32-bin-001-1-1") {
  return {
    schemaVersion: 1,
    eventId,
    type: "ALERT_80",
    source: "ESP32",
    deviceId: "esp32-bin-001",
    binId: "bin-001",
    alertCycleId: eventId,
    measurement: { valid: true, fillPercent: 82.5 },
    receivedAt: 1,
  };
}

async function seedRegistration() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const database = context.database();
    await update(ref(database, rootPath), {
      "bins/bin-001": bin("owner-1"),
      "bins/bin-002": bin("owner-2", "bin-002", "esp32-bin-002"),
      "deviceRegistry/esp32-bin-001": {
        ownerUid: "owner-1",
        binId: "bin-001",
      },
      "deviceUsers/device-uid/esp32-bin-001": true,
    });
  });
}

before(async () => {
  const rules = await readFile(new URL("../../database.rules.json", import.meta.url), "utf8");
  testEnv = await initializeTestEnvironment({
    projectId,
    database: { rules },
  });
});

beforeEach(async () => {
  await testEnv.clearDatabase();
});

after(async () => {
  await testEnv.cleanup();
});

test("owners can register a valid bin but cannot transfer its ownership", async () => {
  const ownerDb = testEnv.authenticatedContext("owner-1").database();
  await assertSucceeds(
    update(ref(ownerDb, rootPath), {
      "bins/bin-001": bin("owner-1"),
      "deviceRegistry/esp32-bin-001": {
        ownerUid: "owner-1",
        binId: "bin-001",
      },
    }),
  );
  await assertFails(
    update(ref(ownerDb, `${rootPath}/bins/bin-001`), {
      ownerUid: "owner-2",
    }),
  );
});

test("bin reads require an owner-scoped query", async () => {
  await seedRegistration();
  const ownerDb = testEnv.authenticatedContext("owner-1").database();
  const binsRef = ref(ownerDb, `${rootPath}/bins`);

  const snapshot = await assertSucceeds(
    get(query(binsRef, orderByChild("ownerUid"), equalTo("owner-1"))),
  );
  assert.deepEqual(Object.keys(snapshot.val()), ["bin-001"]);
  await assertFails(get(binsRef));
  await assertFails(
    get(query(binsRef, orderByChild("ownerUid"), equalTo("owner-2"))),
  );
});

test("a provisioned device can only publish state for its registered bin", async () => {
  await seedRegistration();
  const deviceDb = testEnv.authenticatedContext("device-uid").database();
  const stateRef = ref(deviceDb, `${rootPath}/devices/esp32-bin-001/state`);

  await assertSucceeds(
    set(stateRef, {
      deviceId: "esp32-bin-001",
      binId: "bin-001",
      state: "CRITICAL",
      measurement: { fillPercent: 82.5 },
    }),
  );
  await assertFails(
    set(stateRef, {
      deviceId: "esp32-bin-001",
      binId: "bin-002",
      state: "CRITICAL",
      measurement: { fillPercent: 82.5 },
    }),
  );
});

test("event retries cannot alter backend metadata or target another bin", async () => {
  await seedRegistration();
  const deviceDb = testEnv.authenticatedContext("device-uid").database();
  const eventId = "esp32-bin-001-1-1";
  const eventRef = ref(deviceDb, `${rootPath}/events/${eventId}`);
  const eventValue = event(eventId);

  await assertSucceeds(set(eventRef, eventValue));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await set(ref(context.database(), `${rootPath}/eventBackend/${eventId}`), {
      status: "Dispatching",
    });
  });

  await assertSucceeds(update(eventRef, eventValue));
  await assertSucceeds(set(eventRef, eventValue));
  await assertFails(
    update(ref(deviceDb, `${rootPath}/eventBackend/${eventId}`), {
      status: "Forged",
    }),
  );
  await assertFails(
    set(ref(deviceDb, `${rootPath}/events/wrong-bin-event`), {
      ...event("wrong-bin-event"),
      binId: "bin-002",
    }),
  );
});

test("OAuth refresh tokens are not readable by the client", async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await set(ref(context.database(), `${rootPath}/users/owner-1/googleOAuth`), {
      refreshToken: "secret-refresh-token",
    });
  });
  const ownerDb = testEnv.authenticatedContext("owner-1").database();
  await assertFails(get(ref(ownerDb, `${rootPath}/users/owner-1/googleOAuth`)));
  await assertSucceeds(
    set(ref(ownerDb, `${rootPath}/users/owner-1/fcmTokens/token-1`), "fcm-token"),
  );
});
