-- Add missing columns to creators table (run this after initial schema)
ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS withdrawal_wallet TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS total_tips_count INTEGER DEFAULT 0;

-- Track tipper identity for activity feed
ALTER TABLE public.tips
  ADD COLUMN IF NOT EXISTS tipper_avatar_url TEXT;

-- Index for fast creator lookup by username
CREATE INDEX IF NOT EXISTS idx_creators_username ON public.creators(username);
CREATE INDEX IF NOT EXISTS idx_creators_telegram_id ON public.creators(telegram_id);
CREATE INDEX IF NOT EXISTS idx_tips_invoice_id ON public.tips(invoice_id);
CREATE INDEX IF NOT EXISTS idx_tips_creator_status ON public.tips(creator_id, status);
