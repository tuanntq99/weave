# Self-hosting Weave on Cloudflare

This guide takes you from an empty Cloudflare account to Weave running at
your own address, with sign-in by one-time code. It takes about 20
minutes, and everything fits in Cloudflare's **free plan**.

**What you will have at the end**

- Weave at `https://notes.<your-subdomain>.workers.dev`
- Sign-in protected by Cloudflare Access: only the emails you allow get in,
  each with a one-time code sent by email (no passwords)
- Your pages synced between all your devices, with nightly backups to your
  own storage

**What you need**

- A Cloudflare account (free): <https://dash.cloudflare.com/sign-up>
- Node.js 24 or later, and git
- About 20 minutes

> [!NOTE]
> Menu names below match Cloudflare's dashboard at the time of writing.
> Cloudflare sometimes moves things around: if a menu has another name,
> search for the setting by name in the dashboard.
>
> Cloudflare may ask for a payment method when you turn on R2 or Zero
> Trust, even on the free plans. Weave stays inside the free allowances
> for personal and small-team use (see [What it costs](#what-it-costs)).

---

## 1. Get the code

```sh
git clone https://github.com/tuanntq99/weave.git
cd weave
npm install
```

## 2. Sign in to Cloudflare from the terminal

```sh
npx wrangler login
```

A browser window opens. Allow access, then come back to the terminal.

## 3. Pick your workers.dev subdomain

In the Cloudflare dashboard, open **Workers & Pages**. On a new account
you are asked to choose a subdomain, for example `maya`. Your apps are then
served at `*.maya.workers.dev`.

The Worker is called `notes` (see `name` in `server/wrangler.jsonc`), so
Weave will live at `https://notes.<your-subdomain>.workers.dev`. To use
another name, change `name` there before you deploy.

## 4. Create the storage bucket

In the dashboard, open **R2 Object Storage** and turn it on. Then:

```sh
npx wrangler r2 bucket create notes-files
```

Weave stores pictures, files and the nightly backups here.

## 5. Deploy for the first time

```sh
npm run deploy
```

This builds the app and publishes it. The address is printed at the end:
`https://notes.<your-subdomain>.workers.dev`.

> [!IMPORTANT]
> Don't open it yet. Nobody can sign in until Access is set up in the next
> steps. Until then the server answers every request with 401, which is
> what should happen.

## 6. Create your Zero Trust team

In the dashboard, open **Zero Trust**. The first time, you are asked to:

1. Choose a **team name**, for example `maya-notes`. It becomes your sign-in
   domain, `maya-notes.cloudflareaccess.com`. **Note it down.**
2. Choose the **Free** plan (up to 50 people).

You can find the team name again later under **Zero Trust → Settings →
Team domain**: it is the part before `.cloudflareaccess.com`.

## 7. Turn on sign-in by one-time code (One-time PIN)

This lets people sign in with just their email address. Cloudflare emails
them a code.

1. Go to **Zero Trust → Settings → Authentication**.
2. Under **Login methods**, click **Add new** and choose **One-time PIN**.
3. Save.

> [!TIP]
> If One-time PIN is not in the list of login methods, the sign-in page
> shows no field for your email.

## 8. Put Access in front of Weave

1. Go to **Workers & Pages → notes → Settings → Domains & Routes**.
2. On the `workers.dev` row, turn on **Cloudflare Access**.

Cloudflare creates an Access application for the Worker, usually named
**"notes - Cloudflare Workers"**. From now on every visit goes through
the sign-in page first.

<details>
<summary>Prefer to create the application by hand?</summary>
<br>

**Zero Trust → Access → Applications → Add an application → Self-hosted.**
Give it a name. Under the domain, enter the whole hostname
`notes.<your-subdomain>.workers.dev` with no path. Save. Then continue with
step 9.

</details>

## 9. Allow your email

1. Go to **Zero Trust → Access → Applications**, open the Weave application,
   and go to **Policies**.
2. Add a policy (or edit the existing one):
   - **Policy name:** `Allow me`
   - **Action:** `Allow`
   - **Include → Selector:** **`Emails`**, and **Value:** your email
     address, for example `maya@example.com`
3. Under **Login methods** (or **Authentication**) for the application,
   allow **One-time PIN**, or keep *Accept all available identity
   providers*.
4. Save.

> [!WARNING]
> Pick the selector **`Emails`**, not `Emails ending in`. *Emails ending
> in* expects a domain such as `example.com`. With a full address in it,
> nobody matches, and no code is ever sent.

To let more people in later, add their addresses to the same **Emails**
rule.

## 10. Copy the application's AUD tag

Open the application in **Zero Trust → Access → Applications**. On its
overview (or **Basic information**) page, copy the **Application Audience
(AUD) Tag**, a long string of hex digits.

## 11. Give the server its settings

The server checks every request against your Access team and application.
Store the values as **secrets**: they live on Cloudflare, never in the
repository.

```sh
npx wrangler secret put ACCESS_TEAM -c server/wrangler.jsonc
# paste only the team name, e.g.  maya-notes   (not the full domain)

npx wrangler secret put ACCESS_AUD -c server/wrangler.jsonc
# paste the AUD tag from step 10

npx wrangler secret put OWNER_EMAIL -c server/wrangler.jsonc
# your email: the person who may restore backups
```

Each secret takes effect at once. You don't need to deploy again.

## 12. Sign in

1. Open `https://notes.<your-subdomain>.workers.dev`.
2. On the Cloudflare Access page, enter your email and choose **Send me a
   code**.
3. Check your inbox for a mail from Cloudflare Access with a 6-digit code,
   and enter it.
4. Weave opens. 🎉

To check that everything is wired up, open
`https://notes.<your-subdomain>.workers.dev/api/me`. It should show a short
JSON with your id and handle (the part of your email before the `@`).

---

## Using Weave every day

- **On your phone:** open the same address, sign in the same way, then use
  *Add to Home Screen* (iOS) or *Install app* (Android/Chrome).
- **How long a sign-in lasts:** 24 hours by default. Change it in the
  application's settings in Zero Trust (**Session Duration**), for example
  to 1 month.
- **Bringing pages from local mode:** in local mode use *Data → Export*,
  then *Data → Import* in your deployed Weave.

## Updating to a new version

```sh
git pull
npm install
npm run deploy
```

Your secrets, data and Access settings are kept.

## Adding more people

1. Add their emails to the **Emails** rule of your application's policy
   (step 9).
2. Each of them signs in once.
3. To work in shared spaces, turn sharing on:
   `npx wrangler secret put SHARING -c server/wrangler.jsonc` and enter
   `on`. See [Sharing](../README.md#-sharing).

## Troubleshooting

| What you see | What to check |
|---|---|
| **The code email never arrives** | Look in spam or promotions. Check that the policy uses the selector **Emails** with your exact address (step 9) and that One-time PIN is on (step 7) and allowed for the application. Ask for a code once, then wait a minute or two: asking many times in a row can be rate-limited. |
| **"That account does not have access"** | You signed in with an identity the policy doesn't allow (for example the *Cloudflare* button with another account). Use the email field (One-time PIN) with an address listed in the policy. |
| **The sign-in page shows another team's name** | The application belongs to an older Zero Trust team. Check **Settings → Team domain** and recreate the application under the right team. |
| **Weave says it can't open, or `/api/me` answers 401** | The secrets are missing or wrong. `ACCESS_TEAM` is only the team name and `ACCESS_AUD` must be the AUD of *this* application. List them with `npx wrangler secret list -c server/wrangler.jsonc` and set them again. |
| **`/api/...` answers 403 `cross_site`** | The request came from another site's page. Open Weave from its own address. |
| **Deploy fails: bucket not found** | Create the bucket (step 4). Its name must match `bucket_name` in `server/wrangler.jsonc`. |
| **Deploy fails: no workers.dev subdomain** | Pick a subdomain first (step 3). |
| **Saved on one device, not showing on another** | Both must be signed in with the same email. The save indicator in the top bar shows *Saving* or *Offline* while changes wait to be sent. |

## What it costs

Free-plan allowances that matter for Weave, and roughly what a few people
writing every day use:

| Resource | Free allowance | Typical use |
|---|---|---|
| Workers requests | 100,000 / day | well under 1% |
| Durable Object rows written | 100,000 / day | about 5–10% |
| Durable Object storage | 5 GB | a few MB per person |
| R2 storage | 10 GB / month | pictures, resized before upload, and backups |
| Zero Trust Access | 50 people | one seat per person |

## Optional: deploy from GitHub Actions

Add the repository secrets `CLOUDFLARE_API_TOKEN` (permissions: Workers
Scripts and Workers R2 Storage, edit) and `CLOUDFLARE_ACCOUNT_ID`. The
workflow in `.github/workflows/deploy.yml` then builds, tests and deploys
whenever a version tag (`v1.2.3`) is pushed. The Access secrets from step
11 stay on Cloudflare and don't need to be in GitHub.
