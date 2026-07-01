<div align="center">

<img width="1200" alt="Banner" src="assets/banner.png">

# 🚀 ThrowBox

Modern multiplayer web application powered by **Google Gemini**, **Supabase**, **Socket.IO** and **Capacitor**.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green)]()
[![Capacitor](https://img.shields.io/badge/Capacitor-Android-blue)]()
[![Supabase](https://img.shields.io/badge/Supabase-Backend-3FCF8E)]()
[![License](https://img.shields.io/badge/License-MIT-yellow)]()

</div>

---

# 📖 Overview

ThrowBox is an AI-powered multiplayer application built with modern web technologies.

Features include:

- 🤖 Google Gemini AI
- 📱 Android support (Capacitor)
- ☁️ Supabase backend
- ⚡ Socket.IO real-time communication
- 🌐 Easy cloud deployment

---

# 📑 Table of Contents

- Installation
- Environment Variables
- Running Locally
- Android Build
- Deploy
- Supabase
- Project Structure

---

# 📦 Installation

## Requirements

- Node.js 18+
- npm
- Gemini API Key

Clone the repository:

```bash
git clone https://github.com/your-user/your-repository.git

cd your-repository
```

Install dependencies:

```bash
npm install
```

---

# ⚙️ Environment Variables

Create a `.env.local` file.

| Variable | Description |
|------------|-------------|
| GEMINI_API_KEY | Gemini API Key |
| VITE_SOCKET_URL | Socket.IO backend URL |

Example:

```env
GEMINI_API_KEY=xxxxxxxxxxxxxxxx
VITE_SOCKET_URL=http://192.168.1.42:3000
```

---

# 🚀 Run Locally

Start the development server:

```bash
npm run dev
```

---

# 📱 Android (Capacitor)

Sync Android project:

```bash
npm run android:sync
```

Build Debug APK:

```bash
npm run android:debug
```

APK output:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

---

# ☁️ Deploy (Northflank)

Push your project to GitHub.

Create a new **Service** using your repository.

Configuration:

| Setting | Value |
|----------|-------|
| Build Command | `npm install && npm run build` |
| Start Command | `npm run start` |
| Port | `PORT` |

Environment Variables:

```text
NODE_ENV=production

SUPABASE_URL=https://YOUR_PROJECT.supabase.co

SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

Health Check:

```
/api/health
```

After deployment update:

```env
VITE_SOCKET_URL=https://YOUR-NORTHFLANK-URL
```

Rebuild Android:

```bash
npm run android:debug
```

---

# 🗄️ Supabase

Run the following SQL:

```sql
create table if not exists public.throwbox_state (
  id text primary key,
  game_objects jsonb not null default '[]'::jsonb,
  transfer_history jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
```

Copy:

- Project URL
- Service Role Key

from:

```
Project Settings → API
```

---

# 🔒 Security

Never expose:

```
SUPABASE_SERVICE_ROLE_KEY
```

This key must only exist on the backend.

---

# 📂 Project Structure

```
.
├── android/
├── public/
├── src/
├── server/
├── .env.local
├── package.json
└── README.md
```

---

# ❤️ Built With

- Google Gemini
- React
- Vite
- Socket.IO
- Supabase
- Capacitor
- Node.js

---

# 📄 License

MIT License
````
