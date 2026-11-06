# Deploying MeritDesk.AI

Production-oriented companion: `DEPLOYMENT.md` (health checks, quotas, operator console, backups). This file is the original step-by-step runbook.

Start here. This is the whole path from this code to a running app that
Claude and ChatGPT can connect to, in order. Each step links to the detailed
section of README.md or docs/ when you need more.

How the pieces fit:

- **GitHub** stores the code, checks every change (typecheck, lint, build),
  and deploys with one button. It does not run the app.
- **Fly.io** runs the app: two machines, the web app (pages and the
  connector at `/api/mcp`) and the worker (skill runs, uploads, the library,
  the billing emails).
- **Neon** (database), **Clerk** (sign-in and firms), **AWS S3** (files),
  **AWS SES** (emails), **Stripe** (payments) and **Anthropic** (the model)
  are services the app uses.
- **Claude and ChatGPT** connect to the web app's `/api/mcp` address.
- **Firms** sign up on the website themselves: the first 30 days are free,
  then $20 per user per month, paid on the website through Stripe.

Use synthetic (fake) client data until the first deploy checklist is done
(README section 5). Nothing here has run against the real services yet.

---

## Step 1. Put the code on GitHub (private repository)

1. Create a **private** repository on github.com (New repository, Private,
   no README or .gitignore, they already exist here).
2. Push this project to it. With GitHub Desktop: File > Add local
   repository > `C:\Users\andre\immigration-saas`, then Publish repository,
   and keep "Keep this code private" ticked. Or from a terminal:
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
   Push named branches only, never `--all`, so a local scratch or backup
   branch never reaches GitHub by accident. GitHub Desktop's Publish also
   pushes only the current branch.
3. In the repository's Settings > Branches, make the main branch protected
   (require the CI check to pass) once the first push is in.

The repository must stay private: it holds the firm's skill texts and
house formats. No secrets are in the code or its history (checked before
the first push); real keys only ever go into Fly and GitHub secrets.

## Step 2. Create the service accounts

Details: README section 1.

| Service | What to create | You will need |
|---|---|---|
| Neon | A project, then the runtime database role (README "Database roles") | Pooled and direct connection strings for the runtime role, and the owner's connection string |
| Clerk | An application with Organizations on; keep its two default roles (Admin, Member) and create no custom role (README "Clerk") | Publishable key, secret key (webhook secret comes in step 8) |
| AWS | An S3 bucket with versioning and default encryption, CORS for the web app's address, and an IAM user limited to that bucket (SES comes in step 10) | Region, access key id, secret key, bucket name |
| Anthropic | An API key at console.anthropic.com; apply for Zero Data Retention before real client data | API key |
| Stripe | An account at stripe.com (step 9 sets it up; test mode needs no activation) | Secret key (`sk_test_` first) |
| Fly.io | An account; install `flyctl` (already on this computer) and run `fly auth login` | |

Free library keys (docs/LIBRARY_SOURCES.md section 2): api.data.gov,
Congress.gov, and CourtListener (a nonprofit third party: decide first).

## Step 3. Create the two Fly apps

```bash
fly apps create <web-app-name>
fly apps create <worker-app-name>
```

Fly app names are global, so pick something unique. Put them into the
`app = "..."` line of `fly.toml` (web) and `fly.worker.toml` (worker),
replacing `REPLACE-WITH-...`, and commit.

## Step 4. Connect GitHub to Fly (for the Deploy button)

1. Create one deploy token that covers both apps:
   `fly tokens create org -x 8760h` (valid one year; create a new one when
   it expires). It can deploy every app in your Fly organization, so keep it
   only in GitHub's secrets.
2. In the GitHub repository: Settings > Secrets and variables > Actions.
   - **Secret** `FLY_API_TOKEN`: the token from step 1.
   - **Variable** `FLY_WEB_APP`: the web app name.
   - **Variable** `FLY_WORKER_APP`: the worker app name.
   - **Variable** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: Clerk's publishable
     key (it is public by design; the secret key never goes to GitHub).

## Step 5. Clerk settings for the Claude and ChatGPT connector

Details: docs/CONNECTORS.md section 3. In Clerk, OAuth applications:

1. Scopes tab: create the scope `practice:connector`.
2. Settings: turn on **Publish CIMD support**. Turn on **Publish DCR
   support** only for the first test connections (step 12), then off.
3. Default scopes for dynamic clients:
   `openid profile email user:org:read practice:connector`.
4. Keep Require PKCE on, the consent screen on, and JWT access tokens.

## Step 6. Set the app's secrets on Fly

Secrets live on Fly only. Details: README section 4, step 4.

Both apps:
```bash
fly secrets set -a <web-app-name>    DATABASE_URL=... QUEUE_DATABASE_URL=... ANTHROPIC_API_KEY=... AWS_REGION=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... S3_DOCUMENTS_BUCKET=... CLERK_SECRET_KEY=... CONNECTOR_PUBLIC_ORIGIN=https://<web-app-name>.fly.dev
fly secrets set -a <worker-app-name> DATABASE_URL=... QUEUE_DATABASE_URL=... ANTHROPIC_API_KEY=... AWS_REGION=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... S3_DOCUMENTS_BUCKET=... CLERK_SECRET_KEY=... CONNECTOR_PUBLIC_ORIGIN=https://<web-app-name>.fly.dev
```
The worker needs `CLERK_SECRET_KEY` and `CONNECTOR_PUBLIC_ORIGIN` for the
billing emails (the recipients come from Clerk; the links use the origin).

Worker only (migrations and the library):
```bash
fly secrets set -a <worker-app-name> MIGRATION_DATABASE_URL=... API_DATA_GOV_KEY=... CONGRESS_GOV_API_KEY=...
```
Add `COURTLISTENER_API_TOKEN=...` only if you decided to use CourtListener.

Web app only:
```bash
fly secrets set -a <web-app-name> CLERK_WEBHOOK_SECRET=placeholder-until-step-8 LIBRARY_IMPORT_ADMINS=<your Clerk user id>
```

Billing (step 9) adds `STRIPE_SECRET_KEY` to both apps and `STRIPE_PRICE_ID`
and `STRIPE_WEBHOOK_SECRET` to the web app; emails (step 10) add
`SES_FROM_ADDRESS` to the worker. Until then the Billing page says billing
is not configured and the worker logs each email it skips; everything else
works, and every firm's free month counts from its creation.

The full list of settings, with what each does, is in `.env.example`.

## Step 7. Deploy

On GitHub: Actions > **Deploy to Fly.io** > Run workflow. It deploys the
worker first (which runs the database migrations), then the web app.

Or from this computer:
```bash
fly deploy -c fly.worker.toml
fly scale count 1 -a <worker-app-name>
fly deploy -c fly.toml --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<publishable key>
```

Check the worker's deploy log for "Running release command" with the
migrations and the seeded skills.

## Step 8. Finish Clerk and sign in

1. In Clerk, add the webhook endpoint
   `https://<web-app-name>.fly.dev/api/webhooks/clerk`, subscribed to
   `organization.*` and `organizationMembership.*`.
2. Copy its signing secret:
   `fly secrets set -a <web-app-name> CLERK_WEBHOOK_SECRET=<real value>`.
3. In Clerk, Configure > Organizations: turn **Allow user-created
   organizations** off (or, if you leave it on, set the organization limit
   to a custom limit of 1 per user). The app creates each firm itself from
   its Create firm form, which refuses a second firm for a person who
   already belongs to one, limits a user to 3 attempts a day, and gives the
   free month once per person (README "Trial, billing and emails"); with
   the switch on, Clerk's own components would let a user create
   organizations without those checks and start a new free month each
   time. On the Roles & Permissions page, leave the two default roles as
   they are: Admin (`org:admin`, the app's owner/admin and the creator
   role) and Member (`org:member`, whose app role is set on the Firm
   page); create no custom role (README "Clerk"). Only Admin has Delete
   organization: when an owner does delete the organization in Clerk, the
   app marks the firm deleted, cancels its Stripe subscription at once with
   proration and makes the firm unreachable, and only the operator can
   bring it back, by hand. Do not add `org:sys_profile:delete` to the
   Member role.
4. Open the app and sign up. The app asks for the firm's name, creates the
   firm (you become its owner), starts its free month and lands you on the
   Connect page. Firms created in the Clerk dashboard instead get their
   free month from the webhook.

## Step 9. Billing with Stripe

Details: README "Trial, billing and emails". Do it all in **test mode**
first (the dashboard's Test mode switch; keys start with `sk_test_`), then
again in live mode when the firm is ready to charge real cards: live mode
has its own keys, its own Product and Price, and its own webhook endpoint.

1. **Keys.** Stripe dashboard > Developers > API keys: copy the secret key.
   Put it in `.env.local` as `STRIPE_SECRET_KEY` for the next step, and on
   both Fly apps:
   ```bash
   fly secrets set -a <web-app-name>    STRIPE_SECRET_KEY=sk_test_...
   fly secrets set -a <worker-app-name> STRIPE_SECRET_KEY=sk_test_...
   ```
2. **The Product and Price.** From this computer, with `STRIPE_SECRET_KEY`
   in `.env.local`:
   ```bash
   npm run stripe:setup
   ```
   It creates the Product "MeritDesk.AI" and its $20 per-user monthly Price
   (or finds them, by lookup key, if they exist) and prints
   `STRIPE_PRICE_ID=price_...`. Set it on the web app:
   ```bash
   fly secrets set -a <web-app-name> STRIPE_PRICE_ID=price_...
   ```
3. **The webhook.** Dashboard > Developers > Webhooks (Workbench) > Create
   an event destination: your account, **snapshot** payloads at the latest
   API version, the events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid` and
   `invoice.payment_failed`, destination type Webhook endpoint, URL
   `https://<web-app-name>.fly.dev/api/webhooks/stripe` (your own domain
   once you have it; the Cloudflare rule below already lets `/api/` through).
   Reveal the signing secret and set it:
   ```bash
   fly secrets set -a <web-app-name> STRIPE_WEBHOOK_SECRET=whsec_...
   ```
   The dashboard's Event deliveries tab shows each delivery and the app's
   answer (200 applied, 200 "Already processed" for a redelivery, 400 for a
   bad signature, 500 when it could not be applied, which Stripe retries).
   The app does not read the event's payload beyond the ids in it: it
   retrieves the subscription and invoice from Stripe with
   `STRIPE_SECRET_KEY` and applies that, so the web app needs the secret
   key as well as the webhook secret.
4. **The Customer Portal.** Nothing to set up in the dashboard: the app
   creates its own portal configuration the first time Manage billing is
   used in each mode (`src/lib/billing/portal.ts`, found again by its
   metadata and brought back to the app's settings on every start) and
   opens every portal session with it. It lets customers update the card,
   see invoices, change the billing email and address, and cancel at the
   end of the period; quantities, plans and pausing are off (the app sets
   seats from the firm's members). Edits made to that configuration in
   the dashboard (Settings > Billing > Customer portal) do not stick.
5. **Stripe's own emails.** Dashboard > Settings > Business > Customer
   emails: keep **Successful payments** off (the app sends its own receipt
   with Stripe's invoice link, so firms would get two) and keep
   **Failed payments** off too, or on if you want Stripe's reminder as well
   as the app's. Under Subscriptions and emails, leave Stripe's upcoming
   renewal emails off for the same reason.
6. **Try it** with a test firm and the test card `4242 4242 4242 4242`:
   Subscribe on the Billing page, pay, and watch the webhook deliveries and
   the Billing page (README section 5, "Billing and emails").
7. **Go live:** repeat steps 1 to 5 in live mode (new keys, run
   `npm run stripe:setup` again with the live key for a live Price, a new
   webhook endpoint with its own secret), set the live values on Fly, and
   complete Stripe's account activation (business details, bank account).

## Step 10. Emails with SES

The app emails each firm's owners from the worker through Amazon SES: the
welcome, reminders before and when the free month ends, subscription
confirmations, receipts, failed payments and renewals. It uses the AWS
keys the apps already have.

1. **Permissions.** Give the IAM user from step 2 `ses:SendEmail` (SES v2)
   in the region the app uses, or create a separate user for SES and set
   its keys on the worker only.
2. **The domain.** SES console (the same region as `AWS_REGION`) >
   Configuration > Identities > Create identity > Domain, your domain (for
   example `meritdesk.ai`, not `www.`), Easy DKIM with the 2048-bit key. SES
   shows three CNAME records (`<token>._domainkey.<domain>` pointing at
   `<token>.dkim.<region>.amazonses.com`). In Cloudflare > DNS > Records,
   add all three as CNAME with the proxy **off** (DNS only), names exactly
   as SES shows them, underscore included. The identity shows Verified once
   SES sees the records (minutes to a few hours; up to 72 hours).
   Optional but good for deliverability: a custom MAIL FROM subdomain
   (`mail.<domain>`, an MX and a TXT record, also DNS only) and a DMARC
   record (`_dmarc.<domain>`, `v=DMARC1; p=none; rua=mailto:<you>`).
3. **Production access.** New SES accounts are in the sandbox: they can
   only send to verified addresses, 200 a day. SES console > Account
   dashboard > Request production access: Transactional, the app's URL, a
   contact address, a sentence saying the app sends account emails
   (welcome, billing reminders and receipts) to the law firms that sign up,
   that recipients are the firms' own administrators, and that bounces and
   complaints are watched. AWS answers within a few days. Until then, add
   your own address as a verified identity to test with.
4. **The sender.** On the worker:
   ```bash
   fly secrets set -a <worker-app-name> SES_FROM_ADDRESS="MeritDesk.AI <no-reply@<domain>>"
   ```
   The worker's log then shows `[email] sent welcome ...` lines; without
   the secret it logs `not sent: SES_FROM_ADDRESS is not set` and moves on.

## Step 11. Set up the firm in the app

1. **Connect** page: the connector address and the steps for Claude and
   ChatGPT (also linked from the welcome email and the Firm page).
2. **Firm** page: letterhead, attorneys (bar and EOIR numbers), signatures,
   and the connector's case-work switch.
3. **Practice profile**: fill it in and confirm it.
4. Invite staff from the firm menu at the top (Manage organization,
   Members) as Members, or as Admins for other owners; then set each
   member's role (attorney, paralegal or read-only) in the Members section
   of the Firm page. A new member is read-only until then. Each member is
   one seat once the firm subscribes.
5. Run the first deploy checklists with fake data: README section 5 (app,
   including "Billing and emails") and section 6 (library).

## Step 12. Connect Claude and ChatGPT

Details: docs/CONNECTORS.md sections 2 and 3.

1. On the **Connect** page, the owner copies the connector address
   (`https://<web-app-name>.fly.dev/api/mcp`); on the **Firm** page they
   read the notice and turn on case work if the firm wants it.
2. **Claude:** Settings > Connectors > Add custom connector (Team and
   Enterprise owners: Organization settings > Connectors > Add > Custom).
   Paste the address, sign in, choose the firm, allow.
3. **ChatGPT:** Plugins > + > Add custom MCP server. Paste the address,
   choose OAuth, sign in, choose the firm, allow. (A workspace admin may need
   to allow custom servers first.)
4. The first time, only the library tools appear. That is expected: the
   Firm page now lists the app ids it saw under "Unrecognized clients".
   Put the Claude and ChatGPT ids into the allow list and restart:
   ```bash
   fly secrets set -a <web-app-name> CONNECTOR_ALLOWED_CLIENT_IDS=<claude id>,<chatgpt id>
   ```
5. Reconnect: the case tools now appear. Then turn **DCR off** in Clerk and
   confirm both still connect.

## Step 13. Keep deploying

All of the work is already on `main`, the only branch. From here on:
push a change, let CI pass, press Deploy.

Library upkeep: the 13 manual sources (Visa Bulletin monthly, country
reports yearly, and others) are imported on the Library page, schedule in
docs/LIBRARY_SOURCES.md.

Billing upkeep: nothing daily. The worker's daily job locks firms whose
free month or subscription ended, sends the reminders and keeps seats in
step with Stripe; the Stripe dashboard shows every customer, invoice and
failed payment.

## Your own domain, with Cloudflare in front

The app runs on Fly.io. Cloudflare holds the domain and sits in front of
the web app: DNS, HTTPS, DDoS protection and a firewall. Cloudflare's free
plan is enough for this. Do it before step 8 if you can, so Clerk, Stripe,
SES, the connector and the S3 CORS rule use the final address from the
start.

1. In Cloudflare (Account home, "Add a domain"), add your domain and move
   its nameservers to the two Cloudflare names, at your registrar. Wait
   until Cloudflare shows the domain as active.
2. Choose the app's address, for example `app.<your-domain>`, and ask Fly
   for its certificate:
   ```bash
   fly certs add app.<your-domain> -a <web-app-name>
   ```
   Fly prints the DNS records to create. Create them in Cloudflare under
   DNS > Records: the `app` record pointing at the web app with the proxy
   ON (orange cloud), and the `_acme-challenge` record exactly as printed
   with the proxy OFF (DNS only). Then run
   `fly certs check app.<your-domain> -a <web-app-name>` until the
   certificate shows as issued.
3. Cloudflare > SSL/TLS > Overview: set the encryption mode to
   **Full (strict)**. With any weaker mode the app's HTTPS redirect loops.
4. Let Claude, ChatGPT, Clerk and Stripe through. They call `/api/mcp`,
   `/.well-known/`, `/api/webhooks/clerk` and `/api/webhooks/stripe` from
   servers, not browsers, and a bot challenge breaks them. Cloudflare >
   Security > Security rules: add a custom rule with action **Skip**
   (skipping Bot Fight Mode and the managed challenges) for requests whose
   URI path starts with `/api/` or `/.well-known/`. Leave Bot Fight Mode
   off until that rule exists.
5. Tell the app it is behind Cloudflare, so its rate limits see the real
   client address instead of Cloudflare's:
   ```bash
   fly secrets set -a <web-app-name> TRUST_CF_CONNECTING_IP=true
   ```
   Set this only while every request reaches Fly through Cloudflare.
6. Use the final address everywhere: `CONNECTOR_PUBLIC_ORIGIN=https://app.<your-domain>`
   on both apps, Clerk's webhook endpoint and allowed origins, Stripe's
   webhook endpoint, and the S3 CORS rule. The Connect and Firm pages show
   the connector address from `CONNECTOR_PUBLIC_ORIGIN`, and the emails
   link to it.
7. One limit to know: on the free and Pro plans Cloudflare drops any
   request it has held open for more than 100 seconds (error 524). The app
   queues long work, so pages answer quickly; the exception is the
   Library's manual import, which parses the uploaded file during the
   request. Import one file at a time.

---

## Where everything is

| File | What it covers |
|---|---|
| `DEPLOY.md` | This guide |
| `README.md` | Architecture, each feature (including "Trial, billing and emails"), deployment details, first deploy checklists (sections 4 to 6) |
| `docs/CONNECTORS.md` | The Claude and ChatGPT connector: tools, setup, privacy, directory submission |
| `docs/LIBRARY.md` | How the library and its collectors work |
| `docs/LIBRARY_SOURCES.md` | Every library source: automatic, needs a key, manual, not collected |
| `docs/ADDING_A_SKILL.md` | How to add or change a skill |
| `src/lib/billing/`, `src/lib/email/` | The free month, Stripe, the webhook, seats, the daily job, the emails |
| `.env.example` | Every setting, with comments |
| `fly.toml`, `fly.worker.toml` | The two Fly apps |
| `Dockerfile`, `Dockerfile.worker` | How each app is built |
| `.github/workflows/ci.yml` | Checks every push |
| `.github/workflows/deploy.yml` | The Deploy button |
