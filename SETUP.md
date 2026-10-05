# Setup (phone friendly)

Do these steps in the Cloudflare dashboard. For how the code is organised, see [`README.md`](README.md).

## 1. Set the deploy command
1. Dashboard > **Workers & Pages** > **clubsdeucemugger** > **Settings** > **Builds**.
2. Leave **Build command** empty.
3. Set **Deploy command** to exactly:

```
npx wrangler d1 migrations apply deucemugger --remote && npx wrangler deploy
```

This builds the database tables from the `migrations/` folder, then deploys. Migrations that already ran are
skipped, so it is safe on every deploy.

4. Save, then **Retry deployment** (or push a commit).

## 2. Add the custom domain
1. Open the Worker > **Settings** > **Domains & Routes** > **Add** > **Custom domain**.
2. Enter `clubsdeuce.com` and confirm. Cloudflare makes the DNS record and certificate.
3. The domain must be on your Cloudflare account (Websites).

## 3. Turn on email sending
1. Dashboard > **Email** > **Email Sending**. Add `clubsdeuce.com` and add the DNS records it lists, so
   `noreply@clubsdeuce.com` can send.
2. The `EMAIL` binding is already in `wrangler.jsonc`.
3. Emails sent by the site: a welcome note, a heads-up to the inviter when someone joins, password recovery
   links, and notices when an email address changes. Check spam the first time.

## 4. Check the bindings
Worker > **Settings** > **Bindings** should show `DB` (D1: deucemugger), `EMAIL` and `ASSETS`. There are no secrets to add.

## 5. Try it
1. Open `https://clubsdeuce.com` and sign in as `TheFedsAreStalkingMe`.
2. **Settings** > save your email, then **Invite someone** to make a link.
3. The new person opens the link, picks a username, email and password, then types the username of the member
   who invited them. If it matches, they are in.
4. In **Settings**, tap **Make my Torn key**, paste the key and save it. Tick **Keep it on my account** (it asks for your password) to use it on other devices. Add your own battle stats under Jackpot alerts, then go back and hunt.

## How accounts work
- Signup is invite only. Members can have one open invite at a time. The owner has no limit.
- `TheFedsAreStalkingMe` is the owner and is the only account that sees the **Owner panel** on the Mug Finder.
  It lists every account with its email and who invited it, and can remove accounts.
- Password hashing is PBKDF2-SHA256 at 100,000 iterations, the most Cloudflare Workers allows.
- Limits per IP: 10 sign-in tries per 10 minutes, 5 sign-ups per hour. Torn calls stay under 80 per minute in the
  browser, with a server limit of 84.
- Invite links last 7 days. An application that is never finished is deleted after 7 days.
- A key kept on the account is locked with the member's password. The server can read it only while they are signed in, and a password reset clears it (they save it again).
