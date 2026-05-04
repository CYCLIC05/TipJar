// src/lib/cryptopay.js
// TipJar — Crypto Pay helpers (browser-safe)
// Invoice creation is proxied through a Supabase Edge Function to avoid CORS.

const SUPABASE_URL     = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const CRYPTO_PAY_TOKEN  = import.meta.env.VITE_CRYPTO_PAY_TOKEN;

// The Edge Function URL (deployed to Supabase)
const EDGE_CREATE_INVOICE = `${SUPABASE_URL}/functions/v1/create-invoice`;

// Direct Crypto Pay base — used for read-only polling (getInvoices allows CORS)
const CRYPTO_PAY_BASE = 'https://pay.crypt.bot/api';

/**
 * Supported currencies mapping for TipJar
 */
export const SUPPORTED_CURRENCIES = {
  TON:  { asset: 'TON',  label: 'TON',      decimals: 9  },
  USDT: { asset: 'USDT', label: 'USDT',      decimals: 6  },
  ETH:  { asset: 'ETH',  label: 'Ethereum',  decimals: 18 },
  TRX:  { asset: 'TRX',  label: 'TRON',      decimals: 6  },
  BTC:  { asset: 'BTC',  label: 'Bitcoin',   decimals: 8  },
  SOL:  { asset: 'SOL',  label: 'Solana',    decimals: 9  },
  BNB:  { asset: 'BNB',  label: 'BNB',       decimals: 18 },
};

/**
 * Create a Crypto Pay invoice via the Supabase Edge Function (server-side proxy).
 * This avoids CORS issues when calling Crypto Pay directly from the browser.
 *
 * @returns {{ invoice_id, pay_url, status, amount, asset }}
 */
export async function createInvoice({ currency, cryptoAmount, creatorName, message, payload }) {
  const asset = SUPPORTED_CURRENCIES[currency]?.asset;
  if (!asset) throw new Error(`Unsupported currency: ${currency}`);

  const res = await fetch(EDGE_CREATE_INVOICE, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey':        SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ currency: asset, cryptoAmount, creatorName, message, payload }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[CryptoPay Edge] ${res.status}: ${text}`);
  }

  const invoice = await res.json();

  if (invoice.error) {
    throw new Error(`[CryptoPay Edge] ${invoice.error}`);
  }

  return {
    invoice_id: invoice.invoice_id,
    pay_url:    invoice.pay_url,
    status:     invoice.status,
    amount:     invoice.amount,
    asset:      invoice.asset,
  };
}

/**
 * Poll whether an invoice has been paid.
 * Crypto Pay's getInvoices endpoint does support CORS, so we can call it directly.
 *
 * @param {number|string} invoiceId
 * @returns {boolean} true if paid
 */
export async function checkInvoicePaid(invoiceId) {
  const res = await fetch(`${CRYPTO_PAY_BASE}/getInvoices?invoice_ids=${invoiceId}`, {
    headers: { 'Crypto-Pay-API-Token': CRYPTO_PAY_TOKEN },
  });

  if (!res.ok) return false;

  const json = await res.json();
  const invoice = json.result?.items?.[0];
  return invoice?.status === 'paid';
}

