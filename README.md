# TipJar

TipJar is a high-performance, native-feeling Telegram Mini App that allows creators to receive crypto tips instantly. Built as a sleek, professional platform, it leverages the Telegram-native Crypto Pay API for multi-chain tipping (TON, USDT, ETH, SOL, etc.) and Supabase for secure, persistent user profile and transaction management.

## Features

- **Multi-Chain Crypto Tipping:** Native integration with Telegram's @CryptoBot API supporting TON, USDT, ETH, TRX, BTC, SOL, and BNB.
- **Telegram Native Auth:** Auto-login and identity verification using Telegram Web App `initData`.
- **Creator Dashboard:** Real-time balance, tip history, and goal tracking.
- **Custodial Architecture:** Funds are held in a platform merchant wallet, enabling automated platform fee deductions and simplified user flows.
- **Dynamic Leaderboard:** Highlights top supporters and top creators.
- **Interactive UI:** Premium mobile-first design with smooth transitions, modern typography, and a celebratory "First Tip" experience with confetti.

## Architecture

The project consists of three main components:

1. **Frontend (Vite / Vanilla JS):** 
   - A single-page application built for the Telegram Web App container.
   - Entry point: `index.html` & `main.js`.
   - Communicates with Supabase for data and the Supabase Edge Function for creating invoices.

2. **Supabase Database & Edge Functions:**
   - **PostgreSQL Database:** Stores `creators`, `tips`, and `withdrawals`.
   - **Edge Function (`create-invoice`):** Proxies requests to the Crypto Pay API from the server side to bypass CORS restrictions.

3. **Telegram Bot (Node.js / Express):**
   - Resides in the `bot/` directory.
   - Handles the `/start` command and deep links (`/start creator_<id>`).
   - Runs the webhook server (`/webhook/cryptopay`) to receive payment confirmations from Crypto Pay.
   - Sends real-time Telegram messages to creators when they receive a tip.

## Prerequisites

- Node.js (v18+)
- A Supabase Project
- A Telegram Bot (via @BotFather)
- A Crypto Pay App Token (via @CryptoBot)

## Setup & Deployment

See the [Deployment Walkthrough](./walkthrough.md) for full, step-by-step instructions on taking this app to production.

### Local Development

1. **Clone the repository and install dependencies:**
   ```bash
   npm install
   cd bot && npm install
   ```

2. **Environment Variables:**
   Create a `.env` file in the root directory:
   ```env
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   VITE_CRYPTO_PAY_TOKEN=your_crypto_pay_token
   ```
   Create a `.env` file in the `bot/` directory:
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   CRYPTO_PAY_TOKEN=your_crypto_pay_token
   MINI_APP_URL=your_local_or_deployed_frontend_url
   PORT=3001
   ```

3. **Run the local frontend:**
   ```bash
   npm run dev
   ```

4. **Run the bot server:**
   ```bash
   cd bot
   npm run dev
   ```

## Troubleshooting

- **CORS Errors during payment:** Ensure the `create-invoice` Supabase Edge Function is deployed. Browsers cannot hit the Crypto Pay API directly.
- **"Payment failed. Please try again."**: This indicates the Edge Function request failed (likely not deployed or missing environment variables). Deploy it via the Supabase CLI.
- **"Creator not found"**: Ensure the Supabase `schema.sql` and `migrations.sql` have been executed in your Supabase SQL Editor.

## License
MIT
