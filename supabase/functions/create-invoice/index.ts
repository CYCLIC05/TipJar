// supabase/functions/create-invoice/index.ts
// Edge Function: proxies Crypto Pay invoice creation from the server side
// Deploy with: supabase functions deploy create-invoice

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CRYPTO_PAY_TOKEN = Deno.env.get("CRYPTO_PAY_TOKEN")!;
const CRYPTO_PAY_BASE  = "https://pay.crypt.bot/api";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { currency, cryptoAmount, creatorName, message, payload } = body;

    if (!currency || !cryptoAmount || !creatorName) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: currency, cryptoAmount, creatorName" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const description = message
      ? `Tip for ${creatorName}: "${message}"`
      : `Tip for ${creatorName} via TipJar`;

    // Call Crypto Pay API from the server (no CORS issue)
    const cpRes = await fetch(`${CRYPTO_PAY_BASE}/createInvoice`, {
      method: "POST",
      headers: {
        "Crypto-Pay-API-Token": CRYPTO_PAY_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        asset:           currency,
        amount:          String(cryptoAmount),
        description,
        payload,
        allow_comments:  false,
        allow_anonymous: true,
        expires_in:      3600,
      }),
    });

    const json = await cpRes.json();

    if (!json.ok) {
      console.error("[create-invoice] Crypto Pay error:", JSON.stringify(json));
      return new Response(
        JSON.stringify({ error: json.error?.name || "Crypto Pay request failed" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const invoice = json.result;

    return new Response(
      JSON.stringify({
        invoice_id: invoice.invoice_id,
        pay_url:    invoice.pay_url,
        status:     invoice.status,
        amount:     invoice.amount,
        asset:      invoice.asset,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[create-invoice] Error:", err.message);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
