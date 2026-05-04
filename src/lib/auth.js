// src/lib/auth.js
// Telegram Web App authentication for TipJar
// Validates the user's Telegram identity and upserts them in Supabase

import { supabase } from './supabase.js';

/**
 * Reads initData from the Telegram Web App SDK.
 * On mobile inside Telegram, this is auto-populated.
 * In dev/browser, we fall back to a mock user.
 */
function getTelegramUser() {
  // Real Telegram Mini App environment
  if (window.Telegram?.WebApp?.initDataUnsafe?.user) {
    const user = window.Telegram.WebApp.initDataUnsafe.user;
    return {
      telegram_id: user.id,
      username: user.username || `user_${user.id}`,
      display_name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
      avatar_url: user.photo_url || `https://api.dicebear.com/7.x/adventurer/svg?seed=${user.id}`,
    };
  }

  // Fallback for local development / browser testing
  console.warn('[TipJar Auth] Not inside Telegram — using mock dev user.');
  return {
    telegram_id: 99999999,
    username: 'dev_creator',
    display_name: 'Dev Creator',
    avatar_url: 'https://api.dicebear.com/7.x/adventurer/svg?seed=dev',
  };
}

/**
 * Initializes Telegram WebApp and authenticates the creator.
 * - Expands the mini app to full screen
 * - Finds or creates the creator record in Supabase
 * - Returns the full creator object
 */
export async function initTelegramAuth() {
  // Expand the Mini App to full screen
  if (window.Telegram?.WebApp) {
    window.Telegram.WebApp.expand();
    window.Telegram.WebApp.ready();
  }

  const telegramUser = getTelegramUser();

  // Upsert the creator in the database (create if first time, update if returning)
  const { data: creator, error } = await supabase
    .from('creators')
    .upsert(
      {
        telegram_id: telegramUser.telegram_id,
        username: telegramUser.username,
        display_name: telegramUser.display_name,
        avatar_url: telegramUser.avatar_url,
      },
      {
        onConflict: 'telegram_id',   // Match by telegram_id
        ignoreDuplicates: false,      // Always update display_name/avatar in case they changed
      }
    )
    .select()
    .single();

  if (error) {
    console.error('[TipJar Auth] Upsert error:', error.message);
    throw error;
  }

  console.log('[TipJar Auth] Creator authenticated:', creator.display_name);
  return creator;
}
