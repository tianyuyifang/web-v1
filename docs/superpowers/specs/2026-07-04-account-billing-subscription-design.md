# Account Billing / Subscription Management — Design

**Date:** 2026-07-04
**Status:** Approved, ready for implementation plan

## Goal

Charge a monthly fee per account. Track a subscription expiration date and related
billing info per user. Add a user-facing "Account" page (navbar button) where each user
sees their own subscription status, and give admins the ability to view and edit every
user's billing details. Also restructure the navbar: add the Account button and move
Logout into the Settings page.

## Decisions (from brainstorming)

- **Audience:** Both — a self-service user page AND admin management.
- **On expiry:** Warn only (soft). Expired users keep full access; they see a warning
  banner and show as EXPIRED in admin/account views. No hard access block. (Reversible,
  and mirrors nothing about the PENDING hard-block flow.)
- **Per-user billing fields:** monthly fee amount, payment status, admin notes.
  (No contact-info field.)
- **Monthly fee:** supports decimals (e.g. 29.90).
- **Renewal action:** a "+1 Month" button (server-computed) plus a manual date picker.
- **User view:** user sees expiry + active/expired status + their monthly fee.
  Admin notes are NOT shown to the user.

## 1. Data model

Add four **nullable** fields to the `User` model in `backend/prisma/schema.prisma`.
All optional so existing users (including admins) are unaffected and the change is
fully reversible.

| Prisma field    | Column          | Type                          | Meaning |
|-----------------|-----------------|-------------------------------|---------|
| `expiresAt`     | `expires_at`    | `DateTime?` (timestamptz)     | Subscription expiration. `null` = no expiry set. |
| `monthlyFee`    | `monthly_fee`   | `Decimal?` (`@db.Decimal(10,2)`) | Monthly fee amount, decimals allowed. |
| `paymentStatus` | `payment_status`| enum `PaymentStatus?`         | Admin-set marker: `PAID` / `UNPAID` / `OVERDUE`. |
| `billingNotes`  | `billing_notes` | `String?`                     | Freeform admin note (admin-private). |

New enum:

```prisma
enum PaymentStatus {
  PAID
  UNPAID
  OVERDUE
}
```

One Prisma migration adds the enum + four columns. Nothing is dropped or made required.

**Derived status (computed on read, not stored):**
- `active` — `expiresAt` is `null` OR in the future.
- `expired` — `expiresAt` is in the past.

This derived `status` drives the user-facing warning banner and the admin status display.

## 2. Backend API

### Admin (ADMIN-only; extend `adminService.js` / `routes/admin.js`)

- **`listUsers`** — add the four billing fields to the `select` so the admin table can
  render them. (`billingNotes` included; this is the admin surface.)
- **`PATCH /admin/users/:id/billing`** — update any subset of
  `{ expiresAt, monthlyFee, paymentStatus, billingNotes }`.
  - Zod validation: `monthlyFee` a non-negative number (2 decimal places), `paymentStatus`
    one of the enum values, `expiresAt` an ISO date or `null`, `billingNotes` a string or null.
  - Returns the updated user's billing fields.
- **`POST /admin/users/:id/extend`** — the "+1 Month" action. **Server-computed** to avoid
  timezone drift and keep logic authoritative:
  - If `expiresAt` is `null` OR in the past → new expiry = **today + 1 month**.
  - Else → new expiry = **current `expiresAt` + 1 month**.
  - "+1 month" = add one calendar month (same day-of-month; clamp to end of month when the
    target month is shorter).
  - Returns the updated `expiresAt`.

### User (self-service)

- Fold billing info into the existing **`GET /auth/me`** response so the navbar/account
  page needs no extra call. `me` returns the user's own `expiresAt`, `monthlyFee`,
  `paymentStatus`, and derived `status` — **but NOT `billingNotes`** (admin-private).

## 3. Admin UI

Extend the existing admin user table (`frontend/src/components/admin/UserTable.js`,
used by `frontend/src/app/admin/page.js`):

- New columns / per-row controls:
  - **Expires** — shows current date + derived status (Active / Expired). Editable via a
    date picker.
  - **+1 Month** button — calls `POST /admin/users/:id/extend`, refreshes the row.
  - **Fee** — numeric input (decimals).
  - **Status** — dropdown: Paid / Unpaid / Overdue.
  - **Notes** — freeform text.
  - **Save** — calls `PATCH /admin/users/:id/billing`.
- Follows existing UserTable styling and the `onRefresh` refetch pattern already in place.

## 4. User UI

### `/account` page (all authenticated users)

New route `frontend/src/app/account/page.js`. A single card showing:
- **Status pill** — green "Active" or red "Expired".
- **Expiration date** — e.g. `2026-08-04`, with a friendly relative hint
  ("31 days left" / "expired 3 days ago").
- **Monthly fee** — e.g. `¥30.00 / month` (omit if `monthlyFee` is null).
- **Renewal notice** — if expired, a notice: "Your subscription expired — please contact
  admin to renew."

Data comes from the `me()` store (already loaded on boot), so no extra fetch needed.

### App-wide "expired" banner (soft warning)

A small component driven by `status` from `me()`. When `status === 'expired'`, show a
thin dismissible banner across the app: "Your subscription expired. Please renew."
No access is blocked (soft enforcement per the decision above).

## 5. Navbar restructure + Logout in Settings

`frontend/src/components/layout/Navbar.js`:
- **Desktop nav:** `Playlists · Tools · Guide · Feedback · [Admin] · Account · Settings`.
  Add `Account` (before Settings). **Remove** the Logout `<button>`.
- **Mobile menu:** same — add `Account`, remove Logout.

`frontend/src/app/settings/page.js`:
- Add a **Logout section** at the bottom — a red "Log out" button that calls `logout()`
  (from `useAuth`) and redirects to `/login`. Reuses the logout logic currently in the
  navbar; Settings already imports the auth/token utilities.

### i18n (`LanguageProvider`)

- Add `navAccount` (zh + en). Reuse the existing `navLogout` label for the Settings logout
  button. Add any account-page strings (status/active/expired/relative-time/renewal notice)
  in both languages.

## Scope summary

1. **Migration** — `PaymentStatus` enum + 4 nullable User fields.
2. **Backend** — admin `listUsers` returns billing fields; `PATCH /admin/users/:id/billing`;
   `POST /admin/users/:id/extend`; `me` returns own expiry/fee/status (not notes).
3. **Admin UI** — billing columns + edit controls in the user table.
4. **User UI** — `/account` page + app-wide expired banner (soft warning, no block).
5. **Navbar** — add Account button before Settings; move Logout into Settings.

## Out of scope (YAGNI)

- No payment gateway / online payment — fees are collected manually; admin records status.
- No hard access block on expiry (soft warning only).
- No contact-info field.
- No automated overdue transitions or reminder emails.
