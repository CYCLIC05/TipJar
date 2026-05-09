import os
import sys
import logging
import asyncio
from datetime import datetime, timezone

from dotenv import load_dotenv
from aiohttp import web
from aiogram import Bot, Dispatcher, types
from aiogram.filters import CommandStart, CommandObject, Command
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo, InlineQuery, InlineQueryResultArticle, InputTextMessageContent
from supabase import create_client, Client

# Load environment variables
load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# Environment configurations
BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
MINI_APP_URL = os.environ.get('MINI_APP_URL')
PORT = int(os.environ.get('PORT', 3001))
SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')

if not BOT_TOKEN:
    logger.error("TELEGRAM_BOT_TOKEN is required")
    sys.exit(1)

# Initialize Bot and Dispatcher
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# Initialize Supabase Admin client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# ============================================================
# Telegram Command Handlers
# ============================================================

@dp.message(CommandStart())
async def command_start_handler(message: types.Message, command: CommandObject):
    """
    Handles `/start` and `/start creator_<telegram_id>`
    """
    args = command.args or ""
    payload = args.strip()
    chat_id = message.chat.id

    # --- Default welcome (no payload) ---
    if not payload:
        markup = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="🚀 Open TipJar", web_app=WebAppInfo(url=MINI_APP_URL))
        ]])
        await bot.send_message(
            chat_id,
            "💰 *Welcome to TipJar!*\n\n"
            "The easiest way to send and receive crypto tips on Telegram.\n\n"
            "Are you a creator? Tap below to set up your TipJar profile.",
            parse_mode="Markdown",
            reply_markup=markup
        )
        return

    # --- Creator deep link: start=creator_<telegram_id> ---
    if payload.startswith("creator_"):
        creator_telegram_id = payload.replace("creator_", "")

        # Look up the creator in Supabase (run in thread to not block event loop)
        try:
            response = await asyncio.to_thread(
                lambda: supabase.table("creators")
                .select("id, display_name, username, avatar_url, goal_title, goal_target, balance_usd")
                .eq("telegram_id", creator_telegram_id)
                .execute()
            )
            creators = response.data
        except Exception as e:
            logger.error(f"Error querying creator: {e}")
            creators = []

        if not creators:
            await bot.send_message(chat_id, "❌ Creator not found. They may not have set up their TipJar yet.")
            return

        creator = creators[0]
        
        # Build the Mini App URL with the creator ID as a query param
        tip_url = f"{MINI_APP_URL}?creator={creator['id']}"
        
        display_name = creator.get('display_name', 'Creator')
        username = creator.get('username', 'creator')
        goal_title = creator.get('goal_title') or 'Creator Support'
        
        markup = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=f"❤️ Tip {display_name}", web_app=WebAppInfo(url=tip_url))
        ]])
        
        await bot.send_message(
            chat_id,
            f"💜 *Support {display_name}*\n\n"
            f"@{username} is accepting crypto tips on TipJar.\n\n"
            f"🎯 *Goal:* {goal_title}\n"
            f"Choose an amount and pay instantly using TON, USDT, ETH, TRX and more.",
            parse_mode="Markdown",
            reply_markup=markup
        )

@dp.inline_query()
async def inline_query_handler(inline_query: InlineQuery):
    """
    Handles inline queries like `@TipJarBot username` for instant tipping anywhere.
    """
    query = inline_query.query.strip().replace('@', '')
    
    if not query:
        # If no query, return empty or generic prompt (returning empty is standard)
        await inline_query.answer([], cache_time=10)
        return
        
    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("creators")
            .select("id, display_name, username, avatar_url, goal_title")
            .ilike("username", f"%{query}%")
            .limit(5)
            .execute()
        )
        creators = response.data
    except Exception as e:
        logger.error(f"Error querying inline query for {query}: {e}")
        creators = []
        
    results = []
    for creator in creators:
        display_name = creator.get('display_name', 'Creator')
        username = creator.get('username', 'creator')
        goal_title = creator.get('goal_title') or 'Creator Support'
        
        tip_url = f"{MINI_APP_URL}?creator={creator['id']}"
        
        markup = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=f"🔥 Tip {display_name}", web_app=WebAppInfo(url=tip_url))
        ]])
        
        result = InlineQueryResultArticle(
            id=str(creator['id']),
            title=f"Tip {display_name}",
            description=f"@{username} — {goal_title}",
            thumbnail_url=creator.get('avatar_url') or f"https://api.dicebear.com/7.x/adventurer/svg?seed={username}",
            input_message_content=InputTextMessageContent(
                message_text=f"🔥 *I just tipped {display_name}!* \n\nShow your support and help them reach their goal: {goal_title}",
                parse_mode="Markdown"
            ),
            reply_markup=markup
        )
        results.append(result)
        
    await inline_query.answer(results, cache_time=10)

@dp.message(Command("tip"))
async def command_tip_handler(message: types.Message, command: CommandObject):
    """
    Handles `/tip @username [amount]` or `/tip [amount]` as a reply
    """
    args = command.args
    target_username = None
    target_telegram_id = None
    amount = 5

    # Check if this is a reply tipping flow
    if message.reply_to_message:
        target_telegram_id = str(message.reply_to_message.from_user.id)
        if args:
            try:
                amount = float(args.strip())
            except ValueError:
                pass
    else:
        # Standard `/tip @username amount` flow
        if not args:
            await message.answer("❌ Usage: `/tip @username` or reply to a message with `/tip 5`", parse_mode="Markdown")
            return
            
        parts = args.split()
        target_username = parts[0].replace("@", "")
        
        if len(parts) > 1:
            try:
                amount = float(parts[1])
            except ValueError:
                pass
                
    try:
        # Look up creator by telegram_id (if reply) or username (if standard)
        if target_telegram_id:
            response = await asyncio.to_thread(
                lambda: supabase.table("creators")
                .select("id, display_name")
                .eq("telegram_id", target_telegram_id)
                .execute()
            )
        else:
            response = await asyncio.to_thread(
                lambda: supabase.table("creators")
                .select("id, display_name")
                .eq("username", target_username)
                .execute()
            )
        creators = response.data
    except Exception as e:
        logger.error(f"Error querying creator for tip: {e}")
        creators = []
        
    if not creators:
        target_name = target_username or "this user"
        await message.answer(f"❌ Creator {target_name} not found or hasn't set up TipJar.")
        return
        
    creator = creators[0]
    # Pass chat_id to the Mini App so we can announce it back to the group later
    chat_id = message.chat.id
    tip_url = f"{MINI_APP_URL}?creator={creator['id']}&amount={amount}&chat_id={chat_id}"
    
    markup = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text=f"🔥 Tip ${amount}", web_app=WebAppInfo(url=tip_url))
    ]])
    
    await message.answer(
        f"Ready to support {creator['display_name']}?\nTap the button below to send ${amount} instantly.",
        reply_markup=markup
    )

# --- Group Admin Commands ---

async def is_admin(message: types.Message) -> bool:
    if message.chat.type == "private":
        return True
    try:
        member = await bot.get_chat_member(message.chat.id, message.from_user.id)
        return member.status in ["creator", "administrator"]
    except Exception:
        return False

@dp.message(Command("enabletips"))
async def command_enabletips_handler(message: types.Message):
    if not await is_admin(message):
        await message.answer("❌ Only group admins can use this command.")
        return
    chat_id = str(message.chat.id)
    try:
        await asyncio.to_thread(
            lambda: supabase.table("group_settings").upsert({"chat_id": chat_id, "is_enabled": True}).execute()
        )
        await message.answer("✅ Tipping is now **ENABLED** in this group.", parse_mode="Markdown")
    except Exception as e:
        logger.error(f"Error enabling tips: {e}")
        await message.answer("❌ Error saving settings. Make sure the group_settings table exists.")

@dp.message(Command("disabletips"))
async def command_disabletips_handler(message: types.Message):
    if not await is_admin(message):
        await message.answer("❌ Only group admins can use this command.")
        return
    chat_id = str(message.chat.id)
    try:
        await asyncio.to_thread(
            lambda: supabase.table("group_settings").upsert({"chat_id": chat_id, "is_enabled": False}).execute()
        )
        await message.answer("🛑 Tipping is now **DISABLED** in this group.", parse_mode="Markdown")
    except Exception as e:
        logger.error(f"Error disabling tips: {e}")
        await message.answer("❌ Error saving settings.")

@dp.message(Command("setminimumtip"))
async def command_setminimumtip_handler(message: types.Message, command: CommandObject):
    if not await is_admin(message):
        await message.answer("❌ Only group admins can use this command.")
        return
        
    args = command.args
    if not args:
        await message.answer("❌ Usage: `/setminimumtip 5`", parse_mode="Markdown")
        return
        
    try:
        min_amount = float(args.strip())
        chat_id = str(message.chat.id)
        await asyncio.to_thread(
            lambda: supabase.table("group_settings").upsert({"chat_id": chat_id, "min_tip_amount": min_amount}).execute()
        )
        await message.answer(f"✅ Minimum tip for this group set to **${min_amount:,.2f}**.", parse_mode="Markdown")
    except ValueError:
        await message.answer("❌ Invalid amount. Use a number like 5 or 10.")
    except Exception as e:
        logger.error(f"Error setting minimum tip: {e}")
        await message.answer("❌ Error saving settings.")

@dp.message(Command("balance"))
async def command_balance_handler(message: types.Message):
    telegram_id = str(message.from_user.id)
    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("creators").select("balance_usd").eq("telegram_id", telegram_id).execute()
        )
        if response.data:
            balance = response.data[0].get('balance_usd') or 0
            await message.answer(f"💰 *Your Balance:* ${balance:,.2f}", parse_mode="Markdown")
        else:
            await message.answer("❌ You don't have a TipJar account yet. Use /start to create one.")
    except Exception as e:
        await message.answer("❌ Error retrieving balance.")

@dp.message(Command("withdraw"))
async def command_withdraw_handler(message: types.Message):
    markup = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="💸 Open Dashboard to Withdraw", web_app=WebAppInfo(url=MINI_APP_URL))
    ]])
    await message.answer("To withdraw your funds, please open your TipJar dashboard.", reply_markup=markup)

@dp.message(Command("profile"))
async def command_profile_handler(message: types.Message):
    telegram_id = str(message.from_user.id)
    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("creators").select("id, username").eq("telegram_id", telegram_id).execute()
        )
        if response.data:
            creator = response.data[0]
            link = f"https://t.me/TipJarBot?start=creator_{telegram_id}"
            await message.answer(f"🔗 *Your Public Tip Link:*\n\n{link}\n\nShare this in groups or your channel bio!", parse_mode="Markdown", disable_web_page_preview=True)
        else:
            await message.answer("❌ You don't have a TipJar account yet. Use /start to create one.")
    except Exception as e:
        await message.answer("❌ Error retrieving profile.")




# ============================================================
# Notification Helpers
# ============================================================

async def notify_creator(creator_telegram_id: str, tipper_name: str, amount: float, currency: str, message_text: str = None):
    """Sends a 'You received a tip!' message to the creator"""
    tipper = tipper_name or "Someone"
    
    lines = [
        "💰 *New Tip Received!*",
        "",
        f"{tipper} just tipped you *${float(amount):.2f}* in {currency}!"
    ]
    if message_text:
        lines.extend(["", f"💬 \"{message_text}\""])
    
    lines.extend(["", "Open your dashboard to see your updated balance."])
    
    markup = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="📊 View Dashboard", web_app=WebAppInfo(url=MINI_APP_URL))
    ]])
    
    try:
        await bot.send_message(
            chat_id=creator_telegram_id,
            text="\n".join(lines),
            parse_mode="Markdown",
            reply_markup=markup
        )
    except Exception as e:
        logger.error(f"Failed to notify creator {creator_telegram_id}: {e}")

async def notify_first_tip(creator_telegram_id: str, tipper_name: str, amount: float, currency: str):
    """Sends a first-tip special celebration to the creator"""
    tipper = tipper_name or "Your first supporter"
    
    markup = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🎊 Open Dashboard", web_app=WebAppInfo(url=MINI_APP_URL))
    ]])
    
    try:
        await bot.send_message(
            chat_id=creator_telegram_id,
            text=(
                "🎉 *Your First TipJar Tip!*\n\n"
                f"Congratulations! *{tipper}* just tipped you *${float(amount):.2f}* in {currency}!\n\n"
                "This is just the beginning — share your TipJar link to get more tips! 🚀"
            ),
            parse_mode="Markdown",
            reply_markup=markup
        )
    except Exception as e:
        logger.error(f"Failed to notify creator first tip {creator_telegram_id}: {e}")


async def notify_milestone(creator_telegram_id: str, milestone_amount: int):
    markup = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🎊 Open Dashboard", web_app=WebAppInfo(url=MINI_APP_URL))
    ]])
    try:
        await bot.send_message(
            chat_id=creator_telegram_id,
            text=f"🎉 *MILESTONE REACHED!* 🎉\n\nYou just crossed **${milestone_amount:,.2f}** in total support! Keep up the amazing work! 🚀",
            parse_mode="Markdown",
            reply_markup=markup
        )
    except Exception as e:
        logger.error(f"Failed to notify milestone {creator_telegram_id}: {e}")

async def announce_tip_to_group(chat_id: str, creator_name: str, tipper_name: str, amount: float, currency: str, creator_id: str):
    if not chat_id: return
    tip_url = f"{MINI_APP_URL}?creator={creator_id}"
    markup = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="❤️ Match Tip", web_app=WebAppInfo(url=tip_url))
    ]])
    try:
        await bot.send_message(
            chat_id=chat_id,
            text=f"🔥 *{tipper_name}* just tipped *{creator_name}* ${amount:,.2f} {currency}!\n\nShow your support too!",
            parse_mode="Markdown",
            reply_markup=markup
        )
    except Exception as e:
        logger.error(f"Error announcing to group {chat_id}: {e}")

async def handle_tip_notifications(creator, tip, current_balance: float, new_balance: float, completed_tips_count: int, chat_id: str = None):
    telegram_id = creator.get('telegram_id')
    tipper_name = tip.get('tipper_name') or "Someone"
    tip_usd_value = float(tip.get('usd_value') or 0)
    currency = tip.get('crypto_currency') or 'TON'
    creator_name = creator.get('display_name') or creator.get('username') or "Creator"
    
    # 1. Announce to public group if chat_id exists
    if chat_id:
        await announce_tip_to_group(chat_id, creator_name, tipper_name, tip_usd_value, currency, creator['id'])

    if not telegram_id:
        return
        
    # 2. Check Milestones
    milestones = [100, 1000, 10000]
    for ms in milestones:
        if current_balance < ms and new_balance >= ms:
            await notify_milestone(telegram_id, ms)
            break # Only notify highest crossed milestone
            
    # 3. Notify Creator
    if completed_tips_count == 1:
        await notify_first_tip(telegram_id, tipper_name, tip_usd_value, currency)
    else:
        message_text = tip.get('message')
        await notify_creator(telegram_id, tipper_name, tip_usd_value, currency, message_text)


# ============================================================
# Webhook Endpoints
# ============================================================

async def api_notify_tip(request: web.Request):
    """Called by the frontend Mini App when a TON Connect self-custody tip succeeds."""
    try:
        data = await request.json()
        tip_id = data.get('tip_id')
        chat_id = data.get('chat_id') # Optional, if initiated from a group
        
        if not tip_id:
            return web.Response(status=400, text="Missing tip_id")
            
        # Fetch tip and creator
        response = await asyncio.to_thread(
            lambda: supabase.table('tips')
            .select('*, creators(id, telegram_id, display_name, username, balance_usd)')
            .eq('id', tip_id)
            .eq('status', 'COMPLETED')
            .execute()
        )
        tips = response.data
        if not tips:
            return web.Response(status=404, text="Tip not found or not completed")
            
        tip = tips[0]
        creator = tip.get('creators')
        new_balance = float(creator.get('balance_usd') or 0)
        current_balance = new_balance - float(tip.get('usd_value') or 0) # approximate previous
        
        # Get exact count
        count_response = await asyncio.to_thread(
            lambda: supabase.table('tips')
            .select('id', count='exact')
            .eq('creator_id', creator['id'])
            .eq('status', 'COMPLETED')
            .execute()
        )
        count = count_response.count if count_response.count is not None else 1
        
        await handle_tip_notifications(creator, tip, current_balance, new_balance, count, chat_id)
        return web.json_response({"status": "success"})
    except Exception as e:
        logger.error(f"[API Notify Tip] Error: {e}")
        return web.Response(status=500)


async def cryptopay_webhook(request: web.Request):
    try:
        event = await request.json()
    except Exception:
        return web.Response(status=400)
    
    # Only handle paid invoices
    if event.get('update_type') != 'invoice_paid':
        return web.Response(status=200)
        
    invoice = event.get('payload', {})
    invoice_id = str(invoice.get('invoice_id'))
    amount = float(invoice.get('amount', 0))
    currency = invoice.get('asset')
    
    logger.info(f"[TipJar Webhook] Invoice paid: #{invoice_id} — {amount} {currency}")
    
    try:
        # 1. Find the matching PENDING tip record
        response = await asyncio.to_thread(
            lambda: supabase.table('tips')
            .select('*, creators(id, telegram_id, display_name, username, balance_usd)')
            .eq('invoice_id', invoice_id)
            .eq('status', 'PENDING')
            .execute()
        )
        tips = response.data
        
        if not tips:
            logger.warning(f"[TipJar Webhook] No PENDING tip found for invoice #{invoice_id}")
            return web.Response(status=200)
            
        tip = tips[0]
        creator = tip.get('creators')
        
        # 2. Mark tip as COMPLETED
        now_iso = datetime.now(timezone.utc).isoformat()
        await asyncio.to_thread(
            lambda: supabase.table('tips')
            .update({'status': 'COMPLETED', 'paid_at': now_iso})
            .eq('invoice_id', invoice_id)
            .execute()
        )
        
        # 3. Credit creator's virtual balance
        current_balance = float(creator.get('balance_usd') or 0)
        tip_usd_value = float(tip.get('usd_value') or 0)
        new_balance = current_balance + tip_usd_value
        
        await asyncio.to_thread(
            lambda: supabase.table('creators')
            .update({'balance_usd': new_balance})
            .eq('id', creator['id'])
            .execute()
        )
        
        # 4. Check if this is the creator's first tip
        count_response = await asyncio.to_thread(
            lambda: supabase.table('tips')
            .select('id', count='exact')
            .eq('creator_id', creator['id'])
            .eq('status', 'COMPLETED')
            .execute()
        )
        completed_tips_count = count_response.count if count_response.count is not None else 0
        
        # 5. Handle Notifications
        await handle_tip_notifications(creator, tip, current_balance, new_balance, completed_tips_count)
                
        logger.info(f"[TipJar Webhook] ✅ Tip #{invoice_id} completed. Creator balance: ${new_balance:.2f}")
        return web.Response(status=200)
        
    except Exception as e:
        logger.error(f"[TipJar Webhook] Error processing invoice #{invoice_id}: {e}")
        return web.Response(status=500)


# ============================================================
# Health Check
# ============================================================

async def health_check(request: web.Request):
    return web.json_response({"status": "ok", "app": "TipJar Bot (Python)"})


# ============================================================
# Application Startup
# ============================================================

async def main():
    # Setup aiohttp web application
    # Enable CORS for the frontend to call the API
    import aiohttp_cors
    app = web.Application()
    
    cors = aiohttp_cors.setup(app, defaults={
        "*": aiohttp_cors.ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
        )
    })
    
    cors.add(app.router.add_post('/api/notify_tip', api_notify_tip))
    app.router.add_post('/webhook/cryptopay', cryptopay_webhook)
    app.router.add_get('/health', health_check)
    
    # Start web server
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', PORT)
    await site.start()
    
    logger.info(f"[TipJar Bot] 🚀 Web server running on port {PORT}")
    logger.info(f"[TipJar Bot] Webhook: POST /webhook/cryptopay")
    logger.info(f"[TipJar Bot] Mini App: {MINI_APP_URL}")
    
    # Start bot polling
    logger.info("[TipJar Bot] Starting Telegram bot polling...")
    try:
        await dp.start_polling(bot)
    finally:
        await runner.cleanup()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        logger.info("[TipJar Bot] Stopped.")
