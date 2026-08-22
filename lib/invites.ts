import type Database from "better-sqlite3";

// why an invite failed, kept coarse on purpose: lib/auth.ts turns this into a single generic
// message so a stranger probing the signup form can't distinguish "no such code" from "already
// used" by the wording alone
export type InviteRedemptionFailureReason =
  | "missing_code"
  | "not_found"
  | "already_redeemed"
  | "email_mismatch";

export type InviteRedemptionResult = { ok: true } | { ok: false; reason: InviteRedemptionFailureReason };

interface InviteRow {
  redeemed_at: string | null;
  email: string | null;
}

/**
 * Atomically claims a single-use invite code. The UPDATE's WHERE clause is the entire enforcement
 * mechanism: SQLite serializes writes on one connection, so two concurrent redemptions of the same
 * code can never both report success -- only one UPDATE affects a row, no separate locking needed.
 * An invite whose `email` column is set is scoped to that address (case-insensitive); an invite
 * with a null email can be redeemed by anyone holding the code.
 *
 * Callers (lib/auth.ts) are expected to run this BEFORE creating the account and to call
 * unredeemInvite to compensate if account creation subsequently fails -- that ordering is what
 * keeps "redeemed" and "account exists" from being able to half-succeed relative to each other.
 */
export function redeemInvite(db: Database.Database, code: string, email: string): InviteRedemptionResult {
  const trimmedCode = code.trim();
  if (!trimmedCode) return { ok: false, reason: "missing_code" };

  const normalizedEmail = email.trim().toLowerCase();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `UPDATE invites
       SET redeemed_at = ?, redeemed_by = ?
       WHERE code = ? AND redeemed_at IS NULL AND (email IS NULL OR lower(email) = ?)`
    )
    .run(now, email, trimmedCode, normalizedEmail);

  if (result.changes === 1) return { ok: true };

  // the write above is already the final decision -- this second read only exists to explain why
  // it affected zero rows, so a stale read here can never itself cause a double-redemption
  const row = db
    .prepare(`SELECT redeemed_at, email FROM invites WHERE code = ?`)
    .get(trimmedCode) as InviteRow | undefined;

  if (!row) return { ok: false, reason: "not_found" };
  if (row.redeemed_at) return { ok: false, reason: "already_redeemed" };
  return { ok: false, reason: "email_mismatch" };
}

// compensating rollback for a redemption whose paired account creation failed afterward (duplicate
// email, weak password, etc) -- puts the code back to unredeemed so the user doesn't lose their one
// shot on an error that had nothing to do with the invite itself. Unconditional on code alone: only
// lib/auth.ts's after-hook ever calls this, and only for a code it just redeemed itself.
export function unredeemInvite(db: Database.Database, code: string): void {
  const trimmedCode = code.trim();
  if (!trimmedCode) return;
  db.prepare(`UPDATE invites SET redeemed_at = NULL, redeemed_by = NULL WHERE code = ?`).run(trimmedCode);
}

// one place to turn a reason into user-facing copy, so the "don't leak which codes exist" decision
// lives with the logic it protects rather than being re-decided at each call site
export function inviteErrorMessage(reason: InviteRedemptionFailureReason): string {
  if (reason === "missing_code") return "An invite code is required.";
  return "That invite code is invalid or has already been used.";
}
