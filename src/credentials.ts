// The credentials file (docs/security.md, section 2): one line per agent, with
// the Kanboard user the agent acts as, that user's API token, the SHA-256
// hashes of the agent's static bearers and, optionally, the e-mail addresses
// Cloudflare Access signs the agent in with. The token never leaves the server.
// Taken from finestream/silverbullet-mcp-server (MIT), without the space and group fields.

import { createHash, timingSafeEqual } from "node:crypto";

export type Credential = {
  /** The agent's name here: what an OAuth token's user claim must carry. */
  user: string;
  /** The Kanboard user the agent acts as (its login name). */
  kanboardUser: string;
  /** That user's Kanboard API token (or password): the HTTP Basic password on `/jsonrpc.php`. Never leaves the server. */
  token: string;
  /** Hex SHA-256 digests of the client bearers, one per client. */
  bearerHashes: string[];
  /** The e-mail addresses that select this line for a request through Cloudflare Access, in lower case. */
  emails: string[];
  line: number;
};

export type Credentials = {
  users: Map<string, Credential>;
  /** The user a client bearer belongs to, or null. Constant-time comparison per stored hash. */
  byBearer(bearer: string): Credential | null;
  /** The user an e-mail address belongs to, in any case, or null. */
  byEmail(email: string): Credential | null;
};

const HEX64 = /^[0-9a-f]{64}$/;
/** Enough to catch a field that is not an address; Access, not this file, decides which addresses exist. */
const EMAIL = /^[^\s@,]+@[^\s@,]+$/;

export const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Format, whitespace-separated: `user kanboard-user token bearer-hashes [emails]`; `bearer-hashes`
 * and `emails` are comma-separated or `-`; `emails` may be left out; `#` starts a comment.
 */
export function parseCredentials(text: string): { credentials: Credentials; problems: string[] } {
  const users = new Map<string, Credential>();
  const hashes = new Map<string, string>();
  const emails = new Map<string, string>();
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    const t = line.split(/\s+/);
    if (t.length !== 4 && t.length !== 5) {
      problems.push(`line ${i + 1}: expected "user kanboard-user token bearer-hashes [emails]" (4 or 5 fields), got ${t.length}`);
      return;
    }
    const [user, kanboardUser, token, bearers, addresses = "-"] = t;
    if (users.has(user)) {
      problems.push(`line ${i + 1}: user "${user}" appears twice`);
      return;
    }
    const bearerHashes = bearers === "-" ? [] : bearers.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    for (const h of bearerHashes) {
      if (!HEX64.test(h)) problems.push(`line ${i + 1}: "${h.slice(0, 12)}…" is not a hex SHA-256 digest`);
      else if (hashes.has(h)) problems.push(`line ${i + 1}: bearer hash already used by "${hashes.get(h)}"`);
      else hashes.set(h, user);
    }
    const own: string[] = [];
    for (const e of addresses === "-" ? [] : addresses.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean)) {
      if (!EMAIL.test(e)) problems.push(`line ${i + 1}: "${e.slice(0, 40)}" is not an e-mail address`);
      else if (emails.has(e)) problems.push(`line ${i + 1}: e-mail address already used by "${emails.get(e)}"`);
      else {
        emails.set(e, user);
        own.push(e);
      }
    }
    users.set(user, { user, kanboardUser, token, bearerHashes, emails: own, line: i + 1 });
  });
  const credentials: Credentials = {
    users,
    byBearer(bearer: string) {
      const digest = Buffer.from(sha256hex(bearer), "hex");
      let found: string | null = null;
      for (const [hash, user] of hashes) {
        // Every stored hash is compared, so the time does not depend on which one matches.
        if (timingSafeEqual(digest, Buffer.from(hash, "hex"))) found = user;
      }
      return found ? (users.get(found) ?? null) : null;
    },
    byEmail(email: string) {
      const user = emails.get(email.toLowerCase());
      return user ? (users.get(user) ?? null) : null;
    },
  };
  return { credentials, problems };
}
