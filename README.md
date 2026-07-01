<div align="center">

<img src="assets/banner.png" alt="ThrowBox Banner" width="100%" />

# 🚀 ThrowBox

Modern multiplayer application powered by **Google Gemini**, **Supabase**, **Socket.IO** and **Capacitor**.

[![Node.js](https://img.shields.io/badge/Node.js-18+-6fa660?style=flat-square&logo=node.js)](https://nodejs.org)
[![Capacitor](https://img.shields.io/badge/Capacitor-Android-119eff?style=flat-square&logo=capacitor)](https://capacitorjs.com)
[![Supabase](https://img.shields.io/badge/Supabase-Backend-3FCF8E?style=flat-square&logo=supabase)](https://supabase.com)
[![Socket.io](https://img.shields.io/badge/Socket.io-Realtime-010101?style=flat-square&logo=socket.io)](https://socket.io)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

</div>

---

## 📖 Overview

**ThrowBox** is an AI-powered, real-time multiplayer application designed for cross-device interaction. Drag physical objects (or custom doodles) off the edge of your phone screen, and watch them seamlessly fly into your friend's screen next to you.

```mermaid
sequenceDiagram
    autonumber
    participant P1 as Player 1 (Device A)
    participant Srv as Server (Socket.io)
    participant P2 as Player 2 (Device B)

    Note over P1: Dragging object to right edge
    P1->>Srv: dragging-object (direction: right, position)
    Srv->>P2: peer-dragging (show ghost preview on left edge)
    
    Note over P1: Release & Throw!
    P1->>Srv: transfer-object (objectId)
    Srv->>P2: object-transferred (trigger spring entrance animation)
    Note over P2: Object added to inventory!
```

---

## 📑 Table of Contents

- [Features](#-features)
- [Project Structure](#-project-structure)
- [Requirements](#-requirements)
- [Installation](#-installation)
- [Environment Variables](#-environment-variables)
- [Running Locally](#-running-locally)
- [Deploying to Northflank](#-deploying-to-northflank)
- [Supabase Setup](#-supabase-setup)
- [Security](#-security)

---

## ✨ Features

*   🤖 **Google Gemini AI:** Generate and interact with custom dynamic objects.
*   📱 **Android Integration:** Fully built with Capacitor for native mobile deployment.
*   ⚡ **Real-time Engine:** Ultra-low latency state sync using Socket.IO.
*   🗄️ **Persistent State:** PostgreSQL database sync hosted on Supabase.
*   ☁️ **Cloud Native:** Pre-configured for easy containerized deployment on Northflank.

---

## 📂 Project Structure

```bash
.
├── android/          # Native Android Studio project (Capacitor)
├── assets/           # Repository media assets (Banners, logos)
├── backend/          # Node.js + Express + Socket.IO server code
├── database/         # Database schemas and SQL files
├── src/              # React (Vite) frontend application code
├── .env.example      # Template for environment configuration
├── package.json      # Dependencies and execution scripts
└── README.md         # Documentation
```

---

## 💻 Installation

### Requirements

*   Node.js 18+
*   npm
*   Gemini API Key

Clone the repository:

```bash
git clone https://github.com/GilbertoMF/throwbox-app.git
cd throwbox-app
```

Install dependencies:

```bash
npm install
```

---

## ⚙️ Environment Variables

Create a `.env.local` file in the root directory.

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Your Google Gemini API Key | `AIzaSy...` |
| `VITE_SOCKET_URL` | Socket.IO backend URL (Use local IP for testing) | `http://192.168.1.42:3000` |

> [!TIP]
> When testing on a physical Android device on the same Wi-Fi network, configure `VITE_SOCKET_URL` with your computer's local IP address.

---

## 🚀 Running Locally

Start the full development server:

```bash
npm run dev
```

---

## ☁️ Deploying to Northflank

1. Push your repository to GitHub.
2. In your Northflank dashboard, create a new **Service** from your repository.
3. Configure the following deployment settings:

| Setting | Value |
| :--- | :--- |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm run start` |
| **Port** | `PORT` (Exposed port: 3000) |

4. Add the following **Environment Variables** in Northflank:
   *   `NODE_ENV` = `production`
   *   `SUPABASE_URL` = `https://YOUR_PROJECT.supabase.co`
   *   `SUPABASE_SERVICE_ROLE_KEY` = `YOUR_SERVICE_ROLE_KEY`
   *   `DATABASE_URL` = `postgresql://postgres:PASSWORD@YOUR_DB_HOST:5432/postgres`

5. Configure a **Health Check**:
   *   Path: `/api/health`

6. Once deployed, update your `.env.local` file with the deployment URL:
   ```env
   VITE_SOCKET_URL=https://your-app-subdomain.code.run
   ```

---

## 🗄️ Supabase Setup

Run this script in your Supabase **SQL Editor** to create the required table:

```sql
create table if not exists public.throwbox_state (
  id text primary key,
  game_objects jsonb not null default '[]'::jsonb,
  transfer_history jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
```

Retrieve your **Project URL** and **Service Role Key** under `Project Settings → API`.

---

## 🔒 Security

> [!CAUTION]
> Never expose your `SUPABASE_SERVICE_ROLE_KEY` or `GEMINI_API_KEY` in the frontend client. These keys bypass row-level security and must only exist on secure backend environments (like Northflank variables).

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
