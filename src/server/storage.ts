import "server-only";
// The storage interface. Routes and auth only talk to this, so Postgres can replace SQLite later by
// implementing it. Ordinary methods are async. A backend that supports a final
// synchronous provider fence must additionally implement the optional owned snapshot below.
import type { Order, OrderPayment } from "@/customer/pages/commerce";
import type { Stub } from "@/customer/studio/types";
import type { StoredEvent, TicketstubEvent } from "./events";

export interface Account {
  id: string;
  email: string;
}

export interface LoginLinkRecord {
  email: string;
  returnTo: string;
  reason: string;
  /** Set for an email-change link: the account that asked for it. */
  accountId?: string | null;
  /** The share token of the stub being saved, so the confirm page and email can show it. */
  shareToken?: string | null;
}

/** What the context layer reads about an account. membershipRevision only ever goes up. */
export interface AccountState extends Account {
  membershipRevision: number;
  isStaff: boolean;
}

export interface WallRow {
  stub: Stub;
  updatedAt: number;
}

export interface WallState {
  stubs: Stub[];
  /** Tombstoned ids. */
  deleted: string[];
}

export interface ShareRecord {
  token: string;
  stub: Stub;
}

/** A gift as its link holder sees it: the unwrapped share, who it is for, the message, and when someone first opened it. */
export interface GiftView {
  /** The share token of the gift's stub, so the page can be linked. */
  shareToken: string;
  stub: Stub;
  to: string;
  message: string;
  openedAt: number | null;
  /** Who made it. Never sent to the link holder; the route compares it with the caller. */
  ownerKey: string;
  stubId: string;
}

export interface ClaimView {
  eventId: string;
  stub: Stub;
  guestName: string;
  seat?: string;
  expiresAt: number;
  claimedBy: string | null;
  /** The id of the stub the claim created on the claimer's wall. */
  claimedStubId: string | null;
}

export interface NewClaim {
  tokenHash: string;
  guestName: string;
  seat?: string;
}

export type ClaimResult =
  | { status: "claimed" | "already"; stub: Stub }
  | { status: "taken" }
  | { status: "expired" }
  | { status: "missing" };

export interface ArtQuota {
  key: string;
  max: number;
}

export type ArtQuotaResult = { ok: true } | { ok: false; retryAt: number };

/** One stored approval: the signed record as JSON, plus what the append-only tables add. */
export interface ApprovalRow {
  id: string;
  tenant: string;
  /** The stub id. */
  project: string;
  purpose: string;
  /** The record as canonical JSON. The token is derived from it. */
  record: string;
  issuedAt: number;
  expiresAt: number;
  /** Epoch ms of the revocation row, or null. */
  revokedAt: number | null;
  /** The owner-only printed-facts summary as JSON (never part of the signed record), or null for an approval issued before it existed. */
  summary: string | null;
}

/** What `issueApproval`'s builder returns for a stub it was shown. `idemKey` is the hash of purpose + binding. */
export interface NewApproval {
  id: string;
  purpose: string;
  idemKey: string;
  record: string;
  /** Owner-only printed-facts summary as JSON, stored beside the record in the same write. */
  summary: string;
  issuedAt: number;
  expiresAt: number;
}

/** An order authorization as stored: the signed record as canonical JSON, plus what is derived from other rows. */
export interface OrderAuthRow {
  id: string;
  tenant: string;
  /** The stub id. */
  project: string;
  actionId: string;
  idemKey: string;
  /** Hash of the normalized issue request, so a retry with the same key is told apart from a reuse with different terms. */
  reqHash: string;
  record: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  /** A newer authorization exists for the same action. */
  superseded: boolean;
}

export interface NewOrderAuth {
  id: string;
  actionId: string;
  idemKey: string;
  reqHash: string;
  record: string;
  issuedAt: number;
  expiresAt: number;
}

/** A committed claim: the single use of one authorization, made by one consumer under one idempotency key. */
export interface OrderClaimRow {
  authorizationId: string;
  actionId: string;
  tenant: string;
  consumer: string;
  idemKey: string;
  claimRef: string;
  claimedAt: number;
}

/** Everything the verifier needs about one authorization, read in one transaction so it is consistent. */
export interface OrderAuthSnapshot {
  auth: OrderAuthRow | null;
  /** The referenced approval row (with its revocation), or null when missing or another tenant's. */
  approval: ApprovalRow | null;
  /** The owner's stub as the server holds it now, or null. */
  stub: Stub | null;
  account: AccountState | null;
  /** The claim on this authorization, if any. */
  claim: OrderClaimRow | null;
  /** The claim made under (consumer, idemKey), on any authorization, if any. */
  claimByKey: OrderClaimRow | null;
}

export type OrderClaimOutcome = { ok: true; claim: OrderClaimRow; replayed: boolean } | { ok: false; reason: string; fields?: string[] };

export interface Storage {
  // accounts
  findOrCreateAccount(email: string, now: number): Promise<Account>;
  getAccount(id: string): Promise<Account | null>;
  changeEmail(accountId: string, email: string): Promise<"changed" | "taken" | "missing">;
  /**
   * Removes the account and everything it owns. Orders stay, anonymised (email removed, account id nulled).
   * Returns the stored file names (art) that nothing references any more, for the caller to unlink.
   */
  deleteAccount(accountId: string, email: string): Promise<string[]>;

  // magic links: only hashes are stored
  createLoginLink(tokenHash: string, link: LoginLinkRecord, now: number, expiresAt: number): Promise<void>;
  /** Looks a link up without consuming it. Null when unknown, used or expired. */
  peekLoginLink(tokenHash: string, now: number): Promise<(LoginLinkRecord & { kind: "signin" | "email" }) | null>;
  /**
   * Marks the link used and returns it, or null when unknown, used or expired. Atomic.
   * "signin" accepts sign-in links only; "email" accepts email-change links only, so one can't stand in for the other.
   */
  consumeLoginLink(tokenHash: string, now: number, kind: "signin" | "email"): Promise<LoginLinkRecord | null>;

  // sessions: only hashes are stored
  createSession(tokenHash: string, accountId: string, now: number, expiresAt: number): Promise<void>;
  getSessionAccount(tokenHash: string, now: number): Promise<Account | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** The account behind a live session, with its membership revision and a non-secret reference to the session. Null when unknown, expired or signed out. */
  getSessionState(tokenHash: string, now: number): Promise<{ account: AccountState; sessionRef: string } | null>;
  /** One current owner snapshot for the final synchronous creative send fence.
   * No cached context, Promise or borrowed transaction may stand in for this read. */
  readCreativeDispatchState?(tokenHash: string, stubId: string, now: number): { account: AccountState; sessionRef: string; ownsStub: boolean } | null;
  /** True while the session behind a sessionRef still exists and has not expired. */
  isSessionLive(sessionRef: string, now: number): Promise<boolean>;
  /** The current state of an account, or null once it is deleted. */
  getAccountState(accountId: string): Promise<AccountState | null>;
  /** Records whether the account is on the staff list now. A change bumps membershipRevision. Returns the current revision. */
  syncStaff(accountId: string, isStaff: boolean): Promise<number>;
  /** Signs the account out everywhere and bumps membershipRevision. */
  deleteAccountSessions(accountId: string): Promise<void>;
  prune(now: number): Promise<void>;

  // wall
  /** Merges per id: the newer updatedAt wins, a tombstone wins over an older stub. Returns the whole wall. */
  syncWall(accountId: string, stubs: Stub[], deleted: string[], now: number): Promise<WallState>;
  listWall(accountId: string): Promise<Stub[]>;
  setWallPublic(accountId: string, isPublic: boolean, newToken: string): Promise<string | null>;
  getWallPublic(accountId: string): Promise<{ isPublic: boolean; token: string | null }>;
  getPublicWall(token: string): Promise<Stub[] | null>;
  /** Issues a new public token so the old link dies, and switches the wall off when `keepPublic` is false. Returns the new token (null when the wall is now private). */
  rotateWallToken(accountId: string, newToken: string, keepPublic: boolean): Promise<string | null>;

  // orders
  createOrder(order: Order, accountId: string | null, email: string | null): Promise<void>;
  listOrders(accountId: string, email: string): Promise<Order[]>;
  /** The order and who placed it, or null. */
  getOrder(id: string): Promise<{ order: Order; accountId: string | null; email: string | null } | null>;
  /**
   * Replaces the order's payment in one transaction when `apply` returns a new one; null leaves it unchanged.
   * Returns the order before and after, so a caller acts only on a transition it caused (a receipt sends once).
   */
  updateOrderPayment(id: string, apply: (order: Order) => OrderPayment | null): Promise<{ before: Order; after: Order } | null>;

  // shares
  /** The same owner and stub id always get the same token; the snapshot is replaced each time. */
  upsertShare(ownerKey: string, stub: Stub, newToken: string, now: number): Promise<string>;
  getShare(token: string): Promise<Stub | null>;
  /** Deletes the share of one stub, so its token stops resolving. The next share mints a new token. True when one existed. */
  revokeShare(ownerKey: string, stubId: string): Promise<boolean>;
  // gifts: only the token hash is stored. The message is never part of a share.
  /** Stores a gift for a stub this owner has shared. Returns the share token, or null when that share does not exist. */
  createGift(ownerKey: string, stubId: string, tokenHash: string, to: string, message: string, now: number): Promise<string | null>;
  /** The gift behind a token, or null (unknown, revoked, or its share was stopped). `markOpened` records the first open. */
  getGift(tokenHash: string, now: number, markOpened: boolean): Promise<GiftView | null>;
  /** Deletes the gift and its message. True when one existed and belonged to this owner. */
  revokeGift(ownerKey: string, tokenHash: string): Promise<boolean>;
  /** Moves a guest device's shares to the account that just proved an email. Ids the account already shares stay with the guest. */
  adoptShares(fromKey: string, toKey: string): Promise<number>;
  /** Does this tenant (account id, or guest:<id>) own the stub: on its wall, or shared by it? Never answers from a body id alone. */
  ownsStub(tenantId: string, stubId: string): Promise<boolean>;
  /** The account that created an organizer event, or null. */
  getEventCaptain(eventId: string): Promise<string | null>;

  // artwork approvals (append-only; see src/server/approval.ts)
  /** One stub from the account's own wall, or null (missing, deleted). The stub the server holds, never one from a body. */
  getWallStub(accountId: string, stubId: string): Promise<Stub | null>;
  /**
   * In one write lock: reads the wall stub, hands it to `make`, and inserts what it returns. If the same tenant, project, purpose
   * and binding already has a live (not revoked, not expired) approval, that one is returned with created false and nothing is inserted.
   * Null when the stub is not on the account's wall. `make` throws to refuse.
   */
  issueApproval(tenant: string, stubId: string, now: number, make: (stub: Stub) => NewApproval): Promise<{ row: ApprovalRow; created: boolean } | null>;
  getApproval(id: string): Promise<ApprovalRow | null>;
  /** Newest first. */
  listApprovals(tenant: string, stubId: string): Promise<ApprovalRow[]>;
  /** Adds a revocation row for an approval this tenant holds. "already" when one exists, "missing" for an id that is not this tenant's. */
  revokeApproval(tenant: string, stubId: string, approvalId: string, now: number): Promise<"revoked" | "already" | "missing">;

  // order authorizations (append-only; see src/server/order-authorization.ts)
  /**
   * In one write lock: a retry of the same (tenant, idemKey, reqHash) returns the stored authorization (created false); the same key with a
   * different request is `conflict`; otherwise reads the wall stub and the referenced approval row, hands them to `make` and inserts what it
   * returns. Null when the stub is not on the account's wall. `make` throws to refuse.
   */
  issueOrderAuthorization(
    tenant: string,
    stubId: string,
    approvalId: string,
    idemKey: string,
    reqHash: string,
    now: number,
    make: (stub: Stub, approval: ApprovalRow | null, actionClaimed: (actionId: string) => boolean) => NewOrderAuth,
  ): Promise<{ row: OrderAuthRow; created: boolean } | "conflict" | null>;
  getOrderAuthorization(id: string): Promise<OrderAuthRow | null>;
  /** Newest first. */
  listOrderAuthorizations(tenant: string, stubId: string): Promise<OrderAuthRow[]>;
  /** One consistent read of an authorization and everything its verdict depends on. `consumer` and `idemKey` fill claimByKey. */
  getOrderAuthSnapshot(id: string, consumer?: string, idemKey?: string): Promise<OrderAuthSnapshot>;
  /** Adds a revocation row for an authorization this tenant holds, claimed or not. "already" when one exists, "missing" for an id that is not this tenant's. */
  revokeOrderAuthorization(tenant: string, stubId: string, id: string, now: number): Promise<"revoked" | "already" | "missing">;
  /**
   * The atomic single-use claim. In one write lock: snapshots, asks `decide` for the verdict, and only on ok inserts the claim (uniqueness on
   * authorization, action and (consumer, idemKey) backs this up across processes). A claim already committed under the same key is returned
   * with replayed true and nothing is inserted. A uniqueness violation is already_claimed.
   */
  claimOrderAuthorization(
    id: string,
    consumer: string,
    idemKey: string,
    claimRef: string,
    now: number,
    decide: (snap: OrderAuthSnapshot) => { ok: true } | { ok: false; reason: string; fields?: string[] },
  ): Promise<OrderClaimOutcome>;
  /** The claim committed under (consumer, idemKey), with the authorization's tenant and project, or null. */
  findOrderClaim(consumer: string, idemKey: string): Promise<{ claim: OrderClaimRow; project: string } | null>;

  // product events (append-only; see src/server/events.ts)
  appendEvent(event: TicketstubEvent, tenantRef?: string): Promise<void>;
  /** Newest first. `projectRef` narrows to one project; without it the caller must be staff. */
  listEvents(filter: { projectRef?: string; limit: number }): Promise<StoredEvent[]>;

  // art generation caps
  /**
   * Checks every quota for today (UTC). When all have room and `consume` is true, counts one use on each, atomically.
   * When any is full, nothing is counted and `retryAt` is the next UTC midnight (epoch ms).
   */
  useArtQuota(quotas: ArtQuota[], now: number, consume: boolean): Promise<ArtQuotaResult>;

  // organizer events and claims
  createEvent(
    accountId: string,
    event: { id: string; title: string; stub: Stub; expiresAt: number },
    claims: NewClaim[],
    now: number,
  ): Promise<void>;
  getClaim(tokenHash: string): Promise<ClaimView | null>;
  /** Adds the guest's stub to the account's wall. Idempotent for the same account. */
  claim(tokenHash: string, accountId: string, guestStub: (view: ClaimView) => Stub, now: number): Promise<ClaimResult>;
}
