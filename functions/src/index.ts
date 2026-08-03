import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getMessaging } from "firebase-admin/messaging";
import { logger, setGlobalOptions } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import {
  onValueCreated,
  onValueWritten,
} from "firebase-functions/v2/database";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { google } from "googleapis";
import OpenAI from "openai";

initializeApp();
setGlobalOptions({
  region: "asia-southeast1",
  maxInstances: 10,
});

const database = getDatabase();
const ROOT = "/swads/v1";
const EVENT_PATH = `${ROOT}/events/{eventId}`;

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const GOOGLE_OAUTH_CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");

type EventType = "ALERT_80" | "RESET";
type ContactType = "municipal" | "private_recycler";
type ContactConfidence = "high" | "medium" | "low";

interface EspEvent {
  eventId: string;
  type: EventType;
  deviceId: string;
  binId: string;
  alertCycleId?: string | null;
  receivedAt?: number;
  measurement?: {
    distanceCm?: number | null;
    fillPercent?: number | null;
  };
}

interface BinRecord {
  ownerUid: string;
  displayName?: string;
  location?: {
    latitude?: number;
    longitude?: number;
    lat?: number;
    lng?: number;
    pinCode?: string;
    address?: string;
  };
}

interface DeviceState {
  binId?: string;
  state?: "NORMAL" | "CRITICAL";
  measurement?: {
    fillPercent?: number | null;
  };
  lastUpdatedAt?: number;
}

interface Contact {
  organization: string;
  email: string;
  type: ContactType;
  sourceUrl: string;
  confidence: ContactConfidence;
}

interface ResearchResult {
  contacts: Contact[];
  source: "openai" | "fallback";
  error?: string;
}

const DEFAULT_TAMIL_NADU_CONTACTS: Contact[] = [
  {
    organization: "Directorate of Municipal Administration, Tamil Nadu",
    email: "cma.tncma@nic.in",
    type: "municipal",
    sourceUrl: "https://www.tnurbantree.tn.gov.in/contact-us/",
    confidence: "high",
  },
  {
    organization: "Coimbatore City Municipal Corporation",
    email: "commr.coimbatore@tn.gov.in",
    type: "municipal",
    sourceUrl:
      "https://www.tnurbantree.tn.gov.in/municipal-e-mail-ids/",
    confidence: "high",
  },
  {
    organization: "Madurai Corporation",
    email: "commr.madurai@tn.gov.in",
    type: "municipal",
    sourceUrl: "https://www.tnurbantree.tn.gov.in/madurai/contact-us/",
    confidence: "high",
  },
];

const CONTACT_RESPONSE_SCHEMA = {
  name: "waste_management_contacts",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      contacts: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            organization: { type: "string" },
            email: { type: "string" },
            type: {
              type: "string",
              enum: ["municipal", "private_recycler"],
            },
            sourceUrl: { type: "string" },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
          },
          required: [
            "organization",
            "email",
            "type",
            "sourceUrl",
            "confidence",
          ],
        },
      },
    },
    required: ["contacts"],
  },
} as const;

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isFirebaseKey(value: string): boolean {
  return value.length > 0 && !/[.#$[\]/\u0000-\u001F\u007F]/.test(value);
}

function sanitizeOneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export const saveGoogleOAuthCode = onCall(
  {
    secrets: [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET],
  },
  async (request) => {
    const ownerUid = request.auth?.uid;
    if (!ownerUid) {
      throw new HttpsError("unauthenticated", "Sign in is required");
    }

    const code =
      typeof request.data?.code === "string" ? request.data.code.trim() : "";
    if (!code) {
      throw new HttpsError("invalid-argument", "OAuth code is required");
    }

    const oauthClient = new google.auth.OAuth2(
      GOOGLE_OAUTH_CLIENT_ID.value(),
      GOOGLE_OAUTH_CLIENT_SECRET.value(),
      "postmessage",
    );
    const { tokens } = await oauthClient.getToken(code);
    if (!tokens.refresh_token) {
      throw new HttpsError(
        "failed-precondition",
        "Google did not return a refresh token. Revoke SWADS access and sign in again.",
      );
    }

    await database.ref(`${ROOT}/users/${ownerUid}/googleOAuth`).set({
      refreshToken: tokens.refresh_token,
      scope: tokens.scope ?? "https://www.googleapis.com/auth/gmail.send",
      updatedAt: Date.now(),
    });

    return { saved: true };
  },
);

function locationDescription(bin: BinRecord): string {
  const location = bin.location ?? {};
  const latitude = location.latitude ?? location.lat;
  const longitude = location.longitude ?? location.lng;
  const parts: string[] = [];

  if (location.address?.trim()) {
    parts.push(location.address.trim());
  }
  if (location.pinCode?.trim()) {
    parts.push(`PIN ${location.pinCode.trim()}`);
  }
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    parts.push(`GPS ${latitude}, ${longitude}`);
  }

  if (parts.length === 0) {
    throw new Error("Bin location is missing");
  }

  return parts.join(" | ");
}

function normalizedContacts(value: unknown): Contact[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { contacts?: unknown }).contacts)
  ) {
    return [];
  }

  const uniqueContacts = new Map<string, Contact>();
  for (const candidate of (value as { contacts: unknown[] }).contacts) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }

    const contact = candidate as Partial<Contact>;
    const email = contact.email?.trim().toLowerCase() ?? "";
    const type = contact.type;
    const confidence = contact.confidence;
    const validType =
      type === "municipal" ||
      type === "private_recycler";
    const validConfidence =
      confidence === "high" ||
      confidence === "medium" ||
      confidence === "low";

    if (
      !isEmail(email) ||
      !contact.organization?.trim() ||
      !validType ||
      !validConfidence
    ) {
      continue;
    }

    uniqueContacts.set(email, {
      organization: contact.organization.trim(),
      email,
      type,
      sourceUrl: contact.sourceUrl?.trim() ?? "",
      confidence,
    });
  }

  return [...uniqueContacts.values()];
}

async function researchContacts(bin: BinRecord): Promise<ResearchResult> {
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
    const location = locationDescription(bin);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "Find official municipal solid-waste contacts and legitimate private waste recyclers. Return only contacts relevant to the supplied Tamil Nadu location. Never invent an email address. Prefer official government domains and include the source URL used for each contact.",
        },
        {
          role: "user",
          content:
            `Find municipal garbage-clearance departments and private waste ` +
            `recyclers within approximately 5 km of this bin location: ${location}.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: CONTACT_RESPONSE_SCHEMA,
      },
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI returned an empty response");
    }

    const contacts = normalizedContacts(JSON.parse(content));
    if (contacts.length === 0) {
      throw new Error("OpenAI returned no valid email contacts");
    }

    return { contacts, source: "openai" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown OpenAI error";
    logger.warn("Contact research failed; using Tamil Nadu fallback contacts", {
      error: message,
    });
    return {
      contacts: DEFAULT_TAMIL_NADU_CONTACTS,
      source: "fallback",
      error: message,
    };
  }
}

function encodeMimeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function buildRawEmail(
  subject: string,
  body: string,
  bccRecipients: string[],
): string {
  const message = [
    "To: undisclosed-recipients:;",
    `Bcc: ${bccRecipients.join(", ")}`,
    `Subject: ${encodeMimeSubject(sanitizeOneLine(subject))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");

  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sendGmail(
  ownerUid: string,
  subject: string,
  body: string,
  recipients: string[],
): Promise<{ messageId: string; threadId: string }> {
  const oauthSnapshot = await database
    .ref(`${ROOT}/users/${ownerUid}/googleOAuth`)
    .get();
  const oauthValue = oauthSnapshot.val() as
    | string
    | { refreshToken?: string }
    | null;
  const refreshToken =
    typeof oauthValue === "string"
      ? oauthValue
      : oauthValue?.refreshToken;

  if (!refreshToken) {
    throw new Error("Google OAuth refresh token is missing");
  }

  const oauthClient = new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID.value(),
    GOOGLE_OAUTH_CLIENT_SECRET.value(),
  );
  oauthClient.setCredentials({ refresh_token: refreshToken });

  const accessToken = await oauthClient.getAccessToken();
  if (!accessToken.token) {
    throw new Error("Google did not issue an access token");
  }

  const gmail = google.gmail({ version: "v1", auth: oauthClient });
  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: buildRawEmail(subject, body, recipients),
    },
  });

  return {
    messageId: response.data.id ?? "",
    threadId: response.data.threadId ?? "",
  };
}

async function sendNotification(
  ownerUid: string,
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<void> {
  const tokenSnapshot = await database
    .ref(`${ROOT}/users/${ownerUid}/fcmTokens`)
    .get();
  const storedTokens = tokenSnapshot.val() as
    | Record<string, string | { token?: string }>
    | null;

  if (!storedTokens) {
    logger.warn("No FCM tokens found", { ownerUid });
    return;
  }

  const tokens = [
    ...new Set(
      Object.values(storedTokens)
        .map((value) =>
          typeof value === "string" ? value : value?.token,
        )
        .filter((value): value is string => Boolean(value)),
    ),
  ].slice(0, 500);

  if (tokens.length === 0) {
    logger.warn("No usable FCM tokens found", { ownerUid });
    return;
  }

  const result = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data,
    android: {
      priority: "high",
      notification: {
        channelId: "swads_alerts",
      },
    },
  });

  logger.info("FCM notification sent", {
    ownerUid,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
}

async function markEventBackend(
  eventId: string,
  values: Record<string, unknown>,
): Promise<void> {
  await database
    .ref(`${ROOT}/events/${eventId}/backend`)
    .update({
      ...values,
      updatedAt: Date.now(),
    });
}

export const syncBinState = onValueWritten(
  {
    ref: `${ROOT}/devices/{deviceId}/state`,
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (triggerEvent) => {
    const state = triggerEvent.data.after.val() as DeviceState | null;
    if (!state?.binId || !isFirebaseKey(state.binId)) {
      return;
    }

    const fillPercent = state.measurement?.fillPercent;
    const currentState =
      state.state === "CRITICAL"
        ? "ALERT_80"
        : typeof fillPercent === "number" && fillPercent <= 20
          ? "CLEARED"
          : "NORMAL";

    await database.ref(`${ROOT}/bins/${state.binId}`).transaction((bin) => {
      if (!bin?.ownerUid) {
        return;
      }

      return {
        ...bin,
        ...(typeof fillPercent === "number"
          ? { currentFillPercent: fillPercent }
          : {}),
        currentState,
        deviceId: triggerEvent.params.deviceId,
        lastTelemetryAt: state.lastUpdatedAt ?? Date.now(),
      };
    });
  },
);

export const dispatchOnAlert = onValueCreated(
  {
    ref: EVENT_PATH,
    secrets: [
      OPENAI_API_KEY,
      GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET,
    ],
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (triggerEvent) => {
    const eventId = triggerEvent.params.eventId;
    const event = triggerEvent.data.val() as EspEvent | null;

    if (!event || event.type !== "ALERT_80") {
      return;
    }

    if (
      !isFirebaseKey(event.binId || "") ||
      !event.deviceId ||
      (event.alertCycleId && !isFirebaseKey(event.alertCycleId))
    ) {
      await markEventBackend(eventId, {
        status: "Rejected",
        error: "Event contains an invalid binId, deviceId, or alertCycleId",
      });
      return;
    }

    const binSnapshot = await database
      .ref(`${ROOT}/bins/${event.binId}`)
      .get();
    const bin = binSnapshot.val() as BinRecord | null;
    if (!bin?.ownerUid) {
      await markEventBackend(eventId, {
        status: "Rejected",
        error: "Bin owner is not configured",
      });
      return;
    }

    let location: string;
    try {
      location = locationDescription(bin);
    } catch (error) {
      await markEventBackend(eventId, {
        status: "Rejected",
        error: error instanceof Error ? error.message : "Invalid location",
      });
      return;
    }

    const alertCycleId = event.alertCycleId || eventId;
    const activeAlertRef = database.ref(
      `${ROOT}/activeAlerts/${event.binId}`,
    );
    const lockResult = await activeAlertRef.transaction((currentValue) => {
      if (currentValue !== null) {
        return;
      }
      return {
        alertCycleId,
        eventId,
        createdAt: Date.now(),
      };
    });

    if (!lockResult.committed) {
      await markEventBackend(eventId, {
        status: "IgnoredDuplicate",
        alertCycleId,
      });
      logger.info("Duplicate ALERT_80 ignored", {
        binId: event.binId,
        eventId,
      });
      return;
    }

    const cycleRef = database.ref(
      `${ROOT}/alertCycles/${alertCycleId}`,
    );
    await cycleRef.set({
      alertCycleId,
      eventId,
      binId: event.binId,
      deviceId: event.deviceId,
      ownerUid: bin.ownerUid,
      status: "Dispatching",
      location,
      fillPercent: event.measurement?.fillPercent ?? null,
      triggeredAt: event.receivedAt ?? Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await markEventBackend(eventId, {
      status: "Dispatching",
      alertCycleId,
    });

    try {
      const research = await researchContacts(bin);
      const recipients = research.contacts.map((contact) => contact.email);
      const binLabel = sanitizeOneLine(bin.displayName || event.binId);
      const subject =
        `URGENT: Smart Bin #${binLabel} at ${location} ` +
        "is 80% Full - Clearance Required";
      const body = [
        "This is an automated alert from the SWADS IoT network.",
        "",
        `The garbage bin located at ${location} has reached 80% capacity.`,
        `Bin ID: ${event.binId}`,
        `Device ID: ${event.deviceId}`,
        "",
        "Please dispatch a clearance team or vehicle at the earliest.",
        "",
        "Thank you.",
      ].join("\r\n");

      const gmailResult = await sendGmail(
        bin.ownerUid,
        subject,
        body,
        recipients,
      );

      await cycleRef.update({
        status: "AwaitingClearance",
        contacts: research.contacts,
        contactResearchSource: research.source,
        contactResearchError: research.error ?? null,
        recipientEmails: recipients,
        gmailMessageId: gmailResult.messageId,
        gmailThreadId: gmailResult.threadId,
        dispatchedAt: Date.now(),
        updatedAt: Date.now(),
      });
      await markEventBackend(eventId, {
        status: "EmailsSent",
        alertCycleId,
        gmailMessageId: gmailResult.messageId,
      });

      try {
        await sendNotification(
          bin.ownerUid,
          "Dispatch Emails Sent",
          `Clearance emails were sent for ${binLabel}.`,
          {
            type: "DISPATCH_SENT",
            binId: event.binId,
            alertCycleId,
          },
        );
      } catch (notificationError) {
        logger.error("Dispatch FCM notification failed", notificationError);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown dispatch error";
      await cycleRef.update({
        status: "DispatchFailed",
        error: message,
        updatedAt: Date.now(),
      });
      await markEventBackend(eventId, {
        status: "DispatchFailed",
        alertCycleId,
        error: message,
      });
      logger.error("Alert dispatch failed", {
        eventId,
        alertCycleId,
        error: message,
      });
    }
  },
);

export const clearOnReset = onValueCreated(
  {
    ref: EVENT_PATH,
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (triggerEvent) => {
    const eventId = triggerEvent.params.eventId;
    const event = triggerEvent.data.val() as EspEvent | null;

    if (
      !event ||
      event.type !== "RESET" ||
      !isFirebaseKey(event.binId || "") ||
      (event.alertCycleId && !isFirebaseKey(event.alertCycleId))
    ) {
      return;
    }

    const activeAlertRef = database.ref(
      `${ROOT}/activeAlerts/${event.binId}`,
    );
    const activeSnapshot = await activeAlertRef.get();
    const activeValue = activeSnapshot.val() as
      | { alertCycleId?: string }
      | null;
    const alertCycleId =
      event.alertCycleId || activeValue?.alertCycleId;

    if (!alertCycleId) {
      await markEventBackend(eventId, {
        status: "ResetWithoutActiveAlert",
      });
      return;
    }

    const cycleRef = database.ref(
      `${ROOT}/alertCycles/${alertCycleId}`,
    );
    const cycleSnapshot = await cycleRef.get();
    const cycle = cycleSnapshot.val() as
      | { ownerUid?: string; binId?: string }
      | null;

    await cycleRef.update({
      status: "Cleared",
      resetEventId: eventId,
      clearedAt: event.receivedAt ?? Date.now(),
      updatedAt: Date.now(),
    });

    await activeAlertRef.transaction((currentValue) => {
      if (
        currentValue?.alertCycleId === alertCycleId ||
        currentValue === alertCycleId
      ) {
        return null;
      }
      return;
    });

    await markEventBackend(eventId, {
      status: "Cleared",
      alertCycleId,
    });

    let ownerUid = cycle?.ownerUid;
    if (!ownerUid) {
      const binSnapshot = await database
        .ref(`${ROOT}/bins/${event.binId}`)
        .get();
      ownerUid = (binSnapshot.val() as BinRecord | null)?.ownerUid;
    }

    if (ownerUid) {
      try {
        await sendNotification(
          ownerUid,
          "Bin Cleared",
          `Bin ${event.binId} has been emptied and reset to normal.`,
          {
            type: "BIN_CLEARED",
            binId: event.binId,
            alertCycleId,
          },
        );
      } catch (notificationError) {
        logger.error("Clearance FCM notification failed", notificationError);
      }
    }
  },
);
