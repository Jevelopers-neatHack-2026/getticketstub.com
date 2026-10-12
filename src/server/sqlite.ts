import "server-only";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { safeEqual } from "./crypto";
import { DatabaseSync } from "node:sqlite";
import type { Order, OrderPayment } from "@/customer/pages/commerce";
import type { Stub } from "@/customer/studio/types";
import { artUnavailable, retainArt } from "@/customer/studio/versions/retention";
import { EVENT_RETENTION_MS, EVENT_SCHEMA, type StoredEvent, type TicketstubEvent } from "./events";
import { migrate } from "./migrations";
import type { Account, AccountState, ApprovalRow, ArtQuota, ArtQuotaResult, ClaimResult, ClaimView, GiftView, LoginLinkRecord, NewApproval, NewClaim, NewOrderAuth, OrderAuthRow, OrderAuthSnapshot, OrderClaimOutcome, OrderClaimRow, Storage, WallState } from "./storage";

type Row = Record<string, unknown>;

const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export class SqliteStorage implements Storage {
  constructor(private readonly db: DatabaseSync) {}

  /** BEGIN IMMEDIATE takes the write lock up front, so read-then-write merges can't interleave. */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private get(sql: string, ...args: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private run(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).run(...args);
  }

  async useArtQuota(quotas: ArtQuota[], now: number, consume: boolean): Promise<ArtQuotaResult> {
    const day = new Date(now).toISOString().slice(0, 10);
    return this.tx(() => {
      this.run("DELETE FROM art_usage WHERE day < ?", day);
      for (const q of quotas) {
        const row = this.get("SELECT count FROM art_usage WHERE key = ? AND day = ?", q.key, day);
        if (((row?.count as number | undefined) ?? 0) >= q.max) {
          const d = new Date(now);
          return { ok: false as const, retryAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) };
        }
      }
      if (consume) {
        for (const q of quotas) {
          this.run("INSERT INTO art_usage (key, day, count) VALUES (?, ?, 1) ON CONFLICT (key, day) DO UPDATE SET count = count + 1", q.key, day);
        }
      }
      return { ok: true as const };
    });
  }

  async findOrCreateAccount(email: string, now: number): Promise<Account> {
    return this.tx(() => {
      const found = this.get("SELECT id, email FROM accounts WHERE email = ?", email);
      if (found) return { id: found.id as string, email: found.email as string };
      const id = newId("acc");
      this.run("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)", id, email, now);
      return { id, email };
    });
  }

  async getAccount(id: string): Promise<Account | null> {
    const r = this.get("SELECT id, email FROM accounts WHERE id = ?", id);
    return r ? { id: r.id as string, email: r.email as string } : null;
  }

  async changeEmail(accountId: string, email: string): Promise<"changed" | "taken" | "missing"> {
    return this.tx(() => {
      if (!this.get("SELECT id FROM accounts WHERE id = ?", accountId)) return "missing";
      if (this.get("SELECT id FROM accounts WHERE email = ? AND id != ?", email, accountId)) return "taken";
      this.run("UPDATE accounts SET email = ?, membership_revision = membership_revision + 1 WHERE id = ?", email, accountId);
      return "changed";
    });
  }

  async deleteAccount(accountId: string, email: string): Promise<string[]> {
    return this.tx(() => {
      // Art files this account's rows point at; whichever nothing else uses afterwards is orphaned.
      const fileRe = /\/api\/files\/([a-f0-9]{64}\.(?:png|jpg|webp))/g;
      const mine = new Set<string>();
      const scan = (sql: string) => {
        for (const r of this.all(sql, accountId)) for (const m of String(r.data).matchAll(fileRe)) mine.add(m[1]);
      };
      scan("SELECT data FROM wall_stubs WHERE account_id = ?");
      scan("SELECT data FROM shares WHERE owner_key = ?");
      scan("SELECT stub AS data FROM organizer_events WHERE account_id = ?");
      // Orders are kept for the books, but nothing in them points back to the person any more.
      const orders = this.all("SELECT id, data FROM orders WHERE account_id = ? OR (account_id IS NULL AND email = ?)", accountId, email);
      for (const o of orders) {
        const data = JSON.parse(o.data as string) as Record<string, unknown>;
        delete data.email;
        this.run("UPDATE orders SET email = NULL, account_id = NULL, data = ? WHERE id = ?", JSON.stringify(data), o.id as string);
      }
      this.run("DELETE FROM shares WHERE owner_key = ?", accountId);
      this.run("DELETE FROM gifts WHERE owner_key = ?", accountId);
      this.run("DELETE FROM login_links WHERE email = ? OR account_id = ?", email, accountId);
      // Claims this account made on someone else's event go back to unclaimed.
      this.run("UPDATE claims SET claimed_by = NULL, claimed_stub_id = NULL, claimed_at = NULL WHERE claimed_by = ?", accountId);
      // Cascades: sessions, wall stubs (and tombstones), organizer events and their claims.
      this.run("DELETE FROM accounts WHERE id = ?", accountId);
      // The append-only triggers let these go only now that the account is gone.
      this.run("DELETE FROM order_authorization_claims WHERE tenant = ?", accountId);
      this.run("DELETE FROM order_authorization_revocations WHERE tenant = ?", accountId);
      this.run("DELETE FROM order_authorizations WHERE tenant = ?", accountId);
      this.run("DELETE FROM approval_revocations WHERE tenant = ?", accountId);
      this.run("DELETE FROM approval_summaries WHERE tenant = ?", accountId);
      this.run("DELETE FROM approvals WHERE tenant = ?", accountId);
      return [...mine].filter((name) => {
        const like = `%${name}%`;
        return !this.get("SELECT 1 AS x FROM wall_stubs WHERE data LIKE ? LIMIT 1", like) &&
          !this.get("SELECT 1 AS x FROM shares WHERE data LIKE ? LIMIT 1", like) &&
          !this.get("SELECT 1 AS x FROM organizer_events WHERE stub LIKE ? LIMIT 1", like);
      });
    });
  }

  async createLoginLink(tokenHash: string, link: LoginLinkRecord, now: number, expiresAt: number): Promise<void> {
    this.run(
      "INSERT INTO login_links (token_hash, email, return_to, reason, created_at, expires_at, account_id, share_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      tokenHash, link.email, link.returnTo, link.reason, now, expiresAt, link.accountId ?? null, link.shareToken ?? null,
    );
  }

  async peekLoginLink(tokenHash: string, now: number): Promise<(LoginLinkRecord & { kind: "signin" | "email" }) | null> {
    const r = this.get("SELECT token_hash, email, return_to, reason, account_id, share_token FROM login_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", tokenHash, now);
    if (!r || !safeEqual(r.token_hash as string, tokenHash)) return null;
    return {
      email: r.email as string,
      returnTo: r.return_to as string,
      reason: r.reason as string,
      accountId: (r.account_id as string | null) ?? null,
      shareToken: (r.share_token as string | null) ?? null,
      kind: r.reason === "email" ? "email" : "signin",
    };
  }

  async consumeLoginLink(tokenHash: string, now: number, kind: "signin" | "email"): Promise<LoginLinkRecord | null> {
    return this.tx(() => {
      const r = this.get(`SELECT token_hash, email, return_to, reason, account_id, share_token FROM login_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND reason ${kind === "email" ? "=" : "!="} 'email'`, tokenHash, now);
      if (!r || !safeEqual(r.token_hash as string, tokenHash)) return null;
      const res = this.run("UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", now, tokenHash);
      if (Number(res.changes) !== 1) return null;
      return { email: r.email as string, returnTo: r.return_to as string, reason: r.reason as string, accountId: (r.account_id as string | null) ?? null, shareToken: (r.share_token as string | null) ?? null };
    });
  }

  async createSession(tokenHash: string, accountId: string, now: number, expiresAt: number): Promise<void> {
    this.run("INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)", tokenHash, accountId, now, expiresAt);
  }

  async getSessionAccount(tokenHash: string, now: number): Promise<Account | null> {
    const r = this.get(
      "SELECT s.token_hash, a.id, a.email FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?",
      tokenHash, now,
    );
    return r && safeEqual(r.token_hash as string, tokenHash) ? { id: r.id as string, email: r.email as string } : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  async getSessionState(tokenHash: string, now: number): Promise<{ account: AccountState; sessionRef: string } | null> {
    const r = this.get(
      "SELECT s.token_hash, a.id, a.email, a.membership_revision, a.is_staff FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?",
      tokenHash, now,
    );
    if (!r || !safeEqual(r.token_hash as string, tokenHash)) return null;
    return {
      account: { id: r.id as string, email: r.email as string, membershipRevision: Number(r.membership_revision), isStaff: Number(r.is_staff) === 1 },
      sessionRef: (r.token_hash as string).slice(0, 24),
    };
  }

  async isSessionLive(sessionRef: string, now: number): Promise<boolean> {
    if (!/^[a-f0-9]{24}$/.test(sessionRef)) return false;
    return !!this.get("SELECT 1 AS x FROM sessions WHERE substr(token_hash, 1, 24) = ? AND expires_at > ? LIMIT 1", sessionRef, now);
  }

  async getAccountState(accountId: string): Promise<AccountState | null> {
    const r = this.get("SELECT id, email, membership_revision, is_staff FROM accounts WHERE id = ?", accountId);
    return r ? { id: r.id as string, email: r.email as string, membershipRevision: Number(r.membership_revision), isStaff: Number(r.is_staff) === 1 } : null;
  }

  async syncStaff(accountId: string, isStaff: boolean): Promise<number> {
    return this.tx(() => {
      const r = this.get("SELECT membership_revision, is_staff FROM accounts WHERE id = ?", accountId);
      if (!r) return 0;
      if ((Number(r.is_staff) === 1) === isStaff) return Number(r.membership_revision);
      this.run("UPDATE accounts SET is_staff = ?, membership_revision = membership_revision + 1 WHERE id = ?", isStaff ? 1 : 0, accountId);
      return Number(r.membership_revision) + 1;
    });
  }

  async deleteAccountSessions(accountId: string): Promise<void> {
    this.tx(() => {
      this.run("DELETE FROM sessions WHERE account_id = ?", accountId);
      this.run("UPDATE accounts SET membership_revision = membership_revision + 1 WHERE id = ?", accountId);
    });
  }

  async prune(now: number): Promise<void> {
    this.run("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.run("DELETE FROM events WHERE at <= ?", now - EVENT_RETENTION_MS);
    // Keep used and expired links for a day so a second click still reads as "used", then drop them.
    this.run("DELETE FROM login_links WHERE expires_at <= ?", now - 24 * 3600_000);
  }

  async syncWall(accountId: string, stubs: Stub[], deleted: string[], now: number): Promise<WallState> {
    return this.tx(() => {
      const tombstoning = new Set(deleted);
      const existing = new Map<string, { updatedAt: number; deleted: boolean }>();
      const stored = new Map<string, string>();
      for (const r of this.all("SELECT stub_id, updated_at, deleted, data FROM wall_stubs WHERE account_id = ?", accountId)) {
        existing.set(r.stub_id as string, { updatedAt: Number(r.updated_at), deleted: Number(r.deleted) === 1 });
        if (Number(r.deleted) !== 1) stored.set(r.stub_id as string, r.data as string);
      }
      const upsert = this.db.prepare(
        "INSERT INTO wall_stubs (account_id, stub_id, updated_at, deleted, data) VALUES (?, ?, ?, 0, ?) " +
          "ON CONFLICT (account_id, stub_id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0, data = excluded.data",
      );
      for (const stub of stubs) {
        if (tombstoning.has(stub.id)) continue; // deleted in this same request: the delete wins
        const at = stub.updatedAt ?? 0;
        const cur = existing.get(stub.id);
        if (cur && at <= cur.updatedAt) continue; // server copy (or tombstone) is as new or newer
        // a device that had to let go of an older picture must not take it from the account's copy
        const prev = stored.get(stub.id);
        let keep = stub;
        if (prev && stub.versions.some((v) => artUnavailable(v.art))) {
          try {
            keep = retainArt(stub, JSON.parse(prev) as Stub);
          } catch {
            keep = stub; // an unreadable stored copy has nothing to give back
          }
        }
        const json = JSON.stringify(keep);
        upsert.run(accountId, stub.id, at, json);
        stored.set(stub.id, json); // a later entry for the same stub in this request sees what was just written
        existing.set(stub.id, { updatedAt: at, deleted: false });
      }
      const tomb = this.db.prepare(
        "INSERT INTO wall_stubs (account_id, stub_id, updated_at, deleted, data) VALUES (?, ?, ?, 1, '{}') " +
          "ON CONFLICT (account_id, stub_id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1, data = '{}' WHERE deleted = 0",
      );
      for (const id of tombstoning) tomb.run(accountId, id, now);
      return this.readWall(accountId);
    });
  }

  private readWall(accountId: string): WallState {
    const rows = this.all("SELECT stub_id, deleted, data FROM wall_stubs WHERE account_id = ? ORDER BY updated_at, stub_id", accountId);
    const stubs: Stub[] = [];
    const deleted: string[] = [];
    for (const r of rows) {
      if (Number(r.deleted) === 1) deleted.push(r.stub_id as string);
      else stubs.push(JSON.parse(r.data as string) as Stub);
    }
    return { stubs, deleted };
  }

  async listWall(accountId: string): Promise<Stub[]> {
    return this.readWall(accountId).stubs;
  }

  async setWallPublic(accountId: string, isPublic: boolean, newToken: string): Promise<string | null> {
    return this.tx(() => {
      const r = this.get("SELECT wall_token FROM accounts WHERE id = ?", accountId);
      const token = (r?.wall_token as string | null) ?? newToken;
      this.run("UPDATE accounts SET wall_public = ?, wall_token = ? WHERE id = ?", isPublic ? 1 : 0, token, accountId);
      return isPublic ? token : null;
    });
  }

  async getWallPublic(accountId: string): Promise<{ isPublic: boolean; token: string | null }> {
    const r = this.get("SELECT wall_token, wall_public FROM accounts WHERE id = ?", accountId);
    const isPublic = Number(r?.wall_public) === 1;
    return { isPublic, token: isPublic ? ((r?.wall_token as string | null) ?? null) : null };
  }

  async getPublicWall(token: string): Promise<Stub[] | null> {
    const a = this.get("SELECT id FROM accounts WHERE wall_token = ? AND wall_public = 1", token);
    return a ? this.readWall(a.id as string).stubs : null;
  }

  async rotateWallToken(accountId: string, newToken: string, keepPublic: boolean): Promise<string | null> {
    return this.tx(() => {
      const r = this.get("SELECT wall_public FROM accounts WHERE id = ?", accountId);
      if (!r) return null;
      const stayPublic = keepPublic && Number(r.wall_public) === 1;
      this.run("UPDATE accounts SET wall_token = ?, wall_public = ? WHERE id = ?", newToken, stayPublic ? 1 : 0, accountId);
      return stayPublic ? newToken : null;
    });
  }

  async createOrder(order: Order, accountId: string | null, email: string | null): Promise<void> {
    this.run("INSERT INTO orders (id, account_id, email, created_at, data) VALUES (?, ?, ?, ?, ?)", order.id, accountId, email, Date.parse(order.createdAt) || Date.now(), JSON.stringify(order));
  }

  async listOrders(accountId: string, email: string): Promise<Order[]> {
    // Guest orders placed with the same email (which this session has proved it owns) belong here too.
    const rows = this.all(
      "SELECT data FROM orders WHERE account_id = ? OR (account_id IS NULL AND email = ?) ORDER BY created_at DESC, id",
      accountId, email,
    );
    return rows.map((r) => JSON.parse(r.data as string) as Order);
  }

  async getOrder(id: string): Promise<{ order: Order; accountId: string | null; email: string | null } | null> {
    const r = this.get("SELECT account_id, email, data FROM orders WHERE id = ?", id);
    if (!r) return null;
    return { order: JSON.parse(r.data as string) as Order, accountId: (r.account_id as string | null) ?? null, email: (r.email as string | null) ?? null };
  }

  async updateOrderPayment(id: string, apply: (order: Order) => OrderPayment | null): Promise<{ before: Order; after: Order } | null> {
    return this.tx(() => {
      const r = this.get("SELECT data FROM orders WHERE id = ?", id);
      if (!r) return null;
      const before = JSON.parse(r.data as string) as Order;
      const payment = apply(before);
      if (!payment) return { before, after: before };
      const after: Order = { ...before, payment };
      this.run("UPDATE orders SET data = ? WHERE id = ?", JSON.stringify(after), id);
      return { before, after };
    });
  }

  async upsertShare(ownerKey: string, stub: Stub, newToken: string, now: number): Promise<string> {
    return this.tx(() => {
      const data = JSON.stringify(stub);
      const cur = this.get("SELECT token FROM shares WHERE owner_key = ? AND stub_id = ?", ownerKey, stub.id);
      if (cur) {
        this.run("UPDATE shares SET data = ?, updated_at = ? WHERE token = ?", data, now, cur.token as string);
        return cur.token as string;
      }
      this.run("INSERT INTO shares (token, owner_key, stub_id, data, updated_at) VALUES (?, ?, ?, ?, ?)", newToken, ownerKey, stub.id, data, now);
      return newToken;
    });
  }

  async getShare(token: string): Promise<Stub | null> {
    const r = this.get("SELECT data FROM shares WHERE token = ?", token);
    return r ? (JSON.parse(r.data as string) as Stub) : null;
  }

  async revokeShare(ownerKey: string, stubId: string): Promise<boolean> {
    return this.tx(() => {
      // A gift unwraps a share; with the share gone its message goes too.
      this.run("DELETE FROM gifts WHERE owner_key = ? AND stub_id = ?", ownerKey, stubId);
      return Number(this.run("DELETE FROM shares WHERE owner_key = ? AND stub_id = ?", ownerKey, stubId).changes) > 0;
    });
  }

  async adoptShares(fromKey: string, toKey: string): Promise<number> {
    return this.tx(() => {
      const moved = Number(this.run("UPDATE OR IGNORE shares SET owner_key = ? WHERE owner_key = ?", toKey, fromKey).changes);
      // Gifts follow their shares; one whose share stayed behind (the account already had that id) is dropped.
      this.run("UPDATE gifts SET owner_key = ? WHERE owner_key = ? AND EXISTS (SELECT 1 FROM shares s WHERE s.owner_key = ? AND s.stub_id = gifts.stub_id)", toKey, fromKey, toKey);
      this.run("DELETE FROM gifts WHERE owner_key = ?", fromKey);
      return moved;
    });
  }

  async createGift(ownerKey: string, stubId: string, tokenHash: string, to: string, message: string, now: number): Promise<string | null> {
    return this.tx(() => {
      const share = this.get("SELECT token FROM shares WHERE owner_key = ? AND stub_id = ?", ownerKey, stubId);
      if (!share) return null;
      this.run("INSERT INTO gifts (token_hash, owner_key, stub_id, recipient, message, created_at) VALUES (?, ?, ?, ?, ?, ?)", tokenHash, ownerKey, stubId, to, message, now);
      return share.token as string;
    });
  }

  async getGift(tokenHash: string, now: number, markOpened: boolean): Promise<GiftView | null> {
    return this.tx(() => {
      const r = this.get(
        "SELECT g.token_hash, g.owner_key, g.stub_id, g.recipient, g.message, g.opened_at, s.token AS share_token, s.data " +
          "FROM gifts g JOIN shares s ON s.owner_key = g.owner_key AND s.stub_id = g.stub_id WHERE g.token_hash = ?",
        tokenHash,
      );
      if (!r || !safeEqual(r.token_hash as string, tokenHash)) return null;
      let openedAt = (r.opened_at as number | null) ?? null;
      if (markOpened && openedAt === null) {
        this.run("UPDATE gifts SET opened_at = ? WHERE token_hash = ? AND opened_at IS NULL", now, tokenHash);
        openedAt = now;
      }
      return {
        shareToken: r.share_token as string,
        stub: JSON.parse(r.data as string) as Stub,
        to: r.recipient as string,
        message: r.message as string,
        openedAt,
        ownerKey: r.owner_key as string,
        stubId: r.stub_id as string,
      };
    });
  }

  async revokeGift(ownerKey: string, tokenHash: string): Promise<boolean> {
    return Number(this.run("DELETE FROM gifts WHERE token_hash = ? AND owner_key = ?", tokenHash, ownerKey).changes) > 0;
  }

  private approvalRow(r: Row): ApprovalRow {
    return {
      id: r.id as string,
      tenant: r.tenant as string,
      project: r.project as string,
      purpose: r.purpose as string,
      record: r.record as string,
      issuedAt: Number(r.issued_at),
      expiresAt: Number(r.expires_at),
      revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
      summary: typeof r.summary === "string" ? r.summary : null,
    };
  }

  private static readonly APPROVAL_SELECT =
    "SELECT a.*, (SELECT revoked_at FROM approval_revocations r WHERE r.approval_id = a.id) AS revoked_at, " +
    "(SELECT summary FROM approval_summaries s WHERE s.approval_id = a.id) AS summary FROM approvals a";

  async getWallStub(accountId: string, stubId: string): Promise<Stub | null> {
    const r = this.get("SELECT data FROM wall_stubs WHERE account_id = ? AND stub_id = ? AND deleted = 0", accountId, stubId);
    return r ? (JSON.parse(r.data as string) as Stub) : null;
  }

  async issueApproval(tenant: string, stubId: string, now: number, make: (stub: Stub) => NewApproval): Promise<{ row: ApprovalRow; created: boolean } | null> {
    return this.tx(() => {
      const w = this.get("SELECT data FROM wall_stubs WHERE account_id = ? AND stub_id = ? AND deleted = 0", tenant, stubId);
      if (!w) return null;
      const made = make(JSON.parse(w.data as string) as Stub);
      const same = this.get(
        `${SqliteStorage.APPROVAL_SELECT} WHERE a.tenant = ? AND a.project = ? AND a.purpose = ? AND a.idem_key = ? AND a.expires_at > ? ` +
          "AND NOT EXISTS (SELECT 1 FROM approval_revocations r WHERE r.approval_id = a.id) ORDER BY a.seq DESC LIMIT 1",
        tenant, stubId, made.purpose, made.idemKey, now,
      );
      if (same) return { row: this.approvalRow(same), created: false };
      this.run(
        "INSERT INTO approvals (id, tenant, project, purpose, idem_key, record, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        made.id, tenant, stubId, made.purpose, made.idemKey, made.record, made.issuedAt, made.expiresAt,
      );
      this.run("INSERT INTO approval_summaries (approval_id, tenant, summary) VALUES (?, ?, ?)", made.id, tenant, made.summary);
      return { row: { id: made.id, tenant, project: stubId, purpose: made.purpose, record: made.record, issuedAt: made.issuedAt, expiresAt: made.expiresAt, revokedAt: null, summary: made.summary }, created: true };
    });
  }

  async getApproval(id: string): Promise<ApprovalRow | null> {
    const r = this.get(`${SqliteStorage.APPROVAL_SELECT} WHERE a.id = ?`, id);
    return r ? this.approvalRow(r) : null;
  }

  async listApprovals(tenant: string, stubId: string): Promise<ApprovalRow[]> {
    return this.all(`${SqliteStorage.APPROVAL_SELECT} WHERE a.tenant = ? AND a.project = ? ORDER BY a.seq DESC LIMIT 200`, tenant, stubId).map((r) => this.approvalRow(r));
  }

  async revokeApproval(tenant: string, stubId: string, approvalId: string, now: number): Promise<"revoked" | "already" | "missing"> {
    return this.tx(() => {
      const a = this.get("SELECT id FROM approvals WHERE id = ? AND tenant = ? AND project = ?", approvalId, tenant, stubId);
      if (!a) return "missing" as const;
      if (this.get("SELECT 1 AS x FROM approval_revocations WHERE approval_id = ?", approvalId)) return "already" as const;
      this.run("INSERT INTO approval_revocations (approval_id, tenant, revoked_at) VALUES (?, ?, ?)", approvalId, tenant, now);
      return "revoked" as const;
    });
  }

  private orderAuthRow(r: Row): OrderAuthRow {
    return {
      id: r.id as string,
      tenant: r.tenant as string,
      project: r.project as string,
      actionId: r.action_id as string,
      idemKey: r.idem_key as string,
      reqHash: r.req_hash as string,
      record: r.record as string,
      issuedAt: Number(r.issued_at),
      expiresAt: Number(r.expires_at),
      revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
      superseded: Number(r.superseded) === 1,
    };
  }

  private orderClaimRow(r: Row): OrderClaimRow {
    return {
      authorizationId: r.authorization_id as string,
      actionId: r.action_id as string,
      tenant: r.tenant as string,
      consumer: r.consumer as string,
      idemKey: r.idem_key as string,
      claimRef: r.claim_ref as string,
      claimedAt: Number(r.claimed_at),
    };
  }

  private static readonly ORDER_AUTH_SELECT =
    "SELECT a.*, (SELECT revoked_at FROM order_authorization_revocations r WHERE r.authorization_id = a.id) AS revoked_at, " +
    "EXISTS (SELECT 1 FROM order_authorizations n WHERE n.action_id = a.action_id AND n.seq > a.seq) AS superseded FROM order_authorizations a";

  /** The snapshot, read inside whatever transaction the caller holds. */
  private snapshotOrderAuth(id: string, consumer?: string, idemKey?: string): OrderAuthSnapshot {
    const a = this.get(`${SqliteStorage.ORDER_AUTH_SELECT} WHERE a.id = ?`, id);
    const auth = a ? this.orderAuthRow(a) : null;
    let approval: ApprovalRow | null = null;
    let stub: Stub | null = null;
    let account: AccountState | null = null;
    if (auth) {
      const ref = (JSON.parse(auth.record) as { approval?: { id?: string } }).approval?.id;
      const ap = typeof ref === "string" ? this.get(`${SqliteStorage.APPROVAL_SELECT} WHERE a.id = ? AND a.tenant = ?`, ref, auth.tenant) : undefined;
      approval = ap ? this.approvalRow(ap) : null;
      const w = this.get("SELECT data FROM wall_stubs WHERE account_id = ? AND stub_id = ? AND deleted = 0", auth.tenant, auth.project);
      stub = w ? (JSON.parse(w.data as string) as Stub) : null;
      const acc = this.get("SELECT id, email, membership_revision, is_staff FROM accounts WHERE id = ?", auth.tenant);
      account = acc ? { id: acc.id as string, email: acc.email as string, membershipRevision: Number(acc.membership_revision), isStaff: Number(acc.is_staff) === 1 } : null;
    }
    const c = auth ? this.get("SELECT * FROM order_authorization_claims WHERE authorization_id = ?", auth.id) : undefined;
    const k = consumer !== undefined && idemKey !== undefined ? this.get("SELECT * FROM order_authorization_claims WHERE consumer = ? AND idem_key = ?", consumer, idemKey) : undefined;
    return { auth, approval, stub, account, claim: c ? this.orderClaimRow(c) : null, claimByKey: k ? this.orderClaimRow(k) : null };
  }

  async issueOrderAuthorization(
    tenant: string,
    stubId: string,
    approvalId: string,
    idemKey: string,
    reqHash: string,
    now: number,
    make: (stub: Stub, approval: ApprovalRow | null, actionClaimed: (actionId: string) => boolean) => NewOrderAuth,
  ): Promise<{ row: OrderAuthRow; created: boolean } | "conflict" | null> {
    void now;
    return this.tx(() => {
      const w = this.get("SELECT data FROM wall_stubs WHERE account_id = ? AND stub_id = ? AND deleted = 0", tenant, stubId);
      if (!w) return null;
      const same = this.get(`${SqliteStorage.ORDER_AUTH_SELECT} WHERE a.tenant = ? AND a.idem_key = ?`, tenant, idemKey);
      if (same) return same.project === stubId && same.req_hash === reqHash ? { row: this.orderAuthRow(same), created: false } : ("conflict" as const);
      const ap = this.get(`${SqliteStorage.APPROVAL_SELECT} WHERE a.id = ? AND a.tenant = ? AND a.project = ?`, approvalId, tenant, stubId);
      const made = make(JSON.parse(w.data as string) as Stub, ap ? this.approvalRow(ap) : null, (actionId) => !!this.get("SELECT 1 AS x FROM order_authorization_claims WHERE action_id = ?", actionId));
      this.run(
        "INSERT INTO order_authorizations (id, tenant, project, action_id, idem_key, req_hash, record, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        made.id, tenant, stubId, made.actionId, made.idemKey, made.reqHash, made.record, made.issuedAt, made.expiresAt,
      );
      return { row: this.orderAuthRow(this.get(`${SqliteStorage.ORDER_AUTH_SELECT} WHERE a.id = ?`, made.id) as Row), created: true };
    });
  }

  async getOrderAuthorization(id: string): Promise<OrderAuthRow | null> {
    const r = this.get(`${SqliteStorage.ORDER_AUTH_SELECT} WHERE a.id = ?`, id);
    return r ? this.orderAuthRow(r) : null;
  }

  async listOrderAuthorizations(tenant: string, stubId: string): Promise<OrderAuthRow[]> {
    return this.all(`${SqliteStorage.ORDER_AUTH_SELECT} WHERE a.tenant = ? AND a.project = ? ORDER BY a.seq DESC LIMIT 100`, tenant, stubId).map((r) => this.orderAuthRow(r));
  }

  async getOrderAuthSnapshot(id: string, consumer?: string, idemKey?: string): Promise<OrderAuthSnapshot> {
    return this.tx(() => this.snapshotOrderAuth(id, consumer, idemKey));
  }

  async revokeOrderAuthorization(tenant: string, stubId: string, id: string, now: number): Promise<"revoked" | "already" | "missing"> {
    return this.tx(() => {
      const a = this.get("SELECT id FROM order_authorizations WHERE id = ? AND tenant = ? AND project = ?", id, tenant, stubId);
      if (!a) return "missing" as const;
      if (this.get("SELECT 1 AS x FROM order_authorization_revocations WHERE authorization_id = ?", id)) return "already" as const;
      this.run("INSERT INTO order_authorization_revocations (authorization_id, tenant, revoked_at) VALUES (?, ?, ?)", id, tenant, now);
      return "revoked" as const;
    });
  }

  async claimOrderAuthorization(
    id: string,
    consumer: string,
    idemKey: string,
    claimRef: string,
    now: number,
    decide: (snap: OrderAuthSnapshot) => { ok: true } | { ok: false; reason: string; fields?: string[] },
  ): Promise<OrderClaimOutcome> {
    try {
      return this.tx((): OrderClaimOutcome => {
        const snap = this.snapshotOrderAuth(id, consumer, idemKey);
        const verdict = decide(snap);
        if (!verdict.ok) return verdict;
        // The verdict allows a claim already committed only under this same key: that is the replay.
        if (snap.claim) return { ok: true, claim: snap.claim, replayed: true };
        const auth = snap.auth as OrderAuthRow;
        this.run(
          "INSERT INTO order_authorization_claims (authorization_id, action_id, tenant, consumer, idem_key, claim_ref, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          auth.id, auth.actionId, auth.tenant, consumer, idemKey, claimRef, now,
        );
        return { ok: true, claim: { authorizationId: auth.id, actionId: auth.actionId, tenant: auth.tenant, consumer, idemKey, claimRef, claimedAt: now }, replayed: false };
      });
    } catch (e) {
      // Another process won the same authorization, action or key between our read and our insert; the write lock makes this rare, the constraints make it safe.
      if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) return { ok: false, reason: "already_claimed" };
      throw e;
    }
  }

  async findOrderClaim(consumer: string, idemKey: string): Promise<{ claim: OrderClaimRow; project: string } | null> {
    const r = this.get(
      "SELECT c.*, a.project AS project FROM order_authorization_claims c JOIN order_authorizations a ON a.id = c.authorization_id WHERE c.consumer = ? AND c.idem_key = ?",
      consumer, idemKey,
    );
    return r ? { claim: this.orderClaimRow(r), project: r.project as string } : null;
  }

  async appendEvent(e: TicketstubEvent, tenantRef?: string): Promise<void> {
    this.run(
      "INSERT INTO events (type, at, request_id, actor, actor_ref, tenant_ref, project_ref, mode, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      e.type, e.at, e.requestId, e.actor, e.actorRef ?? null, tenantRef ?? null, e.projectRef ?? null, e.mode, JSON.stringify(e.fields),
    );
  }

  async listEvents(filter: { projectRef?: string; limit: number }): Promise<StoredEvent[]> {
    const rows = filter.projectRef
      ? this.all("SELECT * FROM events WHERE project_ref = ? ORDER BY seq DESC LIMIT ?", filter.projectRef, filter.limit)
      : this.all("SELECT * FROM events ORDER BY seq DESC LIMIT ?", filter.limit);
    return rows.map((r) => ({
      schema: EVENT_SCHEMA,
      seq: Number(r.seq),
      type: r.type as StoredEvent["type"],
      at: Number(r.at),
      requestId: r.request_id as string,
      actor: r.actor as StoredEvent["actor"],
      ...(r.actor_ref ? { actorRef: r.actor_ref as string } : {}),
      ...(r.tenant_ref ? { tenantRef: r.tenant_ref as string } : {}),
      ...(r.project_ref ? { projectRef: r.project_ref as string } : {}),
      mode: r.mode as StoredEvent["mode"],
      fields: JSON.parse(r.fields as string) as StoredEvent["fields"],
    }));
  }

  async ownsStub(tenantId: string, stubId: string): Promise<boolean> {
    if (this.get("SELECT 1 AS x FROM shares WHERE owner_key = ? AND stub_id = ?", tenantId, stubId)) return true;
    return !!this.get("SELECT 1 AS x FROM wall_stubs WHERE account_id = ? AND stub_id = ? AND deleted = 0", tenantId, stubId);
  }

  async getEventCaptain(eventId: string): Promise<string | null> {
    const r = this.get("SELECT account_id FROM organizer_events WHERE id = ?", eventId);
    return r ? (r.account_id as string) : null;
  }

  async createEvent(accountId: string, event: { id: string; title: string; stub: Stub; expiresAt: number }, claims: NewClaim[], now: number): Promise<void> {
    this.tx(() => {
      this.run("INSERT INTO organizer_events (id, account_id, title, stub, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", event.id, accountId, event.title, JSON.stringify(event.stub), now, event.expiresAt);
      const ins = this.db.prepare("INSERT INTO claims (token_hash, event_id, guest_name, seat) VALUES (?, ?, ?, ?)");
      for (const c of claims) ins.run(c.tokenHash, event.id, c.guestName, c.seat ?? null);
    });
  }

  private readClaim(tokenHash: string): ClaimView | null {
    const r = this.get(
      "SELECT c.event_id, c.guest_name, c.seat, c.claimed_by, c.claimed_stub_id, e.stub, e.expires_at " +
        "FROM claims c JOIN organizer_events e ON e.id = c.event_id WHERE c.token_hash = ?",
      tokenHash,
    );
    if (!r) return null;
    return {
      eventId: r.event_id as string,
      stub: JSON.parse(r.stub as string) as Stub,
      guestName: r.guest_name as string,
      seat: (r.seat as string | null) ?? undefined,
      expiresAt: Number(r.expires_at),
      claimedBy: (r.claimed_by as string | null) ?? null,
      claimedStubId: (r.claimed_stub_id as string | null) ?? null,
    };
  }

  async getClaim(tokenHash: string): Promise<ClaimView | null> {
    return this.readClaim(tokenHash);
  }

  async claim(tokenHash: string, accountId: string, guestStub: (view: ClaimView) => Stub, now: number): Promise<ClaimResult> {
    return this.tx((): ClaimResult => {
      const view = this.readClaim(tokenHash);
      if (!view) return { status: "missing" };
      if (view.claimedBy) {
        if (view.claimedBy !== accountId) return { status: "taken" };
        const live = view.claimedStubId
          ? this.get("SELECT data FROM wall_stubs WHERE account_id = ? AND stub_id = ? AND deleted = 0", accountId, view.claimedStubId)
          : undefined;
        return { status: "already", stub: live ? (JSON.parse(live.data as string) as Stub) : guestStub(view) };
      }
      if (now > view.expiresAt) return { status: "expired" };
      const stub = guestStub(view);
      this.run(
        "INSERT INTO wall_stubs (account_id, stub_id, updated_at, deleted, data) VALUES (?, ?, ?, 0, ?) " +
          "ON CONFLICT (account_id, stub_id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0, data = excluded.data",
        accountId, stub.id, stub.updatedAt ?? now, JSON.stringify(stub),
      );
      this.run("UPDATE claims SET claimed_by = ?, claimed_stub_id = ?, claimed_at = ? WHERE token_hash = ?", accountId, stub.id, now, tokenHash);
      return { status: "claimed", stub };
    });
  }
}
