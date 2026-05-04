// TipJar Bot — bot/bot.js
// Telegram Bot server: handles deep links, notifications, and Crypto Pay webhook
require('dotenv').config();

const TelegramBot   = require('node-telegram-bot-api');
const express       = require('express');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// Setup
// ============================================================
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;
const PORT         = process.env.PORT || 3001;

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Admin Supabase client (service role — can bypass RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(express.json());

// ============================================================
// /start Handler
// ============================================================
// Deep-link format: t.me/TipJarBot?start=creator_<telegram_id>
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const payload = (match[1] || '').trim();

  // --- Default welcome (no payload) ---
  if (!payload) {
    return bot.sendMessage(chatId,
      `💰 *Welcome to TipJar!*\n\nThe easiest way to send and receive crypto tips on Telegram.\n\n` +
      `Are you a creator? Tap below to set up your TipJar profile.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {
              text: '🚀 Open TipJar',
              web_app: { url: MINI_APP_URL }
            }
          ]]
        }
      }
    );
  }

  // --- Creator deep link: start=creator_<telegram_id> ---
  if (payload.startsWith('creator_')) {
    const creatorTelegramId = payload.replace('creator_', '');

    // Look up the creator in Supabase
    const { data: creator, error } = await supabase
      .from('creators')
      .select('id, display_name, username, avatar_url, goal_title, goal_target, balance_usd')
      .eq('telegram_id', creatorTelegramId)
      .single();

    if (error || !creator) {
      return bot.sendMessage(chatId,
        `❌ Creator not found. They may not have set up their TipJar yet.`
      );
    }

    // Build the Mini App URL with the creator ID as a query param
    const tipUrl = `${MINI_APP_URL}?creator=${creator.id}`;

    return bot.sendMessage(chatId,
      `💜 *Support ${creator.display_name}*\n\n` +
      `@${creator.username || 'creator'} is accepting crypto tips on TipJar.\n\n` +
      `🎯 *Goal:* ${creator.goal_title || 'Creator Support'}\n` +
      `Choose an amount and pay instantly using TON, USDT, ETH, TRX and more.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {
              text: `❤️ Tip ${creator.display_name}`,
              web_app: { url: tipUrl }
            }
          ]]
        }
      }
    );
  }
});

// ============================================================
// Notification Helpers
// ============================================================

/**
 * Sends a "You received a tip!" message to the creator
 */
async function notifyCreator(creatorTelegramId, { tipperName, amount, currency, message }) {
  const lines = [
    `💰 *New Tip Received!*`,
    ``,
    `${tipperName || 'Someone'} just tipped you *$${parseFloat(amount).toFixed(2)}* in ${currency}!`,
  ];
  if (message) lines.push(``, `💬 "${message}"`);
  lines.push(``, `Open your dashboard to see your updated balance.`);

  await bot.sendMessage(creatorTelegramId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        {
          text: '📊 View Dashboard',
          web_app: { url: MINI_APP_URL }
        }
      ]]
    }
  });
}

/**
 * Sends a first-tip special celebration to the creator
 */
async function notifyFirstTip(creatorTelegramId, { tipperName, amount, currency }) {
  await bot.sendMessage(creatorTelegramId,
    `🎉 *Your First TipJar Tip!*\n\n` +
    `Congratulations! *${tipperName || 'Your first supporter'}* just tipped you *$${parseFloat(amount).toFixed(2)}* in ${currency}!\n\n` +
    `This is just the beginning — share your TipJar link to get more tips! 🚀`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🎊 Open Dashboard', web_app: { url: MINI_APP_URL } }
        ]]
      }
    }
  );
}

// ============================================================
// Crypto Pay Webhook Endpoint
// ============================================================
// Register this URL in @CryptoBot → My Apps → Webhooks:
// https://your-bot-domain.com/webhook/cryptopay

app.post('/webhook/cryptopay', async (req, res) => {
  const event = req.body;

  // Only handle paid invoices
  if (event.update_type !== 'invoice_paid') {
    return res.sendStatus(200);
  }

  const invoice = event.payload;
  const invoiceId = String(invoice.invoice_id);
  const amount    = parseFloat(invoice.amount);
  const currency  = invoice.asset;

  console.log(`[TipJar Webhook] Invoice paid: #${invoiceId} — ${amount} ${currency}`);

  try {
    // 1. Find the matching PENDING tip record
    const { data: tip, error: tipError } = await supabase
      .from('tips')
      .select('*, creators(id, telegram_id, display_name, balance_usd)')
      .eq('invoice_id', invoiceId)
      .eq('status', 'PENDING')
      .single();

    if (tipError || !tip) {
      console.warn(`[TipJar Webhook] No PENDING tip found for invoice #${invoiceId}`);
      return res.sendStatus(200);
    }

    const creator = tip.creators;

    // 2. Mark tip as COMPLETED
    await supabase
      .from('tips')
      .update({ status: 'COMPLETED', paid_at: new Date().toISOString() })
      .eq('invoice_id', invoiceId);

    // 3. Credit creator's virtual balance
    const newBalance = (parseFloat(creator.balance_usd) || 0) + tip.usd_value;
    await supabase
      .from('creators')
      .update({ balance_usd: newBalance })
      .eq('id', creator.id);

    // 4. Check if this is the creator's first tip
    const { count } = await supabase
      .from('tips')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', creator.id)
      .eq('status', 'COMPLETED');

    // 5. Notify creator via Telegram
    if (creator.telegram_id) {
      if (count === 1) {
        await notifyFirstTip(creator.telegram_id, {
          tipperName: tip.tipper_name,
          amount: tip.usd_value,
          currency,
        });
      } else {
        await notifyCreator(creator.telegram_id, {
          tipperName: tip.tipper_name,
          amount: tip.usd_value,
          currency,
          message: tip.message,
        });
      }
    }

    console.log(`[TipJar Webhook] ✅ Tip #${invoiceId} completed. Creator balance: $${newBalance}`);
    return res.sendStatus(200);

  } catch (err) {
    console.error('[TipJar Webhook] Error:', err.message);
    return res.sendStatus(500);
  }
});

// ============================================================
// Health Check
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'TipJar Bot' }));

// ============================================================
// Start
// ============================================================
app.listen(PORT, () => {
  console.log(`[TipJar Bot] 🚀 Running on port ${PORT}`);
  console.log(`[TipJar Bot] Webhook: POST /webhook/cryptopay`);
  console.log(`[TipJar Bot] Mini App: ${MINI_APP_URL}`);
});

module.exports = { notifyCreator, notifyFirstTip };
