import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getMessaging } from "firebase-admin/messaging";
import { logger, setGlobalOptions } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { google } from "googleapis";
import OpenAI from "openai";
import { createEventHandlers, databaseStore } from "./events.js";
import { AmbiguousDeliveryError, isKey, ROOT, type Services } from "./dispatch.js";

initializeApp();
const FUNCTION_REGION =
  process.env.FUNCTIONS_EMULATOR === "true"
    ? "us-central1"
    : "asia-southeast1";
setGlobalOptions({
  region: FUNCTION_REGION,
  maxInstances: 10,
});

const database = getDatabase();

const OPENROUTER_API_KEY = defineSecret("OPENROUTER_API_KEY");
const GOOGLE_OAUTH_CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");

type ContactType = "municipal" | "private_recycler";
type ContactConfidence = "high" | "medium" | "low";

interface BinRecord {
  ownerUid: string;
  deviceId?: string;
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

interface Contact {
  organization: string;
  email: string;
  type: ContactType;
  sourceUrl: string;
  confidence: ContactConfidence;
}

interface ResearchResult {
  contacts: Contact[];
  source: "openrouter" | "fallback";
  error?: string;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
      "",
    );
    const { tokens } = await oauthClient.getToken(code);
    if (tokens.scope && !tokens.scope.split(" ").includes("https://www.googleapis.com/auth/gmail.send")) {
      throw new HttpsError("permission-denied", "Gmail sending consent is required.");
    }
    const existingOAuthSnapshot = await database
      .ref(`${ROOT}/users/${ownerUid}/googleOAuth`)
      .get();
    const existingRefreshToken = (
      existingOAuthSnapshot.val() as { refreshToken?: string } | null
    )?.refreshToken;
    const refreshToken = tokens.refresh_token ?? existingRefreshToken;
    if (!refreshToken) {
      throw new HttpsError(
        "failed-precondition",
        "Google did not return a refresh token. Revoke SWADS access and sign in again.",
      );
    }

    await database.ref(`${ROOT}/users/${ownerUid}/googleOAuth`).set({
      refreshToken,
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
  const candidates =
    Array.isArray(value)
      ? value
      : typeof value === "object" && value !== null &&
          Array.isArray((value as { contacts?: unknown }).contacts)
        ? (value as { contacts: unknown[] }).contacts
        : [];
  if (candidates.length === 0) {
    return [];
  }

  const uniqueContacts = new Map<string, Contact>();
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }

    const contact = candidate as Record<string, unknown>;
    const organization =
      typeof contact.organization === "string"
        ? contact.organization.trim()
        : "";
    const email =
      typeof contact.email === "string"
        ? contact.email.trim().toLowerCase()
        : "";
    const rawType =
      typeof contact.type === "string" ? contact.type.toLowerCase() : "";
    const type: ContactType | null =
      rawType.includes("municipal")
        ? "municipal"
        : rawType.includes("private") || rawType.includes("recycler")
          ? "private_recycler"
          : null;
    const rawConfidence = contact.confidence;
    const confidence: ContactConfidence | null =
      rawConfidence === "high" ||
      rawConfidence === "medium" ||
      rawConfidence === "low"
        ? rawConfidence
        : typeof rawConfidence === "number"
          ? rawConfidence >= 0.8
            ? "high"
            : rawConfidence >= 0.5
              ? "medium"
              : "low"
          : null;
    const sourceUrl =
      typeof contact.sourceUrl === "string" ? contact.sourceUrl.trim() : "";

    if (
      !isEmail(email) ||
      !organization ||
      !type ||
      !confidence ||
      !/^https?:\/\//i.test(sourceUrl)
    ) {
      continue;
    }

    uniqueContacts.set(email, {
      organization,
      email,
      type,
      sourceUrl,
      confidence,
    });
  }

  return [...uniqueContacts.values()];
}

function parseJsonResponse(content: string): unknown {
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (unfenced.startsWith("[") && unfenced.endsWith("]")) {
    return JSON.parse(unfenced);
  }
  const objectStart = unfenced.indexOf("{");
  const objectEnd = unfenced.lastIndexOf("}");

  if (objectStart === -1 || objectEnd < objectStart) {
    throw new Error("OpenRouter response did not contain a JSON object");
  }

  return JSON.parse(unfenced.slice(objectStart, objectEnd + 1));
}

async function researchContacts(bin: BinRecord): Promise<ResearchResult> {
  try {
    const openai = new OpenAI({
      apiKey: OPENROUTER_API_KEY.value(),
      baseURL: "https://openrouter.ai/api/v1",
      timeout: 20000,
      maxRetries: 0,
    });
    const location = locationDescription(bin);
    const completion = await openai.chat.completions.create({
      model: "inclusionai/ling-3.0-flash:free",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            'Find official municipal solid-waste contacts and legitimate private waste recyclers. Return only valid JSON with exactly one top-level contacts array and no Markdown or explanatory text. Use exactly this shape: {"contacts":[{"organization":"...","email":"...","type":"municipal","sourceUrl":"https://...","confidence":"high"}]}. The only allowed type values are "municipal" and "private_recycler". The only allowed confidence values are "high", "medium", and "low". Never invent a contact name, organization, email address, or source URL. Prefer official government domains and return only contacts relevant to the supplied Tamil Nadu location.',
        },
        {
          role: "user",
          content:
            `Find municipal garbage-clearance departments and private waste ` +
            `recyclers within approximately 5 km of this bin location: ${location}.`,
        },
      ],
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenRouter returned an empty response");
    }

    const contacts = normalizedContacts(parseJsonResponse(content));
    if (contacts.length === 0) {
      throw new Error("OpenRouter returned no valid email contacts");
    }

    return { contacts, source: "openrouter" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown OpenRouter error";
    logger.warn("Contact suggestions failed; no automatic fallback recipients", {
      error: message,
    });
    return {
      contacts: [],
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
  let response;
  try {
    response = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: buildRawEmail(subject, body, recipients) },
    }, { timeout: 20000, retry: false });
  } catch (error: any) {
    const status = Number(error?.response?.status);
    // A lost response or server error may follow an accepted send. Gmail has
    // no idempotency key: never blindly resend an uncertain external effect.
    if (!status || status >= 500 || status === 408) {
      throw new AmbiguousDeliveryError("Gmail send outcome is unknown. Check Sent mail before retrying.");
    }
    throw error;
  }
  if (!response.data.id) throw new AmbiguousDeliveryError("Gmail did not return a message ID. Check Sent mail.");

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
    data: { ...data, title, body, ownerUid },
    android: {
      priority: "high",
    },
  });

  logger.info("FCM notification sent", {
    ownerUid,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
  const invalid = new Set(tokens.filter((_, index) =>
    ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(result.responses[index]?.error?.code ?? "")));
  const removals: Promise<unknown>[] = [];
  tokenSnapshot.forEach(child => {
    const value = child.val();
    const token = typeof value === "string" ? value : value?.token;
    if (invalid.has(token)) removals.push(child.ref.transaction(current => {
      const currentToken = typeof current === "string" ? current : current?.token;
      return invalid.has(currentToken) ? null : undefined;
    }));
  });
  await Promise.all(removals);
}


const services: Services = { store: databaseStore(), now: Date.now, send: sendGmail, notify: sendNotification };
export const { syncBinState, dispatchOnAlert, clearOnReset, retryDispatchJobs, syncDispatchStatus } = createEventHandlers(services, [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET]);
export { registerBin, retryCollectionRequest } from "./registration.js";

// Discovery is advisory only. These results are never automatic recipients.
export const suggestCollectionContacts = onCall({ region: "asia-southeast1", secrets: [OPENROUTER_API_KEY], timeoutSeconds: 30 }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const binId = request.data?.binId;
  if (!isKey(binId)) throw new HttpsError("invalid-argument", "Invalid bin ID.");
  const bin = (await database.ref(`${ROOT}/bins/${binId}`).get()).val();
  if (bin?.ownerUid !== request.auth.uid) throw new HttpsError("permission-denied", "This bin belongs to another account.");
  const result = await researchContacts(bin);
  return { ...result, verified: false, notice: "Suggestions require independent verification before saving as collection contacts." };
});
