# Deployed sign-in and storage: owner checklist (#27)

What CI and a local build already prove is in the `mail-off` and `backup-drill` suites of `npm run verify:product` (see the README). The steps below need the host's settings, the live site or the private disk, so only the deploy owner can do them. Do them on Preview first, then Publish. Record only pass/fail, counts and hashes, never row contents, tokens or addresses.

Before you start: `https://getticketstub.com/api/health` should answer `{"ok":true,...,"storage":"ok","persistence":"configured"}`. On 2026-10-12 it did, with `"mode":"live"`. Its `commit` field is the running build's SHA; confirm it matches the commit you deployed.

## 1. No sandbox sign-in links (tracker item c)

- [ ] In the host's environment settings, for **Preview** and for **Publish**, `TICKETSTUB_SANDBOX_MAIL` is not set at all. Only the exact value `1` turns it on, but delete it rather than setting it to `0`.
- [ ] Redeploy, so the running process has the new environment.
- [ ] Until Resend is set up (no `RESEND_API_KEY`): on the live site, open sign-in and enter your own address. The sign-in sheet should say "Email isn't switched on for this preview, so we can't send a link. Come back soon." and show **no** "Open the link" button. In the browser's network panel, `POST /api/auth/link` answers 503 with code `mail_unavailable` and the API message "Email isn't set up on this server yet." (the page shows the first text, not this one), and its body has no `devLink`.
- [ ] In the host's logs, search for `signin/confirm?token=`, `sandbox sign-in link` and `sandbox email-change link`. There should be no match. The expected line is `[mail] no RESEND_API_KEY, not sent: sign-in link to y***@domain`.

## 2. Real-email sign-in, once Resend is set up (items a and c)

- [ ] Set `RESEND_API_KEY` (and `MAIL_FROM` if not `hello@getticketstub.com`) for Preview and Publish, with the sending domain's DNS records verified in Resend. `TICKETSTUB_SANDBOX_MAIL` stays unset.
- [ ] Sign in with an address you own. The response has no `devLink`, and the email arrives.
- [ ] Open the email link. The page says "One tap and you're in" and you are **not** signed in yet. Refresh it: still valid (a mail scanner fetching it burns nothing).
- [ ] Tap the stamp. You land signed in. In the browser's cookie view, `ts_session` is HttpOnly, Secure, SameSite=Lax, and expires in about 90 days.
- [ ] Open the same email link again: it reads as expired (single use).
- [ ] Request a new link, wait more than 15 minutes, open it: expired.
- [ ] Sign out, and confirm `/api/auth/me` shows no account.

## 3. Storage survives a restart and a redeploy (item b)

- [ ] Signed in, save one stub with generated or uploaded art to your wall and make the wall public. Note the public wall URL.
- [ ] Take a backup (step 4) and note its `database.tables` counts.
- [ ] Restart the app from the host panel. Open the public wall URL: the stub and its art are there, and you are still signed in.
- [ ] Redeploy (Publish) the same commit. Check the public wall and your session again.
- [ ] Take a second backup. Every count is at least the first backup's, and the first backup's art hashes are still in the second backup's `files`.

## 4. Take a backup and download it (item b)

- [ ] Sign in with an address listed in `ADMIN_EMAILS`. From a page on the same site, run in the browser console:
  `fetch("/api/admin/backup", { method: "POST" }).then((r) => r.json())`
- [ ] The answer is 201 with `backup.ok: true`, `database.integrity: "ok"`, `missing: []`, and `downloadable: true`. A 409 means another backup (the weekly one, or the other environment) is running: try again in a minute.
- [ ] Signed out, the same call is a 404.
- [ ] In File Manager, Private Storage, download `/private/backups/<id>/`: `manifest.json`, `ticketstub.sqlite` and every file under `files/`. Keep it off GitHub and out of shared folders: it holds customer data.
- [ ] After about a week, the host log shows `[backup] scheduled <id> ok, <n> files`, and `GET /api/admin/backup` lists it.

## 5. Restore drill on a copy (item b)

On your own machine, never on the host and never over the live folder:

- [ ] `node scripts/restore-backup.mjs <downloaded backup folder> <new empty folder>` ends with "N checks passed": the hashes match the manifest, `integrity_check` is ok, and the row counts match.
- [ ] Start the printed isolated command (demo mode, no mail or provider keys, port 3999). `http://localhost:3999/api/health` shows `storage: ok`, and your public wall URL path, opened on `localhost:3999`, shows the stub and its art.
- [ ] Stop it and delete the restored folder and the download. Prune `/private/backups` only after a restore like this has passed.

## Reporting back on #27

Post one comment with the date, the commit, and for each section above pass or fail, the backup id, and its table counts and database SHA-256. No tokens, addresses or row contents.
