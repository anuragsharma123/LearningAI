import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREDENTIALS_PATH = path.join(__dirname, "credentials", "credentials.json");
const TOKEN_PATH = path.join(__dirname, "credentials", "token.json");

/** Read-only access to Gmail messages and metadata. */
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Normalised representation of a Gmail message used throughout the agent.
 * `body` is only populated for today's emails (2-month fetch uses metadata only).
 */
export interface EmailSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  /** Plain-text body, truncated to 500 chars. Empty string for metadata-only fetches. */
  body: string;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Prompts the user to complete the OAuth2 consent flow in their browser,
 * saves the resulting token to disk, and returns a credentialed client.
 * Only called on first run or when `token.json` is absent.
 *
 * @param oAuth2Client - A pre-configured OAuth2 client (no credentials yet).
 * @returns The same client with credentials set.
 */
async function getNewToken(oAuth2Client: OAuth2Client): Promise<OAuth2Client> {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES
  });

  console.log("\nAuthorize this app by visiting:\n");
  console.log("  " + authUrl + "\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve, reject) => {
    rl.question("Paste the authorisation code here: ", async (code) => {
      rl.close();
      try {
        const { tokens } = await oAuth2Client.getToken(code.trim());
        oAuth2Client.setCredentials(tokens);

        fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log("✓ Token saved to gmail-agent/credentials/token.json\n");

        resolve(oAuth2Client);
      } catch (err) {
        reject(new Error(`Failed to exchange code for token: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}

/**
 * Returns an authenticated Gmail OAuth2 client.
 *
 * On first run (no `token.json`): opens the browser consent URL and prompts
 * for the authorisation code, then saves the token for future use.
 * On subsequent runs: loads the cached token and auto-refreshes it when needed.
 *
 * @throws If `credentials.json` is missing (setup instructions are included in the error).
 */
export async function getAuthClient(): Promise<OAuth2Client> {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Gmail credentials not found at:\n  ${CREDENTIALS_PATH}\n\n` +
        `Please follow the setup guide in gmail-agent/credentials/README.md.`
    );
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8")) as {
    installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
    web?: { client_id: string; client_secret: string; redirect_uris: string[] };
  };

  const { client_id, client_secret, redirect_uris } =
    credentials.installed ?? credentials.web!;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Persist refreshed tokens automatically so the session never expires silently.
  oAuth2Client.on("tokens", (tokens) => {
    if (fs.existsSync(TOKEN_PATH)) {
      const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
    }
  });

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")) as Record<string, unknown>;
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  return getNewToken(oAuth2Client);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Finds the value of a specific header (case-insensitive) from a Gmail message.
 *
 * @param headers - Array of `{ name, value }` header objects from the Gmail API.
 * @param name    - Header name to look up (e.g. `"subject"`, `"from"`).
 * @returns The header value, or an empty string if not found.
 */
function extractHeader(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string
): string {
  return (
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
  );
}

/**
 * Recursively extracts the plain-text body from a Gmail message payload.
 * Prefers `text/plain` parts; falls back to the first part that contains data.
 *
 * @param payload - The `payload` object from a `messages.get` response.
 * @returns Decoded UTF-8 body string, or an empty string if none found.
 */
function extractBody(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: unknown[];
} | null | undefined): string {
  if (!payload) return "";

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }

  if (payload.parts) {
    for (const part of payload.parts as typeof payload[]) {
      if (part?.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
      }
    }
    // Fallback: recurse into the first nested part that has data.
    for (const part of payload.parts as typeof payload[]) {
      const body = extractBody(part);
      if (body) return body;
    }
  }

  return "";
}

/**
 * Fetches full or metadata details for a list of message IDs in batches of 10
 * to respect Gmail API rate limits.
 *
 * @param gmail    - Authenticated Gmail API client.
 * @param messages - Array of `{ id }` objects from `messages.list`.
 * @param format   - `"full"` includes decoded body; `"metadata"` is headers + snippet only.
 * @returns Array of {@link EmailSummary} objects.
 */
async function fetchEmailDetails(
  gmail: ReturnType<typeof google.gmail>,
  messages: Array<{ id?: string | null }>,
  format: "full" | "metadata"
): Promise<EmailSummary[]> {
  const summaries: EmailSummary[] = [];
  const BATCH = 10;

  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);

    const details = await Promise.all(
      batch.map((m) =>
        gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format
        })
      )
    );

    for (const detail of details) {
      const msg = detail.data;
      const headers = msg.payload?.headers ?? [];

      summaries.push({
        id: msg.id ?? "",
        subject: extractHeader(headers, "subject") || "(no subject)",
        from: extractHeader(headers, "from"),
        date: extractHeader(headers, "date"),
        snippet: msg.snippet ?? "",
        body:
          format === "full"
            ? extractBody(msg.payload).slice(0, 500)
            : ""
      });
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Public fetch functions
// ---------------------------------------------------------------------------

/**
 * Fetches all emails received today (since midnight local time).
 * Uses `format: "full"` so body text is available for action-item extraction.
 * Limited to the primary inbox; max 50 messages.
 *
 * @param auth - Authenticated OAuth2 client from {@link getAuthClient}.
 * @returns Array of today's {@link EmailSummary} objects, newest first.
 */
export async function getTodayEmails(auth: OAuth2Client): Promise<EmailSummary[]> {
  const gmail = google.gmail({ version: "v1", auth });

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const after = Math.floor(midnight.getTime() / 1000);

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    q: `after:${after} category:primary`,
    maxResults: 50
  });

  const messages = listResponse.data.messages ?? [];
  return fetchEmailDetails(gmail, messages, "full");
}

/**
 * Fetches up to 200 emails from the last two months for recurring-pattern analysis.
 * Uses `format: "metadata"` (headers + snippet, no body) to keep the payload
 * small and stay within Claude's context budget.
 * Limited to the primary inbox to filter out newsletters and promotions.
 *
 * @param auth - Authenticated OAuth2 client from {@link getAuthClient}.
 * @returns Array of recent {@link EmailSummary} objects with empty `body` fields.
 */
export async function getLastTwoMonthsEmails(auth: OAuth2Client): Promise<EmailSummary[]> {
  const gmail = google.gmail({ version: "v1", auth });

  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
  const after = Math.floor(twoMonthsAgo.getTime() / 1000);

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    q: `after:${after} category:primary`,
    maxResults: 200
  });

  const messages = listResponse.data.messages ?? [];
  return fetchEmailDetails(gmail, messages, "metadata");
}
