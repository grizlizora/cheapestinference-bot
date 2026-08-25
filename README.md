# 🤖 CheapestInference Telegram Monitoring Bot

> **24/7 Telegram Bot** in TypeScript for real-time GPU/LLM slot availability tracking on [cheapestinference.com](https://cheapestinference.com/pools) with **Tor/proxy anti-ban**, multi-language support (🇺🇦 / 🇬🇧 / 🇷🇺), granular user alert subscriptions, and **100% free cloud deployment**.

---

## ✨ Features

- 🕵️ **Anonymity & Anti-Ban**:
  - Embedded **Tor SOCKS5h daemon** with automatic circuit renewal (`SIGNAL NEWNYM` via ControlPort) upon encountering 429/403 rate limits.
  - Support for external HTTP/HTTPS/SOCKS5 proxy lists with auto-health checking and failover.
  - Realistic Chrome 128 desktop header spoofing (`sec-ch-ua`, `Sec-Fetch-*`, `User-Agent`).
  - **HTTP 304 ETag caching** to save >90% bandwidth and mimic natural browser behavior.
  - **Dual-Engine Fallback**: Primary JSON API (`/api/pools`) + SSR HTML snapshot (`/pools`) parsing.
  - Jittered Poisson-like polling intervals (15–35s) + exponential backoff.
- 🌐 **3-Language Localization (i18n)**:
  - 🇺🇦 **Українська** (Default)
  - 🇬🇧 **English**
  - 🇷🇺 **Русский**
  - Onboarding language selection gate on `/start` + instant switching via `/language` or settings.
- 📊 **Interactive Telegram UI (grammY)**:
  - Live status badges (🟢 Available / 🟡 Limited / 🔴 Sold Out).
  - Pool detail views showing included models, pricing, and 8-hour regional blocks (**Asia 00-08 UTC**, **Europe 08-16 UTC**, **Americas 16-24 UTC**).
  - In-place message updates with instant toast banners (`answerCallbackQuery`).
- 🔔 **Granular Personal Alert Matrix**:
  - Global toggle (Any slot in any pool).
  - Pool-level toggle (All Flagship, Frontier, or Core slots).
  - Slot-level toggle (e.g. only Flagship Europe, only Core Americas).
  - Silent/Sound mode toggle per user.
- ⚡ **Zero-Spam State Machine**:
  - Fast-path $K=1$ notification for newly available slots.
  - $K=2$ consecutive confirmation gate for sold-out slots (protects against transient network drops).
  - Dynamic catalog updater (auto-notifies and updates UI when models or pricing change).
  - `p-queue` rate limiting (25 msg/s globally, 1 msg/1.5s per user, multi-event bundling).
- ☁️ **100% Free 24/7 Cloud Deployment**:
  - Pre-configured for **Hugging Face Docker Spaces** (No credit card, 16GB RAM).
  - Pre-configured for **Render.com** (Free Docker Web Service with `/health` keepalive).
  - Multi-stage Alpine Dockerfile with total container RAM < 70MB.

---

## 🚀 Quick Start (Local Setup)

### 1. Prerequisites
- Node.js >= 20.0.0 (or Docker)
- Telegram Bot Token from [@BotFather](https://t.me/botfather)

### 2. Installation
```bash
git clone <your-repo-url>
cd "telegram bot cheapestinference"
npm install
```

### 3. Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Edit `.env`:
```env
BOT_TOKEN=1234567890:ABCdefGHIJklmNoPQRsTUVwxyZ_example
ADMIN_USER_IDS=123456789
DB_PATH=./data/bot.db
PORT=7860
TOR_ENABLED=false
```

### 4. Run Development Server
```bash
npm run dev
```

---

## 🐳 Docker Setup

Run everything inside Docker with the embedded Tor daemon:

```bash
docker compose up -d --build
```

View logs:
```bash
docker compose logs -f
```

---

## ☁️ Free 24/7 Cloud Deployment Guides

### Option 1: Hugging Face Spaces (Recommended — 100% Free, No Credit Card, 16GB RAM)

1. Create a free account at [Hugging Face](https://huggingface.co).
2. Click **New Space** -> Choose **Docker** SDK (Blank) -> Set visibility to **Public** (required for free 24/7 tier).
3. Push this repository to your Space repository.
4. In your Space **Settings** -> **Variables and secrets**, add:
   - `BOT_TOKEN`: `<your_bot_token_from_botfather>`
   - `TOR_ENABLED`: `true`
5. Set up a free monitor on [UptimeRobot](https://uptimerobot.com) or [Cron-job.org](https://cron-job.org) to ping your Space URL:
   `https://<your-username>-<your-space-name>.hf.space/health` every 10 minutes.

---

### Option 2: Render.com (Free Web Service)

1. Create a free account on [Render.com](https://render.com).
2. Click **New +** -> **Web Service** -> Connect your Git repository.
3. Select **Docker** runtime.
4. Set Environment Variables:
   - `BOT_TOKEN`: `<your_bot_token_from_botfather>`
   - `TOR_ENABLED`: `true`
   - `PORT`: `10000`
5. Add a free HTTP monitor on [UptimeRobot](https://uptimerobot.com) to ping `https://<your-app>.onrender.com/health` every 10 minutes to prevent the free container from sleeping.

---

### Option 3: Oracle Cloud Always Free (Permanent Free Dedicated VPS)

1. Launch a free Ubuntu ARM Ampere or AMD VM on Oracle Cloud.
2. Clone the repo and run:
   ```bash
   docker compose up -d
   ```
3. Runs 24/7 natively without any sleep triggers or ping workarounds needed.

---

## 📱 Bot Commands

| Command | Description |
| :--- | :--- |
| `/start` | Open the main dashboard (or language selector for new users) |
| `/language` | Open language selection menu (🇺🇦 UK / 🇬🇧 EN / 🇷🇺 RU) |
| `/help` | Detailed guide on how cheapestinference pools and slot blocks work |
| `/admin` or `/stats` | Admin telemetry (User count, active rules, scraper health, proxy status, memory) |
| `/testalert` | Dispatch a synthetic slot alert to test notification delivery |

---

## 🏛 Project Architecture

```
src/
├── config/env.ts              # Zod-validated environment config
├── types/                     # Domain, Database, and grammY Context types
├── i18n/                      # Type-safe translations (UK, EN, RU)
├── db/                        # SQLite connector (WAL mode) and DAOs
│   └── dao/                   # UserDAO, SubscriptionDAO, PoolStateDAO, NotificationLogDAO
├── proxy/                     # TorManager (ControlPort NEWNYM) & ProxyPool
├── http/client.ts             # Undici HTTP client with header spoofing & ETag caching
├── scrapers/                  # JsonApiEngine & HtmlSnapshotEngine
├── engine/                    # SanityGuard, SlotDiffEngine, ScraperOrchestrator
├── bot/                       # grammY bot instance, menus, handlers, and notifier
│   ├── menus/                 # Dashboard, PoolDetail, Subscriptions, Language
│   └── notifier/dispatcher.ts # P-Queue rate-limited broadcast dispatcher
├── server/health.ts           # Lightweight HTTP server for uptime keepalive
└── index.ts                   # Main application entry point
```

---

## 📄 License
MIT
