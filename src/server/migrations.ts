import "server-only";
import type { DatabaseSync } from "node:sqlite";

// Forward-only migrations, applied in order. PRAGMA user_version records how many have run.
// Never edit one that has shipped; add a new entry.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    wall_token TEXT UNIQUE,
    wall_public INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE login_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    return_to TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX login_links_expires ON login_links (expires_at);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_account ON sessions (account_id);

  -- One row per stub per account. A tombstone keeps the row with deleted = 1 and updated_at = when it was deleted.
  CREATE TABLE wall_stubs (
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    stub_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    PRIMARY KEY (account_id, stub_id)
  );

  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
    email TEXT,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX orders_account ON orders (account_id, created_at);
  CREATE INDEX orders_email ON orders (email);

  -- owner_key is an account id, or "anon" for a share made while signed out.
  CREATE TABLE shares (
    token TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    stub_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_key, stub_id)
  );

  CREATE TABLE organizer_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    stub TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE claims (
    token_hash TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES organizer_events (id) ON DELETE CASCADE,
    guest_name TEXT NOT NULL,
    seat TEXT,
    claimed_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
    claimed_stub_id TEXT,
    claimed_at INTEGER
  );
  CREATE INDEX claims_event ON claims (event_id);
  `,
  `
  ALTER TABLE login_links ADD COLUMN account_id TEXT;
  `,
  `
  ALTER TABLE login_links ADD COLUMN share_token TEXT;
  `,
  `
  -- Daily art generations per key ("acc:<id>", "dev:<id>", "ip:<ip>"); day is the UTC date.
  CREATE TABLE art_usage (
    key TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (key, day)
  );
  `,
  `
  -- Identity context: membership_revision moves when the email changes, sessions are all revoked or staff status flips.
  ALTER TABLE accounts ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE accounts ADD COLUMN is_staff INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX shares_owner ON shares (owner_key);
  `,
  `
  -- Gift messages. Only the SHA-256 of the gift token is stored. The message lives here and nowhere else:
  -- never in a share snapshot, a wall, a stub image or a page. owner_key and stub_id name the share it unwraps.
  CREATE TABLE gifts (
    token_hash TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    stub_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    opened_at INTEGER
  );
  CREATE INDEX gifts_owner ON gifts (owner_key, stub_id);
  `,
  `
  -- Product events (ticketstub.event/1). Append-only: no UPDATE ever, and no DELETE until a row is past retention
  -- (90 days), so only prune can remove them. Only hashes, codes, counts and timestamps: see src/server/events.ts.
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_ref TEXT,
    tenant_ref TEXT,
    project_ref TEXT,
    mode TEXT NOT NULL,
    fields TEXT NOT NULL
  );
  CREATE INDEX events_project ON events (project_ref, seq);
  CREATE INDEX events_at ON events (at);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
  END;
  CREATE TRIGGER events_keep_recent BEFORE DELETE ON events
  WHEN OLD.at > (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 90 * 24 * 3600 * 1000) BEGIN
    SELECT RAISE(ABORT, 'events are kept for 90 days');
  END;
  `,
  `
  -- Artwork approvals (ticketstub.approval/1). Append-only: an approval is never updated, and a revocation is a
  -- new row in its own table. Rows leave only with their account (account deletion), never before: see src/server/approval.ts.
  -- record is the signed record as canonical JSON (hashes, ids and times only); the token is re-derived from it.
  CREATE TABLE approvals (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    tenant TEXT NOT NULL,
    project TEXT NOT NULL,
    purpose TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    record TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX approvals_project ON approvals (tenant, project, seq);
  CREATE TABLE approval_revocations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id TEXT NOT NULL UNIQUE REFERENCES approvals (id),
    tenant TEXT NOT NULL,
    revoked_at INTEGER NOT NULL
  );
  CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals BEGIN
    SELECT RAISE(ABORT, 'approvals are append-only');
  END;
  CREATE TRIGGER approval_revocations_no_update BEFORE UPDATE ON approval_revocations BEGIN
    SELECT RAISE(ABORT, 'revocations are append-only');
  END;
  CREATE TRIGGER approvals_keep BEFORE DELETE ON approvals
  WHEN EXISTS (SELECT 1 FROM accounts WHERE id = OLD.tenant) BEGIN
    SELECT RAISE(ABORT, 'approvals are kept while their account exists');
  END;
  CREATE TRIGGER approval_revocations_keep BEFORE DELETE ON approval_revocations
  WHEN EXISTS (SELECT 1 FROM accounts WHERE id = OLD.tenant) BEGIN
    SELECT RAISE(ABORT, 'revocations are kept while their account exists');
  END;
  `,
  `
  -- What was printed when an approval was issued, in words, so the owner's review sheet can say what changed since
  -- (GT-06B.1). Owner-only: it is never in the signed record or the token and the verifier never reads it. Append-only,
  -- and it leaves only with its account, like the approval it describes.
  CREATE TABLE approval_summaries (
    approval_id TEXT PRIMARY KEY REFERENCES approvals (id),
    tenant TEXT NOT NULL,
    summary TEXT NOT NULL
  );
  CREATE TRIGGER approval_summaries_no_update BEFORE UPDATE ON approval_summaries BEGIN
    SELECT RAISE(ABORT, 'approval summaries are append-only');
  END;
  `,
  `
  -- Order authorizations (ticketstub.order-authorization/1). Append-only, like approvals: an authorization is never updated, a revocation
  -- and a claim are new rows in their own tables, and rows leave only with their account. A claim is the single use of an authorization:
  -- UNIQUE on the authorization, on the logical action and on (consumer, idem_key) is what makes "first claim wins" hold across processes.
  -- record is the signed record as canonical JSON (hashes, references and times only); the token is re-derived from it.
  CREATE TABLE order_authorizations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    tenant TEXT NOT NULL,
    project TEXT NOT NULL,
    action_id TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    req_hash TEXT NOT NULL,
    record TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (tenant, idem_key)
  );
  CREATE INDEX order_authorizations_project ON order_authorizations (tenant, project, seq);
  CREATE INDEX order_authorizations_action ON order_authorizations (action_id, seq);
  CREATE TABLE order_authorization_revocations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    authorization_id TEXT NOT NULL UNIQUE REFERENCES order_authorizations (id),
    tenant TEXT NOT NULL,
    revoked_at INTEGER NOT NULL
  );
  CREATE TABLE order_authorization_claims (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    authorization_id TEXT NOT NULL UNIQUE REFERENCES order_authorizations (id),
    action_id TEXT NOT NULL UNIQUE,
    tenant TEXT NOT NULL,
    consumer TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    claim_ref TEXT NOT NULL UNIQUE,
    claimed_at INTEGER NOT NULL,
    UNIQUE (consumer, idem_key)
  );
  CREATE TRIGGER order_authorizations_no_update BEFORE UPDATE ON order_authorizations BEGIN
    SELECT RAISE(ABORT, 'order authorizations are append-only');
  END;
  CREATE TRIGGER order_authorization_revocations_no_update BEFORE UPDATE ON order_authorization_revocations BEGIN
    SELECT RAISE(ABORT, 'order authorization revocations are append-only');
  END;
  CREATE TRIGGER order_authorization_claims_no_update BEFORE UPDATE ON order_authorization_claims BEGIN
    SELECT RAISE(ABORT, 'order authorization claims are append-only');
  END;
  CREATE TRIGGER order_authorizations_keep BEFORE DELETE ON order_authorizations
  WHEN EXISTS (SELECT 1 FROM accounts WHERE id = OLD.tenant) BEGIN
    SELECT RAISE(ABORT, 'order authorizations are kept while their account exists');
  END;
  CREATE TRIGGER order_authorization_revocations_keep BEFORE DELETE ON order_authorization_revocations
  WHEN EXISTS (SELECT 1 FROM accounts WHERE id = OLD.tenant) BEGIN
    SELECT RAISE(ABORT, 'order authorization revocations are kept while their account exists');
  END;
  CREATE TRIGGER order_authorization_claims_keep BEFORE DELETE ON order_authorization_claims
  WHEN EXISTS (SELECT 1 FROM accounts WHERE id = OLD.tenant) BEGIN
    SELECT RAISE(ABORT, 'order authorization claims are kept while their account exists');
  END;
  `,
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
