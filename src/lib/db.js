// src/lib/db.js
// TipJar database helper functions
// All app interactions with Supabase go through here

import { supabase } from './supabase.js';

// ===========================
// CREATOR FUNCTIONS
// ===========================

/** Fetch a creator's full profile by their Supabase UUID */
export async function getCreator(creatorId) {
  const { data, error } = await supabase
    .from('creators')
    .select('*')
    .eq('id', creatorId)
    .single();

  if (error) throw error;
  return data;
}

/** Update creator profile fields (goal, wallet address, etc.) */
export async function updateCreator(creatorId, updates) {
  const { data, error } = await supabase
    .from('creators')
    .update(updates)
    .eq('id', creatorId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ===========================
// TIP FUNCTIONS
// ===========================

/** Fetch all completed tips for a creator (for activity feed) */
export async function getCreatorTips(creatorId, limit = 20) {
  const { data, error } = await supabase
    .from('tips')
    .select('*')
    .eq('creator_id', creatorId)
    .eq('status', 'COMPLETED')
    .order('paid_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/** Create a new PENDING tip record before the payment is made */
export async function createTipRecord({ creatorId, tipperName, message, currency, cryptoAmount, usdValue, invoiceId, payUrl }) {
  const { data, error } = await supabase
    .from('tips')
    .insert({
      creator_id: creatorId,
      tipper_name: tipperName || 'Anonymous',
      message,
      crypto_currency: currency,
      crypto_amount: cryptoAmount,
      usd_value: usdValue,
      invoice_id: invoiceId,
      pay_url: payUrl,
      status: 'PENDING',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Mark a tip as COMPLETED after the Crypto Pay webhook confirms payment */
export async function completeTip(invoiceId) {
  // 1. Find the tip record
  const { data: tip, error: findError } = await supabase
    .from('tips')
    .select('*, creators(balance_usd)')
    .eq('invoice_id', invoiceId)
    .single();

  if (findError) throw findError;

  // 2. Mark it as paid
  const { error: updateTipError } = await supabase
    .from('tips')
    .update({ status: 'COMPLETED', paid_at: new Date().toISOString() })
    .eq('invoice_id', invoiceId);

  if (updateTipError) throw updateTipError;

  // 3. Add the USD value to the creator's virtual balance
  const newBalance = (tip.creators.balance_usd || 0) + tip.usd_value;
  await supabase
    .from('creators')
    .update({ balance_usd: newBalance })
    .eq('id', tip.creator_id);

  return tip;
}

// ===========================
// WITHDRAWAL FUNCTIONS
// ===========================

/** Create a withdrawal request (10% fee deducted by backend) */
export async function requestWithdrawal(creatorId, { grossAmount, wallet, currency }) {
  const platformFee = grossAmount * 0.10;
  const netAmount = grossAmount - platformFee;

  // 1. Insert withdrawal record
  const { data: withdrawal, error } = await supabase
    .from('withdrawals')
    .insert({
      creator_id: creatorId,
      gross_amount_usd: grossAmount,
      platform_fee_usd: platformFee,
      net_amount_usd: netAmount,
      to_wallet: wallet,
      crypto_currency: currency,
      status: 'PENDING',
    })
    .select()
    .single();

  if (error) throw error;

  // 2. Zero out the creator's balance
  await supabase
    .from('creators')
    .update({ balance_usd: 0 })
    .eq('id', creatorId);

  return withdrawal;
}
