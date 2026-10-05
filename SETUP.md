# Setup (phone friendly)

The code is done. Do these steps in the Cloudflare dashboard.

## 1. Change the deploy command
1. Dashboard > **Workers & Pages** > **clubsdeucemugger** > **Settings** > **Builds**.
2. Leave **Build command** empty.
3. Set **Deploy command** to exactly:

```
npx wrangler d1 migrations apply deucemugger --remote && npx wrangler deploy
```

This creates the database tables (from `migrations/`), then deploys. Already-applied migrations are skipped, so it is safe on every deploy.

4. Save, then **Retry deployment** (or push a commit).

## 2. Add the custom domain
1. Open the Worker > **Settings** > **Domains & Routes** > **Add** > **Custom domain**.
2. Enter `clubsdeuce.com` and confirm. Cloudflare makes the DNS record and certificate.
3. The domain must be on your Cloudflare account (Websites).

## 3. Email sending
1. Dashboard > **Email** > **Email Sending**. Onboard `clubsdeuce.com` and add the DNS records it asks for, so `noreply@clubsdeuce.com` can send.
2. The `EMAIL` binding is already in `wrangler.jsonc`.
3. Approval emails go to `lobsterlover7170@gmail.com`. Check spam the first time.

## 4. Check bindings
Worker > **Settings** > **Bindings** should show `DB` (D1: deucemugger), `EMAIL`, and `ASSETS`.

## 5. Try it
1. Open `https://clubsdeuce.com` and fill in **Apply for an account**.
2. Open the email, tap **Approve**, then tap the confirm button on the page that opens. (The extra tap stops email scanners from approving or denying by accident.)
3. Sign in, open **Settings**, paste your Torn API key and FF Scouter key (stored only in that browser), add item IDs, and scan.

## Notes
- Approve/Deny links work once and expire after 7 days. Unapproved applications are cleaned up after 7 days.
- Password hashing is PBKDF2-SHA256 at 100,000 iterations, the maximum Cloudflare Workers allows.
- Limits: 10 login tries per 10 minutes and 5 applications per hour per IP.
- Torn calls are capped at 80 per minute in the browser, with a server backstop at 84.

## Invites and the owner account
- Signup is invite only. Members make a link in **Settings > Invite someone** and send it to the person.
- Before making invites, each member saves their email in **Settings > Your email**. The applicant types that email as their sponsor, and the Approve/Deny links go there. You get a copy at `lobsterlover7170@gmail.com`.
- `TheFedsAreStalkingMe` is the owner. It has an **Owner panel** on the Mug Finder to approve, deny or remove accounts, and its invites only need your email on file (it falls back to `lobsterlover7170@gmail.com`).
- The new database migration (`0002_invites.sql`) runs by itself through the deploy command.

