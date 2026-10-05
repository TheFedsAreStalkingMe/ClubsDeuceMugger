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
2. Follow the invite steps below instead. Applications no longer send approval emails.
3. Sign in, open **Settings**, paste your Torn API key and FF Scouter key (stored only in that browser), add item IDs, and scan.

## Notes
- Approve/Deny links work once and expire after 7 days. Unapproved applications are cleaned up after 7 days.
- Password hashing is PBKDF2-SHA256 at 100,000 iterations, the maximum Cloudflare Workers allows.
- Limits: 10 login tries per 10 minutes and 5 applications per hour per IP.
- Torn calls are capped at 80 per minute in the browser, with a server backstop at 84.

## Invites, emails and the owner account
- Signup is invite only. A member makes a link in **Settings > Invite someone** and sends it to the person.
- The new person picks a username, email and password, then types the username of the member who invited them. If it matches, they are let in right away. There are no approval emails any more.
- Emails go out for: a welcome message, a heads-up to the inviter, password recovery (**Forgot your password?** on the sign-in page), and a notice whenever an email address changes. All of these need Email Sending set up for `clubsdeuce.com` (step 3).
- `TheFedsAreStalkingMe` is the owner and is the only account that sees the **Owner panel** on the Mug Finder. It lists every account with its email and who invited it, and can remove accounts.
- Save your own email in **Settings > Your email** so you can recover your password.
- The new migrations (`0002` and `0003`) run by themselves through the deploy command.

## Saving API keys to accounts (one more step)
The **Save my key to my account** checkbox in Settings needs a secret so keys are stored encrypted:
1. Worker > **Settings** > **Variables and Secrets** > **Add**.
2. Type: **Secret**. Name: `KEY_SECRET`. Value: a long random string of at least 32 characters (use a password manager to make one, and keep a copy somewhere safe).
3. Save and deploy. Until this is set, the checkbox is greyed out.
4. Never change or lose this value. If it changes, saved keys can no longer be read and members need to save theirs again.

