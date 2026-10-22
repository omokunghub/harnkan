# HarnKan (หารกัน)

Splitwise-style bill splitting for a group of ~10 friends, with receipt scanning. PWA (no app store).
Owner talks in Thai; reply in Thai. All UI text is Thai.

Live: https://harnkan-7a6.pages.dev · Supabase project ref `oncuqybkluuifmvomwsh` · Cloudflare Pages project `harnkan`

## Where things run
- **Frontend** (`src/`, Vite + React 19 + TS, react-router v8): static files on Cloudflare Pages. All logic runs in the browser.
- **Supabase**: Postgres + RLS (all access control lives here), Auth (Google only), Storage, Realtime, Edge Functions.
- **Edge function `scan-receipt`**: the only server code. Checks the caller is in a group, calls Gemini with a model
  fallback chain (`GEMINI_MODELS` secret, default flash-lite → flash → 2.5-flash-lite), returns JSON items with `details` and `box_2d`.
- `supabase/functions/notify` (web push) exists but is **not set up yet** (no VAPID keys, no DB webhooks).
- `.github/workflows/keepalive.yml` pings Supabase every 3 days so the free project doesn't pause.

## Commands
```
npm run dev          # http://localhost:5188 (must match Supabase redirect URLs)
npx vitest run       # money math + DB tests (PGlite runs every migration with RLS)
npm run build        # tsc -b && vite build → dist/
npx wrangler pages deploy dist --project-name harnkan --branch main      # frontend deploy
npx supabase functions deploy scan-receipt --project-ref oncuqybkluuifmvomwsh --use-api
```
Run `npx vitest run` and `npm run build` before every commit.

## Files
- `src/money.ts` — ALL money math (integer minor units; JPY has 0 decimals). allocate (proportional to ticked items
  applied to the printed grand total, largest-remainder rounding), checkReceipt, balances (multi-payer via bill_payers),
  simplify, convertNet (FX estimate), splitWeights/detectSplit (equal/exact/percent/shares). Tests in `money.test.ts`.
- `src/supabase.ts` — client, MEMBER_COLS/BILL_COLS, hooks (useSession, useSignedUrl, useRates, useIsAdmin), shrink(), CURRENCIES.
- Pages: `App.tsx` (routes, home, join, account settings), `Group.tsx` (timeline, balances, currency toggle),
  `GroupSettings.tsx` (members+balances, admin actions, EditGroup), `AddExpense.tsx` (quick expense, split modes),
  `NewBill.tsx` (scan/edit receipt), `Bill.tsx` (tick items, ✏️ edit, ✂️ crop, comments), `SettleUp.tsx` (+ PromptPay/QR).
- Shared UI: `Payers.tsx`, `Crop.tsx`, `Camera.tsx`, `Avatar.tsx`, `FormHeader.tsx`, `Activity.tsx`.
- `supabase/migrations/*.sql` — schema history. `supabase/db.test.ts` — RLS/trigger tests.

## Rules
- **DB changes = a NEW migration file** (`YYYYMMDDHHMMSS_name.sql`). Never edit an old one — they're already applied.
  Add a `db.test.ts` case for every policy/trigger/constraint. The owner applies SQL by pasting it in Supabase SQL Editor;
  tell them which file, and deploy the frontend only AFTER they confirm (new columns in MEMBER_COLS/BILL_COLS break every page).
- Every table has RLS via `is_member(group_id)` (security definer helpers). Storage paths start with the group id or user id.
  Admin-only actions go through `security definer` RPCs checking `is_admin()` (`app_admins` table; owner is the only admin).
- Activity log is written only by DB triggers; the app can't insert/update/delete `activity`.
- Never put secrets in the repo or in `VITE_*` vars (they ship to the browser). Only the anon/publishable key is public.
  `.env.local` is git-ignored. Never ask for or use the service_role key.
- Keep it minimal: no new dependencies without a strong reason, stdlib/native first, mark deliberate shortcuts with `// ponytail:`.
- Git: commits use the GitHub noreply email (repo config already set). Ask before deploying — deploys are the owner's call.

## Known gotchas
- Android kills the PWA while the OS camera app is open → `Camera.tsx` uses an in-page getUserMedia camera.
- iOS: the home-screen app and Safari keep separate logins; push needs iOS 16.4+ and home-screen install.
- Google OAuth is blocked inside LINE's in-app browser — open links in Chrome/Safari.
- FX rates from api.frankfurter.dev (ECB), shown as estimates only; bills keep their own currency.
- Crop boxes are `[ymin,xmin,ymax,xmax]` 0–1000 + `crop_angle`; images are cut in CSS, never stored twice.
