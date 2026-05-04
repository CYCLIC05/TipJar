# TipJar Supabase CLI Setup
# Run these commands from the tipsy project root

# 1. Install Supabase CLI (if not installed)
npm install -g supabase

# 2. Login to Supabase
supabase login

# 3. Link to your project (use your project ref: aoontrxqwowdpgfwvjzg)
supabase link --project-ref aoontrxqwowdpgfwvjzg

# 4. Set the Crypto Pay secret on the Edge Function
supabase secrets set CRYPTO_PAY_TOKEN=577083:AAkjTpKy39hGaLhNRV7w1oUdyrJXXjJxCwo

# 5. Deploy the Edge Function
supabase functions deploy create-invoice
