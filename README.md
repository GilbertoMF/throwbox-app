<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/64a86097-c8be-4167-90e1-c579cea787a6

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Android (Capacitor)

1. Set `VITE_SOCKET_URL` in `.env.local` to your Socket.IO backend URL.
   Example (real device on same Wi-Fi): `VITE_SOCKET_URL=http://192.168.1.42:3000`
2. Build and sync Android project:
   `npm run android:sync`
3. Build debug APK:
   `npm run android:debug`

Generated APK path:
`android/app/build/outputs/apk/debug/app-debug.apk`

## Deploy on Northflank (Free Sandbox)

1. Push this project to GitHub.
2. In Northflank, create a new `Service` from that Git repository.
3. Use these settings:
   - Build command: `npm install && npm run build`
   - Start command: `npm run start`
   - Port: `PORT` (Northflank injects it automatically)
4. Add env vars:
   - `NODE_ENV=production`
   - `SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY`
5. Configure a health check path:
   - `/api/health`
6. Deploy and copy your public HTTPS URL.

After deploy, point your Android app to this URL:
- `.env.local` in this project:
  - `VITE_SOCKET_URL=https://YOUR-NORTHFLANK-URL`
- Rebuild APK:
  - `npm run android:debug`

## Supabase setup

1. Create a project in Supabase.
2. Open `SQL Editor` and run:

```sql
create table if not exists public.throwbox_state (
  id text primary key,
  game_objects jsonb not null default '[]'::jsonb,
  transfer_history jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
```

3. In `Project Settings -> API`, copy:
   - Project URL (`SUPABASE_URL`)
   - `service_role` key (`SUPABASE_SERVICE_ROLE_KEY`)

Security note:
- `SUPABASE_SERVICE_ROLE_KEY` must stay only in backend runtime variables (Northflank), never in app frontend.
