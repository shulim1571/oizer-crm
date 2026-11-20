# Sign in with Google: setup steps for Shulim

Moshe asked for this, and Shulim approved it on 2026-11-16. The code is live. The login page shows **Sign in with Google** on its own once Google is turned on in Supabase (step 2). Until then, nothing changes for anyone.

- The Google client ID and secret go **only** in Supabase Auth settings. They are not in the code, the repo or GitHub.
- Text and call codes stay. After Google, anyone who has text or call codes set up, or an authenticator app, is asked for a code, just as after a password. An authenticator app is never required.
- Cost: none. Google sign-in is free in Google Cloud and included in Supabase Auth.

## 1. Google Cloud (about 10 minutes)

1. Go to https://console.cloud.google.com and sign in with the Google account that should own this setup (e.g. the trubase.org admin).
2. At the top, open the project picker and choose **New project**.
   - Name: `Donor Base sign-in`
   - Click **Create**, then select the new project.
3. Go to **APIs & Services → OAuth consent screen**. On newer consoles this is **Google Auth Platform → Branding**. Click **Get started**.
   - App name: `Donor Base`
   - User support email: your email
   - Audience: **External**. This lets fundraisers with any Google or Gmail account sign in. Choose **Internal** only if everyone uses a trubase.org Google Workspace account.
   - Contact email: your email. Agree, then click **Create**.
4. Under **Branding**:
   - Authorized domains: add `trubase.org` and `supabase.co`.
   - Application home page: `https://oizer.trubase.org`
   - Save.
5. Under **Data Access** (scopes), keep only the defaults: `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. Don't add others. With only these, Google doesn't need to review the app.
6. Under **Audience**, click **Publish app** so it's "In production". While it's in "Testing", only test users you list can sign in.
7. Go to **Clients** (or **APIs & Services → Credentials → Create credentials → OAuth client ID**):
   - Application type: **Web application**
   - Name: `Donor Base`
   - **Authorized JavaScript origins:** `https://oizer.trubase.org`
   - **Authorized redirect URIs:** `https://wwaknikpdquwnphhwzsm.supabase.co/auth/v1/callback`
   - Click **Create**.
8. Copy the **Client ID** and the **Client secret** shown. Don't paste them into chat, email or the repo; they go straight into Supabase in step 2.

## 2. Supabase (about 2 minutes)

1. Go to https://supabase.com/dashboard/project/wwaknikpdquwnphhwzsm/auth/providers
2. Open **Google** and turn on **Enable Sign in with Google**.
3. Paste the **Client ID** into "Client IDs" and the **Client secret** into "Client Secret (for OAuth)".
4. Leave "Skip nonce checks" off.
5. Check that the **Callback URL** it shows is `https://wwaknikpdquwnphhwzsm.supabase.co/auth/v1/callback`. It must match step 1.7 exactly.
6. Click **Save**.

You don't need to change anything else:
- **Site URL** is already `https://oizer.trubase.org`.
- **Redirect URLs** already include `https://oizer.trubase.org/**` and `https://oizer-drm.pages.dev/**`. I checked both on 2026-11-16, read-only.

## 3. Check it (2 minutes)

1. Open https://oizer.trubase.org in a private window. **Sign in with Google** shows under the Sign in button.
2. Sign in with a Google account whose email already has a Donor Base login. You land in the same account, with the same access as before; Supabase links the Google sign-in to the existing login by email.
3. If that login has text or call codes set up, you're asked for a code before anything opens.
4. A Google account whose email isn't on file anywhere gets no access, the same as a sign-up with an unlisted email, until an admin grants it. A fundraiser whose email is on file is matched automatically, as with sign-up.

## Notes

- **Turning it off:** switch Google off in the same Supabase screen. The button disappears from the login page on the next visit.
- **Password lockout:** Google sign-in doesn't use a password, so the five-wrong-passwords lockout doesn't apply to it. Google handles its own account protection.
- **Production project (#6):** when the production project is created, repeat step 2 there. In Google, add that project's callback URL as a second redirect URI.
