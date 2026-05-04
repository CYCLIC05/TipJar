-- ============================================================
-- TipJar - Supabase Database Schema
-- Run this in the Supabase SQL Editor to initialize the DB
-- ============================================================

-- ===========================
-- TABLE: creators
-- Stores creator profile data and virtual balances
-- ===========================
CREATE TABLE IF NOT EXISTS public.creators (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id       BIGINT UNIQUE NOT NULL,   -- Telegram user ID (the primary identity)
  username          TEXT,                      -- e.g. 'alex_creates'
  display_name      TEXT,                      -- e.g. 'Alex Rivers'
  avatar_url        TEXT,                      -- Profile photo URL from Telegram
  bio               TEXT,
  
  -- Payout/wallet info
  withdrawal_wallet TEXT,                      -- Creator's personal wallet address for withdrawals

  -- Goal tracking
  goal_title        TEXT    DEFAULT 'My Creator Goal',
  goal_target       NUMERIC DEFAULT 1000,

  -- Virtual balance (held by TipJar)
  balance_usd       NUMERIC DEFAULT 0,

  -- Timestamps
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- ===========================
-- TABLE: tips
-- Every incoming tip transaction
-- ===========================
CREATE TABLE IF NOT EXISTS public.tips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id        UUID REFERENCES public.creators(id) ON DELETE CASCADE,

  -- Tipper info (anonymous if no Telegram account linked)
  tipper_name       TEXT    DEFAULT 'Anonymous',
  tipper_telegram_id BIGINT,               -- Optional, if tipper is also a TG user

  -- What was tipped
  message           TEXT,                  -- Optional message from tipper
  crypto_currency   TEXT NOT NULL,         -- 'TON', 'USDT', 'ETH', 'TRX', 'BTC', etc.
  crypto_amount     NUMERIC NOT NULL,      -- Raw crypto amount sent
  usd_value         NUMERIC NOT NULL,      -- USD equivalent at time of tip

  -- Crypto Pay invoice tracking
  invoice_id        TEXT UNIQUE,           -- Crypto Pay API invoice ID
  pay_url           TEXT,                  -- Crypto Pay payment link

  -- Status
  status            TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | COMPLETED | FAILED | EXPIRED

  -- Timestamps
  created_at        TIMESTAMPTZ DEFAULT now(),
  paid_at           TIMESTAMPTZ
);

-- ===========================
-- TABLE: withdrawals
-- Creator withdrawal requests
-- ===========================
CREATE TABLE IF NOT EXISTS public.withdrawals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id        UUID REFERENCES public.creators(id) ON DELETE CASCADE,

  gross_amount_usd  NUMERIC NOT NULL,      -- What the creator requested
  platform_fee_usd  NUMERIC NOT NULL,      -- 10% TipJar fee
  net_amount_usd    NUMERIC NOT NULL,      -- What gets sent to creator
  
  to_wallet         TEXT NOT NULL,         -- Creator's payout wallet address
  crypto_currency   TEXT NOT NULL,         -- Which coin they want payout in

  -- Status: PENDING | PROCESSING | COMPLETED | FAILED
  status            TEXT NOT NULL DEFAULT 'PENDING',

  created_at        TIMESTAMPTZ DEFAULT now(),
  processed_at      TIMESTAMPTZ
);

-- ===========================
-- Row Level Security (RLS)
-- ===========================
ALTER TABLE public.creators  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tips      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawals ENABLE ROW LEVEL SECURITY;

-- Creators can only read/update their OWN profile
-- (We use a server-side service role for inserts/admin actions)
CREATE POLICY "Creators can view own profile"
  ON public.creators FOR SELECT
  USING (telegram_id = (current_setting('app.telegram_id', TRUE))::BIGINT);

CREATE POLICY "Creators can update own profile"
  ON public.creators FOR UPDATE
  USING (telegram_id = (current_setting('app.telegram_id', TRUE))::BIGINT);

-- Creators can view tips sent to them
CREATE POLICY "Creators can view their tips"
  ON public.tips FOR SELECT
  USING (
    creator_id = (
      SELECT id FROM public.creators
      WHERE telegram_id = (current_setting('app.telegram_id', TRUE))::BIGINT
    )
  );

-- ===========================
-- Helper: auto-update 'updated_at'
-- ===========================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
BEFORE UPDATE ON public.creators
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
