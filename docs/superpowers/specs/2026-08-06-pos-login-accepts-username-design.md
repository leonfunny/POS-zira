# Desktop POS login must accept a username, not only an email

Date: 2026-08-06
Status: implemented

## Problem

The owner of salon 8918 (Supermarket Bao Han) signs in on the web with the
username `baohan`, but the desktop POS refused it with the Chromium message
*"Please include an '@' in the email address."*

The account is real and the credential is correct. Confirmed against production:

```
POST https://zira-ai.com/api/v1/auth/login  {"emailOrPhone":"baohan", ...}
→ 200, user {email:"baohan", phone:null, role:"OWNER", salon_code:"8918"}
```

Nothing was wrong on the server. `LoginDto` carries only `@IsString()` and
`@IsNotEmpty()` — no `@IsEmail()` — and `findByEmailOrPhone()` matches the
`users.email` column exactly, which literally holds `"baohan"`.

The block was entirely client-side. `AuthScreen.tsx` rendered the field as
`<input type="email">`, so Chromium failed constraint validation and never
submitted the form: **the request never left the machine.** The POS already
sent the correct payload (`{ emailOrPhone, password }`); it just never got to.

The desktop POS was also the odd one out. The web login has always used
`type="text"` with `autoComplete="username"` and an "email or phone" label.

## Decision

Fix the client rather than give the account an email address. Salons are
provisioned through the register API with plain usernames, so changing this one
credential would leave the next salon to hit the same wall. This restores parity
with the web, which the backend was designed for all along.

## Change

`src/renderer/components/AuthScreen.tsx`

- `type="email"` → `type="text"`, plus `inputMode="email"` so the on-screen
  keyboard still offers `@`, and `autoCapitalize="none"` / `autoCorrect="off"` /
  `spellCheck={false}` so a username is not mangled on entry.
- `autoComplete="email"` → `autoComplete="username"`, matching the web.
- Label and placeholder keys renamed to `auth.identifier.*`.

Internal identifiers (`email`, `setEmail`, `id="auth-email"`) were left alone —
renaming them would enlarge the diff without changing behaviour.

`src/renderer/i18n/auth-translations.ts`

- `auth.email.label` / `auth.email.placeholder` renamed to `auth.identifier.*`
  across all seven locales (en, vi, pl, ru, uk, zh, tr). This is a rename, not
  an addition: no other module referenced the old keys.
- The label now names all three accepted forms; the placeholder shows one
  example of each.

## Test

`tests/auth-login-identifier.test.tsx` (vitest + happy-dom, following the
existing renderer test pattern) asserts that the field is `type="text"` with
`autoComplete="username"`, that `checkValidity()` accepts `baohan`, and that
`requestSubmit()` reaches `loginWithEmail('baohan', ...)`.

Both cases were mutation-tested: reintroducing `type="email"` turns both red.
The first draft submitted via `dispatchEvent(new Event('submit'))`, which stayed
green against the mutant — dispatching a bare submit event skips constraint
validation. `requestSubmit()` plus an explicit `checkValidity()` assertion is
what makes the test reproduce the real failure.

## Out of scope

- **Android POS.** `src/renderer/android-pos/LoginScreen.tsx:57` has the same
  `type="email"` field and the same bug. Untouched by owner's decision.
- **The account has no usable email.** `baohan` has `email="baohan"` and
  `phone=null`, so password reset and any notification mail to this account will
  fail. Login is unaffected; this needs handling on its own.
