// TipJar — Main App Entry Point
import './polyfills.js';
import { supabase } from './src/lib/supabase.js';
import { initTelegramAuth } from './src/lib/auth.js';
import { getCreatorTips, createTipRecord, updateCreator, subscribeToPublicTips, getAnalyticsMetrics, requestWithdrawal } from './src/lib/db.js';
import { TonConnectUI } from '@tonconnect/ui';
import { beginCell } from '@ton/core';

// The authenticated creator record from Supabase (populated on load)
let dbCreator = null;
let tonConnectUI = null;

// Application State
const state = {
  currentStep: 1,
  selectedInterests: [],
  selectedAmount: 5,
  customAmount: '',
  selectedMethod: 'usdt',
  balance: 0,
  notifications: [], // Will be populated from Supabase
  liveFeed: [], // Public live feed
  creator: {
    name: 'Loading...',
    handle: '@...',
    avatar: 'https://api.dicebear.com/7.x/adventurer/svg?seed=TipJar'
  },
  onboardingTimer: null,
  isScratching: false,
  tickets: 5,
  currentGame: null,
  rewards: {
    scratch: 45,
    wheel: 100
  },
  thankYouMessage: "Thanks for the support! It means the world to me. Keep being awesome!",
  selectedMessage: '',
  walletAddress: "",
  tonAddress: null,
  goal: {
    title: 'My Creator Goal',
    current: 0,
    target: 1000
  },
  liveSimTimer: null,
  chatId: null, // Stores the Telegram chat ID if tipped from a group
  userRole: 'VIEWER', // 'OWNER' or 'VIEWER'
  interests: []
};

// --- App Controller ---
const App = {
  init() {
    this.bindEvents();
    this.initTonConnect();
    this.initRealtimeFeed();
    if (window.lucide) window.lucide.createIcons();
  },

  initRealtimeFeed() {
    subscribeToPublicTips((newTip) => {
      // Add to live feed state
      const amt = parseFloat(newTip.usd_value).toFixed(2);
      const name = newTip.tipper_name || 'Someone';
      const toastText = `🔥 ${name} tipped $${amt}`;
      
      // Update state and UI
      state.liveFeed.unshift({ text: toastText, id: newTip.id });
      if (state.liveFeed.length > 50) state.liveFeed.pop();
      
      // Show toast to active viewers
      showToast(toastText);
      
      // If it's a tip to the current creator, update notifications and balance if not already done locally
      if (dbCreator && newTip.creator_id === dbCreator.id) {
        // Refresh analytics
        updateDynamicUI();
      }
    });
  },

  initTonConnect() {
    try {
      const basePath = import.meta.env.BASE_URL || '/';
      const manifestPath = new URL('tonconnect-manifest.json', `${window.location.origin}${basePath}`).href;
      console.log('[TipJar] 📦 Initializing TON Connect with manifest:', manifestPath);
      window.TipJarTonConnectManifestUrl = manifestPath;
      window.TipJarTonConnectDebug = {
        origin: window.location.origin,
        basePath,
        manifestPath,
        envBaseUrl: import.meta.env.BASE_URL
      };

      tonConnectUI = new TonConnectUI({
        manifestUrl: manifestPath,
        buttonRootId: 'ton-connect-wrapper'
      });

      // Force QR code modal on desktop to avoid protocol link errors
      tonConnectUI.uiOptions = {
        twaReturnUrl: 'https://t.me/TipJarBot'
      };

      tonConnectUI.onStatusChange(async (wallet) => {
        if (wallet) {
          state.tonAddress = wallet.account.address;
          console.log('[TipJar] 👛 Wallet Connected:', state.tonAddress);
          
          // If the user is on the payment screen, refresh the UI and trigger payment now.
          // This is safe because the user just completed a wallet connect action.
          if (state.currentStep === 6) {
            nextStep(6); // Refresh UI to show Confirm button
            setTimeout(() => {
              if (tonConnectUI?.connected) {
                App.handleTonPayment();
              }
            }, 100);
          }
        } else {
          state.tonAddress = null;
          console.log('[TipJar] 👛 Wallet Disconnected');
        }
      });
    } catch (err) {
      console.warn('[TipJar] TonConnect Initialization Error:', err);
    }
  },

  // Centralized Payment Logic
  async handleTonPayment() {
    const statusEl = document.getElementById('receipt-status');
    const sendTxBtn = document.getElementById('send-tx-btn');
    const doneBtn = document.getElementById('receipt-done-btn');
    const connectWrapper = document.getElementById('ton-connect-wrapper');
    const txIdEl = document.getElementById('receipt-tx-id');

    try {
      const MERCHANT_ADDRESS = import.meta.env.VITE_MERCHANT_ADDRESS || 'UQApmfWYM1_cftB0aGSarN5s4DALmoBT0KTaDMKPHaTXvJg1';
      
      // 1. Update UI to PENDING
      if (statusEl) { statusEl.innerText = 'PROCESSING...'; statusEl.style.color = '#F79F1A'; }
      if (txIdEl) txIdEl.innerText = 'Calculating TON amount...';
      showLoadingOverlay(true, 'Calculating payment...');
      
      if (sendTxBtn) {
        sendTxBtn.innerHTML = 'Processing... <div class="spinner-custom" style="width: 18px; height: 18px; border-width: 2px;"></div>';
        sendTxBtn.style.opacity = '0.7';
        sendTxBtn.style.pointerEvents = 'none';
      }

      if (!tonConnectUI.connected) {
        showLoadingOverlay(false);
        showToast('Please connect your wallet first.');
        nextStep(6);
        return;
      }

      // 2. Fetch live TON/USD price
      let tonPriceUsd = 2.50; // Fallback price
      try {
        const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
        const priceData = await priceRes.json();
        if (priceData['the-open-network']?.usd) {
          tonPriceUsd = priceData['the-open-network'].usd;
        }
        console.log('[TipJar] TON Price:', tonPriceUsd);
      } catch (priceErr) {
        console.warn('[TipJar] Could not fetch TON price, using fallback $' + tonPriceUsd);
      }

      // 3. Calculate correct TON amount (in nanoTON: 1 TON = 1,000,000,000 nanoTON)
      const usdAmount = state.selectedAmount;
      const tonAmount = usdAmount / tonPriceUsd;
      const nanoTonAmount = Math.ceil(tonAmount * 1_000_000_000).toString();
      
      console.log(`[TipJar] Tip: $${usdAmount} = ${tonAmount.toFixed(4)} TON (${nanoTonAmount} nanoTON)`);
      if (txIdEl) txIdEl.innerText = `Sending ${tonAmount.toFixed(4)} TON (~$${usdAmount.toFixed(2)})...`;

      // Build the comment payload
      const tipper = state.tipperName || 'Supporter';
      const comment = `TipJar Support from ${tipper}`;
      const payloadCell = beginCell().storeUint(0, 32).storeStringTail(comment).endCell();
      const payloadBoc = payloadCell.toBoc().toString('base64');

      // 4. Build and send the transaction
      showLoadingOverlay(true, 'Waiting for wallet signature...');

      const transaction = {
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [
          {
            address: MERCHANT_ADDRESS,
            amount: nanoTonAmount,
            payload: payloadBoc
          }
        ]
      };

      console.log('[TipJar] Sending Transaction:', transaction);
      const result = await tonConnectUI.sendTransaction(transaction);
      console.log('[TipJar] TON Payment Success:', result);
      
      showLoadingOverlay(false);

      // 5. Update Receipt to SUCCESS
      const txHash = result.boc || `TON_${Date.now()}`;
      if (statusEl) { statusEl.innerText = 'CONFIRMED'; statusEl.style.color = '#10B981'; }
      if (txIdEl) txIdEl.innerText = txHash;
      if (doneBtn) doneBtn.style.display = 'block';
      if (sendTxBtn) sendTxBtn.style.display = 'none';
      if (connectWrapper) connectWrapper.style.display = 'none';
      
      // Update Success Screen Info
      const successAmountEl = document.getElementById('success-amount');
      const successCreatorEl = document.getElementById('success-creator-name');
      if (successAmountEl) successAmountEl.innerText = usdAmount.toFixed(2);
      if (successCreatorEl) successCreatorEl.innerText = state.creator.name;

      // Show Confetti and Go to Success Screen
      showConfetti();
      nextStep(13);
      App.playLottie('lottie-container-success', '/coin-jar.json'); 
      
      // Play Success Sound
      const sound = document.getElementById('success-sound');
      if (sound) {
        sound.volume = 0.5;
        sound.play().catch(e => console.log('Audio autoplay prevented', e));
      } 
      
      state.balance += usdAmount;
      updateDynamicUI();

      // 6. Record in DB
      const targetId = state.selectedCreatorId || (dbCreator ? dbCreator.id : null);
      if (targetId) {
        try {
          const tipRecord = await createTipRecord({
            creatorId: targetId,
            tipperName: state.tipperName || 'Supporter',
            message: state.selectedMessage || '',
            currency: 'TON',
            cryptoAmount: tonAmount,
            usdValue: usdAmount,
            invoiceId: txHash,
            payUrl: '',
            status: 'COMPLETED'
          });

          // Ping the Telegram Bot so it can announce the tip and check milestones
          const botApiUrl = import.meta.env.VITE_BOT_API_URL || 'https://tipjar-production.up.railway.app';
          try {
            await fetch(`${botApiUrl}/api/notify_tip`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                tip_id: tipRecord.id,
                chat_id: state.chatId
              })
            });
            console.log('[TipJar] Bot notified successfully');
          } catch (apiErr) {
            console.warn('[TipJar] Could not ping bot API:', apiErr.message);
          }
        } catch (dbErr) {
          console.warn('[TipJar] Could not save tip to DB:', dbErr.message);
        }
      }
    } catch (err) {
      showLoadingOverlay(false);
      console.error('[TipJar] Payment Error:', err);
      
      // Update Receipt to FAILED
      if (statusEl) { statusEl.innerText = 'FAILED'; statusEl.style.color = '#EF4444'; }
      if (txIdEl) txIdEl.innerText = err.message || 'Transaction was rejected or timed out.';
      
      // Restore button for retry
      if (sendTxBtn) {
        sendTxBtn.innerHTML = 'Retry Payment <i data-lucide="refresh-cw" style="width: 18px; height: 18px; margin-left: 8px;"></i>';
        sendTxBtn.style.opacity = '1';
        sendTxBtn.style.pointerEvents = 'auto';
        if (window.lucide) window.lucide.createIcons();
      }

      // Update header to guide user
      const headerTitle = document.querySelector('#awaiting-header h1');
      const headerText = document.querySelector('#awaiting-header p');
      if (headerTitle) headerTitle.innerText = 'Payment Failed';
      if (headerText) headerText.innerText = 'The transaction was rejected. You can try again below.';

      showToast('Payment rejected or timed out.');
    }
  },

  async disconnectWallet() {
    if (tonConnectUI) {
      await tonConnectUI.disconnect();
      nextStep(6); // Refresh step 6 UI
    }
  },

  // Load Recent Supporters for the Profile Wall
  async loadRecentSupporters() {
    const list = document.getElementById('supporters-list');
    const countEl = document.getElementById('supporter-count');
    const creatorId = state.selectedCreatorId || (dbCreator ? dbCreator.id : null);
    
    if (!list || !creatorId) return;

    try {
      const { data: tips, error } = await supabase
        .from('tips')
        .select('*')
        .eq('creator_id', creatorId)
        .eq('status', 'COMPLETED')
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) throw error;

      if (countEl) countEl.innerText = `${tips.length} Tippers`;

      if (tips.length === 0) {
        list.innerHTML = `
          <div style="min-width: 140px; padding: 16px; background: #F9FAFB; border-radius: 20px; border: 1px dashed #E5E7EB; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;">
            <div style="width: 32px; height: 32px; background: #F3F4F6; border-radius: 50%; margin-bottom: 8px; display: flex; align-items: center; justify-content: center;">
              <i data-lucide="users" style="width: 16px; height: 16px; color: #9CA3AF;"></i>
            </div>
            <div style="font-size: 10px; color: #9CA3AF; font-weight: 600;">Be the first!</div>
          </div>
        `;
        if (countEl) countEl.innerText = `0 Tippers`;
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      list.innerHTML = tips.map(tip => `
        <div style="min-width: 160px; padding: 16px; background: #FFFFFF; border: 1px solid #F3F4F6; border-radius: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.02); display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <img src="https://api.dicebear.com/7.x/adventurer/svg?seed=${tip.tipper_name}" style="width: 28px; height: 28px; border-radius: 50%; background: #F3F4F6;">
            <div>
              <div style="font-size: 12px; font-weight: 800; color: #111827;">${tip.tipper_name}</div>
              <div style="font-size: 10px; color: #10B981; font-weight: 700;">$${tip.amount_usd}</div>
            </div>
          </div>
          ${tip.message ? `<div style="font-size: 11px; color: #6B7280; line-height: 1.4; font-style: italic; background: #F9FAFB; padding: 8px 12px; border-radius: 14px;">"${tip.message}"</div>` : ''}
          <button onclick="window.selectTip(${tip.amount_usd}); document.getElementById('step-4').scrollIntoView({behavior: 'smooth'})" style="width: 100%; padding: 6px; background: #F9FAFB; color: #111827; border: 1px solid #E5E7EB; border-radius: 10px; font-size: 11px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 4px;"><i data-lucide="plus" style="width: 12px; height: 12px;"></i> Match</button>
        </div>
      `).join('');
    } catch (err) {
      console.warn('[TipJar] Error loading supporters:', err);
    }
  },

  async loadTopSupporters() {
    const list = document.getElementById('supporters-list');
    if (!list) return;

    const creatorId = state.selectedCreatorId || (dbCreator ? dbCreator.id : null);
    if (!creatorId) {
      list.innerHTML = `<div style="text-align: center; padding: 40px 20px; color: #6B7280;">Select a creator to see top supporters.</div>`;
      return;
    }

    try {
      const { data: tips, error } = await supabase
        .from('tips')
        .select('id, tipper_name, usd_value, paid_at, message')
        .eq('creator_id', creatorId)
        .eq('status', 'COMPLETED')
        .order('usd_value', { ascending: false })
        .limit(12);

      if (error) throw error;

      if (!tips || tips.length === 0) {
        list.innerHTML = `<div style="text-align: center; padding: 40px 20px; color: #6B7280;">No supporters yet. Share your link and get your first tip!</div>`;
        return;
      }

      list.innerHTML = tips.map((tip, idx) => `
        <div class="method-card" style="padding: 18px; border-radius: 20px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div style="display: flex; gap: 12px; align-items: center;">
            <div style="width: 42px; height: 42px; border-radius: 50%; background: #F3F4F6; display: flex; align-items: center; justify-content: center; font-weight: 700; color: #111827;">${idx + 1}</div>
            <div>
              <div style="font-weight: 700; color: #111827;">${tip.tipper_name || 'Supporter'}</div>
              <div style="font-size: 11px; color: #6B7280;">${tip.paid_at ? new Date(tip.paid_at).toLocaleDateString() : 'Just now'}</div>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-weight: 800; color: #10B981;">+$${parseFloat(tip.usd_value || 0).toFixed(2)}</div>
            ${tip.message ? `<div style="font-size: 11px; color: #6B7280; margin-top: 4px;">"${tip.message.length > 40 ? tip.message.slice(0, 40) + '...' : tip.message}"</div>` : ''}
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.warn('[TipJar] Error loading top supporters:', err);
      list.innerHTML = `<div style="text-align: center; padding: 40px 20px; color: #EF4444;">Unable to load supporters right now.</div>`;
    }
  },

  // Lottie Helper
  playLottie(containerId, path) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // Clear previous
    container.innerHTML = '';
    
    if (window.lottie) {
      window.lottie.loadAnimation({
        container: container,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        path: path
      });
    }
  },

  bindEvents() {
    window.addEventListener('popstate', () => {
      // Basic back navigation handling
    });
  },

  render() {
    // Show correct screen
    const screens = document.querySelectorAll('.screen');
    screens.forEach(s => {
      s.classList.add('hidden');
      s.style.opacity = '0';
      s.style.transform = 'translateY(10px)';
    });

    const activeScreen = document.getElementById(`step-${state.currentStep}`);
    if (activeScreen) {
      activeScreen.classList.remove('hidden');
      activeScreen.style.opacity = '1';
      activeScreen.style.transform = 'translateY(0)';
      
      // Update icons for the newly shown screen
      if (window.lucide) window.lucide.createIcons();
    }

    updateDynamicUI();
  }
};
window.nextStep = async (step) => {
  if (step === state.currentStep) return;

  const currentScreen = document.getElementById(`step-${state.currentStep}`);
  const nextScreen = document.getElementById(`step-${step}`);
  
  if (!nextScreen) return;

  // Route Guarding: Viewers cannot access creator-only screens
  const creatorOnlySteps = [7, 8, 9, 10, 11, 12];
  if (state.userRole === 'VIEWER' && creatorOnlySteps.includes(step)) {
    console.warn(`[TipJar] Blocked access to step ${step} for VIEWER role.`);
    return;
  }

  // Update state
  state.currentStep = step;

  // Clear any existing onboarding timer
  if (state.onboardingTimer) {
    clearTimeout(state.onboardingTimer);
    state.onboardingTimer = null;
  }

  // If authenticated as a creator, skip onboarding steps 1-3
  if (dbCreator && step > 1 && step < 4) {
    state.currentStep = 7;
  }

  transitionScreen(currentScreen, document.getElementById(`step-${state.currentStep}`));

  // Step 4 — Load Recent Supporters for the Wall
  if (step === 4) {
    App.loadRecentSupporters();
    
    // Start Simulated Live Activity
    if (state.liveSimTimer) clearInterval(state.liveSimTimer);
    state.liveSimTimer = setInterval(() => {
      const viewers = Math.floor(Math.random() * 8) + 2;
      if (window.showToast) window.showToast(`👀 ${viewers} people are viewing this profile right now`);
    }, 15000); // Every 15s show toast
  } else {
    if (state.liveSimTimer) {
      clearInterval(state.liveSimTimer);
      state.liveSimTimer = null;
    }
  }

  if (step === 8) {
    App.loadTopSupporters();
  }

  // Step 6 — Payment Logic (TON Wallet Exclusive)
  if (step === 6) {
    const sendTxBtn = document.getElementById('send-tx-btn');
    const doneBtn = document.getElementById('receipt-done-btn');
    const connectWrapper = document.getElementById('ton-connect-wrapper');
    const statusEl = document.getElementById('receipt-status');
    const methodEl = document.getElementById('receipt-method');
    const txEl = document.getElementById('receipt-tx-id');

    // Capture Message
    const msgInput = document.getElementById('tip-message');
    if (msgInput) state.selectedMessage = msgInput.value;

    const receiptMsgContainer = document.getElementById('receipt-message-container');
    const receiptMsgText = document.getElementById('receipt-message-text');
    if (state.selectedMessage && receiptMsgContainer && receiptMsgText) {
      receiptMsgContainer.style.display = 'block';
      receiptMsgText.innerText = state.selectedMessage;
    } else if (receiptMsgContainer) {
      receiptMsgContainer.style.display = 'none';
    }

    // Initial Defaults
    if (methodEl) methodEl.innerText = 'TON Wallet';
    if (txEl) txEl.innerText = 'Self-Custody Transfer';
    if (doneBtn) doneBtn.style.display = 'none';

    // Connection Check & UI Toggle
    const isConnected = tonConnectUI && tonConnectUI.connected;
    
    if (isConnected) {
      if (sendTxBtn) {
        sendTxBtn.style.display = 'flex';
        sendTxBtn.classList.add('pulse-ready');
        sendTxBtn.onclick = () => App.handleTonPayment();
      }
      if (statusEl) { statusEl.innerText = 'READY TO SIGN'; statusEl.style.color = '#3B82F6'; }
      if (connectWrapper) connectWrapper.style.display = 'none';
      
      // Update method with address
      if (methodEl) {
        const addr = state.tonAddress;
        const truncated = addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : 'Connected';
        methodEl.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px;">
            <span>${truncated}</span>
            <button onclick="App.disconnectWallet()" style="background: #F3F4F6; border: none; padding: 4px 8px; border-radius: 8px; font-size: 10px; font-weight: 700; color: #6B7280; cursor: pointer;">Change</button>
          </div>
        `;
      }

      const headerTitle = document.querySelector('#awaiting-header h1');
      const headerText = document.querySelector('#awaiting-header p');
      if (headerTitle) headerTitle.innerText = 'Confirm Payment';
      if (headerText) headerText.innerText = 'Wallet linked! Tap confirm to sign the transaction.';

      // AUTO-TRIGGER (Synchronous)
      // Since this block is reached via a physical tap from Step 5 ("Proceed to Checkout"),
      // we can synchronously trigger the payment without getting blocked.
      console.log('[TipJar] ⚡ Already connected. Auto-triggering synchronously...');
      App.handleTonPayment();
    } else {
      if (sendTxBtn) {
        sendTxBtn.style.display = 'none';
        sendTxBtn.classList.remove('pulse-ready');
      }
      if (connectWrapper) connectWrapper.style.display = 'flex';
      if (statusEl) { statusEl.innerText = 'LINK WALLET'; statusEl.style.color = '#F79F1A'; }

      const headerTitle = document.querySelector('#awaiting-header h1');
      const headerText = document.querySelector('#awaiting-header p');
      if (headerTitle) headerTitle.innerText = 'Connect Wallet';
      if (headerText) headerText.innerText = 'Connect your TON wallet to sign the transaction.';
    }

    transitionScreen(currentScreen, nextScreen);
    state.currentStep = step;

    // Update Bottom Nav Active State
    document.querySelectorAll('.nav-item').forEach((item, idx) => {
      const steps = [7, 8, 4, 9];
      item.classList.toggle('active', steps[idx] === step);
    });

    triggerHaptic('light');
    return;
  }

  if (step === 7) {
    localStorage.setItem('tipjar_onboarded', 'true');
    transitionScreen(currentScreen, nextScreen);
    if (window.animateGoal) setTimeout(window.animateGoal, 400);
  } else {
    transitionScreen(currentScreen, nextScreen);
    
    // Populate Settings share link dynamically
    if (step === 9 && window.updateSettingsShareLink) {
      window.updateSettingsShareLink();
    }

    // Auto-advance logic for onboarding (Steps 1, 2, 3)
    if (step < 4) {
      if (step === 1) App.playLottie('lottie-container-welcome', '/coin-jar.json');
      if (step === 3) App.playLottie('lottie-container-ready', '/coin-jar.json');
      startOnboardingTimer(step);
    }

    if (step === 12) {
      if (state.currentGame === 'wheel') {
        setTimeout(initFortuneWheelGame, 400);
      } else {
        setTimeout(initPhaserScratchGame, 400);
      }
    }
  }
  
  state.currentStep = step;

  // Update Bottom Nav Active State
  document.querySelectorAll('.nav-item').forEach((item, idx) => {
    // Indices based on HTML order: 0: Home(7), 1: Supporters(8), 2: Public(4), 3: Settings(9)
    const steps = [7, 8, 4, 9];
    item.classList.toggle('active', steps[idx] === step);
  });
};

const startOnboardingTimer = (step) => {
  const fill = document.getElementById(`fill-${step}`);
  const fillStep2 = document.getElementById(`fill-2`);
  const fillStep3 = document.getElementById(`fill-3`);

  // Reset all bars on current screen
  document.querySelectorAll('.onboarding-progress-fill').forEach(f => f.classList.remove('active'));

  setTimeout(() => {
    if (step === 1) {
      document.getElementById('fill-1')?.classList.add('active');
    } else if (step === 2) {
      document.getElementById('fill-2')?.classList.add('active');
    } else if (step === 3) {
      document.getElementById('fill-3')?.classList.add('active');
    }
  }, 100);

  state.onboardingTimer = setTimeout(() => {
    if (step === 1) {
      nextStep(2);
    } else if (step === 2) {
      nextStep(3);
    } else if (step === 3) {
      nextStep(7); // Go to Dashboard
    }
  }, 3000);
};

const transitionScreen = (from, to) => {
  if (from) {
    from.style.opacity = '0';
    from.style.transform = 'translateY(10px)';
    setTimeout(() => from.classList.add('hidden'), 300);
  }

  setTimeout(() => {
    to.classList.remove('hidden');
    setTimeout(() => {
      to.style.opacity = '1';
      to.style.transform = 'translateY(0)';
      if (window.lucide) window.lucide.createIcons();
      updateDynamicUI();
    }, 50);
  }, 300);
  
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// --- Interactions ---
window.toggleInterest = (btn, interest) => {
  const index = state.selectedInterests.indexOf(interest);
  if (index > -1) {
    state.selectedInterests.splice(index, 1);
    btn.classList.remove('selected');
  } else {
    state.selectedInterests.push(interest);
    btn.classList.add('selected');
  }
};

window.selectTip = (amount) => {
  state.selectedAmount = amount;
  state.customAmount = '';
  document.getElementById('custom-amount').value = '';
  updateTipUI();
  triggerHaptic('light');
};

window.handleCustomAmount = (val) => {
  let amount = parseFloat(val) || 0;
  if (amount < 0) {
    amount = 0;
    document.getElementById('custom-amount').value = '';
  }
  state.selectedAmount = amount;
  state.customAmount = val < 0 ? '' : val;
  document.querySelectorAll('.tip-card').forEach(c => c.classList.remove('active'));
  updateTipUI();
};

window.selectMethod = (method) => {
  state.selectedMethod = method;
  document.querySelectorAll('.payment-methods .method-card').forEach(c => {
    c.classList.toggle('active', c.dataset.method === method);
    const radio = c.querySelector('.radio');
    if (radio) radio.classList.toggle('active', c.dataset.method === method);
  });
};

window.copyToClipboard = (text) => {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Link copied to clipboard!');
  });
};

window.openWithdrawModal = () => {
  const modal = document.getElementById('withdraw-modal');
  if(modal) modal.classList.add('visible');
};

window.openQRModal = () => {
  const modal = document.getElementById('qr-modal');
  if(modal) modal.classList.add('visible');
};

window.openGoalModal = () => {
  const modal = document.getElementById('goal-modal');
  if(modal) modal.classList.add('visible');
};

window.closeModal = (e, modalId) => {
  const modal = document.getElementById(modalId || 'withdraw-modal'); // fallback for legacy calls
  if (!modal) return;
  if (!e || e.target === modal) {
    modal.classList.remove('visible');
  }
};

window.saveGoal = () => {
  const title = document.getElementById('goal-title-input').value;
  const target = document.getElementById('goal-target-input').value;
  
  if (title && target) {
    state.goal.title = title;
    state.goal.target = parseFloat(target);
    updateDynamicUI();
    showToast('Goal updated successfully!');
    closeModal(null, 'goal-modal');
    if (window.animateGoal) window.animateGoal(); // re-animate with new values
  }
};

window.confirmWithdraw = async () => {
  if (state.balance < 10) {
    showToast('Minimum withdrawal is $10.00');
    closeModal(null, 'withdraw-modal');
    return;
  }

  if (!state.walletAddress || state.walletAddress === '0x71C...39A2') {
    closeModal(null, 'withdraw-modal');
    showToast('Please set a payout wallet in Settings first.');
    nextStep(9);
    return;
  }
  const modal = document.getElementById('withdraw-modal');
  if (modal) modal.classList.remove('visible');
  showLoadingOverlay(true, 'Submitting withdrawal request...');

  try {
    const creatorId = dbCreator?.id;
    if (creatorId) {
      const { requestWithdrawal } = await import('./src/lib/db.js');
      await requestWithdrawal(creatorId, {
        grossAmount: state.balance,
        wallet: state.walletAddress,
        currency: 'TON'
      });
    }
    state.balance = 0;
    showLoadingOverlay(false);
    showToast('Withdrawal request submitted! Funds will be sent shortly.');
    updateDynamicUI();
  } catch (err) {
    console.error('[TipJar] Withdrawal error:', err);
    showLoadingOverlay(false);
    showToast('Withdrawal failed. Please try again.');
  }
};

window.savePayoutWallet = async () => {
  const input = document.getElementById('payout-wallet-input');
  const address = input?.value?.trim();
  if (!address || address.length < 10) {
    showToast('Please enter a valid wallet address.');
    return;
  }

  state.walletAddress = address;

  // Persist to Supabase if logged in
  if (dbCreator) {
    try {
      await updateCreator(dbCreator.id, { withdrawal_wallet: address });
      dbCreator.withdrawal_wallet = address;
    } catch (e) {
      console.warn('[TipJar] Could not save wallet to DB:', e.message);
    }
  }

  // Update UI
  const notSet = document.getElementById('wallet-not-set');
  const savedDisplay = document.getElementById('wallet-saved-display');
  const addressDisplay = document.getElementById('wallet-address-display');
  if (notSet) notSet.style.display = 'none';
  if (savedDisplay) savedDisplay.style.display = 'block';
  if (addressDisplay) addressDisplay.innerText = address;

  showToast('✅ Payout wallet saved!');
};

window.toggleDropdown = () => {
  const dropdown = document.getElementById('leaderboard-dropdown');
  dropdown.classList.toggle('visible');
};

window.selectFilter = (filter) => {
  document.getElementById('current-filter').innerText = filter;
  document.getElementById('leaderboard-dropdown').classList.remove('visible');
  showToast(`Showing data for ${filter}`);
};

// --- Arcade & Game Control ---
window.spendToPlay = (cost) => {
  if (state.tickets >= cost) {
    state.tickets -= cost;
    updateDynamicUI();
    return true;
  } else {
    // Check if they have balance to buy tickets
    if (state.balance >= 10) {
      if (confirm("Out of tickets! Buy 5 tickets for $10.00?")) {
        state.balance -= 10;
        state.tickets += 5;
        showToast("Purchased 5 tickets!");
        updateDynamicUI();
        return true;
      }
    } else {
      showToast("Insufficient tickets! Tip a creator to earn more.");
    }
    return false;
  }
};

window.startFortuneWheel = () => {
  if (spendToPlay(1)) {
    state.currentGame = 'wheel';
    nextStep(12);
    setTimeout(initFortuneWheelGame, 400);
  }
};

window.startScratchCard = () => {
  if (spendToPlay(1)) {
    state.currentGame = 'scratch';
    nextStep(12);
  }
};

window.saveThankYouMessage = () => {
  const msg = document.querySelector('#step-9 textarea').value;
  state.thankYouMessage = msg;
  showToast("Thank you message saved!");
};

window.changeWallet = () => {
  const newWallet = prompt("Enter new wallet address:", state.walletAddress);
  if (newWallet) {
    state.walletAddress = newWallet;
    updateDynamicUI();
    showToast("Wallet updated successfully!");
  }
};

window.connectTON = async () => {
  if (!tonConnectUI) {
    showToast('TON Connect not initialized yet.');
    return;
  }

  if (tonConnectUI.connected) {
    showToast('Wallet already connected.');
    return;
  }

  showLoadingOverlay(true, 'Opening TON wallet...');
  try {
    if (typeof tonConnectUI.connect === 'function') {
      await tonConnectUI.connect();
    } else if (typeof tonConnectUI.connectWallet === 'function') {
      await tonConnectUI.connectWallet();
    } else if (typeof tonConnectUI.requestConnection === 'function') {
      await tonConnectUI.requestConnection();
    } else {
      throw new Error('TON Connect API not available');
    }

    showLoadingOverlay(false);
    showToast('TON Wallet connected!');
    updateDynamicUI();
  } catch (err) {
    showLoadingOverlay(false);
    console.warn('[TipJar] TON connect failed:', err);
    showToast('Unable to connect TON wallet. Please try again.');
  }
};

// --- Scratch Card Logic ---
// --- Phaser Scratch Game Logic ---
let phaserGame = null;

window.initPhaserScratchGame = () => {
  if (phaserGame) {
    phaserGame.destroy(true);
    phaserGame = null;
  }

  const config = {
    type: Phaser.AUTO,
    width: 480,
    height: window.innerHeight,
    parent: 'phaser-game-container',
    transparent: true,
    scene: {
      create: createScene,
      update: updateScene
    }
  };

  phaserGame = new Phaser.Game(config);
};

function createScene() {
  const scene = this;
  const width = scene.scale.width;
  const height = scene.scale.height;

  // Background cartoonish vibe
  scene.add.circle(width/2, height/2, 200, 0xFFF7ED, 1);
  
  // The Reward (Underneath)
  const rewardGroup = scene.add.container(width/2, height/2 - 50);
  const cardBg = scene.add.rectangle(0, 0, 320, 200, 0xFFFFFF).setStrokeStyle(4, 0xF79F1A);
  const winText = scene.add.text(0, -40, 'YOU WON!', { font: 'bold 16px Outfit', color: '#6B7280' }).setOrigin(0.5);
  const priceText = scene.add.text(0, 10, '$45.00', { font: 'bold 56px Outfit', color: '#F79F1A' }).setOrigin(0.5);
  const detailText = scene.add.text(0, 50, 'CREDITED TO BALANCE', { font: 'bold 12px Outfit', color: '#10B981' }).setOrigin(0.5);
  rewardGroup.add([cardBg, winText, priceText, detailText]);
  rewardGroup.setScale(0);

  // The Scratch Layer
  const renderTexture = scene.make.renderTexture({ width: 320, height: 200 }, false);
  renderTexture.fill(0xC0C0C0, 1);
  // Add some cartoon dots to texture
  for(let i=0; i<50; i++) {
    renderTexture.draw(scene.add.circle(0,0,2, 0xFFFFFF, 0.2), Math.random()*320, Math.random()*200);
  }
  
  const scratchCard = scene.add.image(width/2, height/2 - 50, renderTexture);
  scratchCard.setInteractive();

  // Sparkle Particles
  const sparkles = scene.add.particles(0, 0, 'sparkle', {
    active: false,
    speed: { min: 50, max: 150 },
    scale: { start: 0.6, end: 0 },
    blendMode: 'ADD',
    lifespan: 600,
    gravityY: 100
  });

  // Create a simple star texture for sparkles since we don't have assets
  const graphics = scene.make.graphics({ x: 0, y: 0, add: false });
  graphics.fillStyle(0xFFFFFF, 1);
  graphics.fillCircle(4, 4, 4);
  graphics.generateTexture('sparkle', 8, 8);

  let revealedPixels = 0;
  const totalArea = 320 * 200;

  scene.input.on('pointermove', (pointer) => {
    if (pointer.isDown) {
      const x = pointer.x - (width/2 - 160);
      const y = pointer.y - (height/2 - 150);

      // Erase from texture
      renderTexture.erase(scene.add.circle(0, 0, 30, 0x000, 1), x, y);
      
      // Emit sparkles
      const emitter = sparkles.addEmitter({
        x: pointer.x,
        y: pointer.y,
        speed: 100,
        scale: { start: 0.5, end: 0 },
        quantity: 2,
        lifespan: 500
      });
      setTimeout(() => emitter.stop(), 100);

      revealedPixels += 1; // Simplified tracking
      if (revealedPixels > 100) { // Check for win
        checkWin(scene, renderTexture, rewardGroup);
      }
    }
  });
}

function checkWin(scene, texture, reward) {
  // Reveal fully
  scene.tweens.add({
    targets: texture,
    alpha: 0,
    scale: 1.2,
    duration: 800,
    ease: 'Power2',
    onComplete: () => {
      reward.setScale(1);
      scene.tweens.add({
        targets: reward,
        scale: 1.1,
        yoyo: true,
        duration: 300,
        repeat: 1
      });
      document.getElementById('game-ui-overlay').classList.remove('hidden');
    }
  });
}

function updateScene() {}

window.claimReward = () => {
  if (phaserGame) {
    phaserGame.destroy(true);
    phaserGame = null;
  }
  
  const reward = state.currentGame === 'wheel' ? state.rewards.wheel : state.rewards.scratch;
  state.balance += reward;
  
  document.getElementById('game-ui-overlay').classList.add('hidden');
  showToast(`Reward claimed! $${reward.toFixed(2)} added to balance.`);
  showConfetti();
  showCoinRain();
  updateDynamicUI();
  setTimeout(() => nextStep(11), 2000);
};

window.initFortuneWheelGame = () => {
  if (phaserGame) {
    phaserGame.destroy(true);
    phaserGame = null;
  }

  const config = {
    type: Phaser.AUTO,
    width: 480,
    height: window.innerHeight,
    parent: 'phaser-game-container',
    transparent: true,
    scene: {
      preload: preloadWheel,
      create: createWheelScene
    }
  };

  phaserGame = new Phaser.Game(config);
  console.log("Fortune Wheel Game Started");
};

function preloadWheel() {
  this.load.image('wheel-texture', '/fortune_wheel.png');
  
  // Create sparkle texture here to ensure it exists for all scenes
  const graphics = this.make.graphics({ x: 0, y: 0, add: false });
  graphics.fillStyle(0xFFFFFF, 1);
  graphics.fillCircle(4, 4, 4);
  graphics.generateTexture('sparkle', 8, 8);
}

function createWheelScene() {
  const scene = this;
  const width = scene.scale.width;
  const height = scene.scale.height;

  // Add a background to confirm rendering
  scene.add.rectangle(width/2, height/2, width, height, 0x111827, 0);

  // Background glow
  scene.add.circle(width / 2, height / 2 - 50, 220, 0xF79F1A, 0.15);

  const wheelContainer = scene.add.container(width / 2, height / 2 - 50);
  
  // Use generated texture with fallback
  let wheel;
  if (scene.textures.exists('wheel-texture')) {
    wheel = scene.add.image(0, 0, 'wheel-texture');
    wheel.setDisplaySize(320, 320);
  } else {
    // Fallback: Create a procedural wheel if image fails
    const graphics = scene.add.graphics();
    const colors = [0xF79F1A, 0x111827, 0xF59E0B, 0x1F2937, 0xF79F1A, 0x111827, 0xF59E0B, 0x1F2937];
    for (let i = 0; i < 8; i++) {
      graphics.fillStyle(colors[i], 1);
      graphics.slice(0, 0, 160, Phaser.Math.DegToRad(i * 45), Phaser.Math.DegToRad((i+1) * 45), false);
      graphics.fillPath();
    }
    wheel = scene.add.container(0, 0);
    wheel.add(graphics);
  }
  wheelContainer.add(wheel);

  // Boinkers-style Pegs (Visual)
  const pegs = [];
  for (let i = 0; i < 8; i++) {
    const angle = (360 / 8) * i;
    const rad = Phaser.Math.DegToRad(angle);
    const peg = scene.add.circle(Math.cos(rad) * 155, Math.sin(rad) * 155, 6, 0xFFFFFF);
    wheelContainer.add(peg);
    pegs.push(peg);
  }

  // Center Hub
  const center = scene.add.circle(0, 0, 40, 0xFFFFFF).setStrokeStyle(6, 0xF79F1A);
  const star = scene.add.text(0, 0, "⭐", { fontSize: '32px' }).setOrigin(0.5);
  wheelContainer.add([center, star]);

  // The Pointer (The "Peg Clicker")
  const pointerWrapper = scene.add.container(width / 2, height / 2 - 220);
  const pointer = scene.add.graphics();
  pointer.fillStyle(0xEF4444, 1);
  pointer.fillTriangle(-15, 0, 15, 0, 0, 30);
  pointerWrapper.add(pointer);

  // Spin Function
  const spinWheel = () => {
    if (scene.isSpinning) return;
    scene.isSpinning = true;

    const rounds = 5 + Math.random() * 5;
    const targetAngle = 360 * rounds + Math.random() * 360;

    scene.tweens.add({
      targets: wheel,
      angle: targetAngle,
      duration: 5000,
      ease: 'Cubic.easeOut',
      onUpdate: () => {
        // Pointer wiggle effect when passing pegs
        const angle = wheel.angle % 45;
        if (Math.abs(angle) < 5) {
          pointer.angle = 15;
        } else {
          pointer.angle = 0;
        }
      },
      onComplete: () => {
        scene.isSpinning = false;
        showWinResult(scene);
      }
    });
  };

  // Add "SPIN" button Boinkers style
  const spinBtn = scene.add.container(width / 2, height - 120);
  const btnBg = scene.add.rectangle(0, 0, 200, 60, 0xF79F1A, 1).setInteractive();
  btnBg.setStrokeStyle(4, 0x111827);
  const btnTxt = scene.add.text(0, 0, "SPIN TO WIN", { font: 'bold 20px Outfit', color: '#111827' }).setOrigin(0.5);
  spinBtn.add([btnBg, btnTxt]);

  btnBg.on('pointerdown', () => {
    spinBtn.setScale(0.95);
    spinWheel();
  });
  btnBg.on('pointerup', () => spinBtn.setScale(1));
}

function showWinResult(scene) {
  // Show Sparkles
  const sparkles = scene.add.particles(0, 0, 'sparkle', {
    speed: { min: 100, max: 300 },
    scale: { start: 0.6, end: 0 },
    blendMode: 'ADD',
    lifespan: 1000,
    gravityY: 200,
    quantity: 30
  });
  sparkles.explode(50, scene.scale.width / 2, scene.scale.height / 2 - 50);

  setTimeout(() => {
    state.rewards.wheel = 50 + Math.floor(Math.random() * 50);
    document.getElementById('game-reward-amount').innerText = `$${state.rewards.wheel}.00`;
    document.getElementById('game-ui-overlay').classList.remove('hidden');
  }, 500);
}

let searchTimeout = null;
window.handleSearch = (query) => {
  const container = document.getElementById('card-ready');
  if (!query || query.length < 2) {
    // Reset to default state
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: #6B7280;">
        <i data-lucide="search" style="width: 40px; height: 40px; color: #D1D5DB; margin-bottom: 12px;"></i>
        <div style="font-size: 14px;">Search for a creator to send a tip</div>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  container.innerHTML = `
    <div style="padding: 20px; text-align: center; width: 100%;">
      <div class="spinner" style="width: 24px; height: 24px; margin: 0 auto 12px;"></div>
      <div style="font-size: 14px; color: #6B7280;">Searching for "${query}"...</div>
    </div>
  `;

  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    try {
      const { data: creators, error } = await supabase
        .from('creators')
        .select('id, telegram_id, display_name, username, avatar_url')
        .or(`display_name.ilike.%${query}%,username.ilike.%${query}%`)
        .limit(5);

      if (error) throw error;

      if (!creators || creators.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; padding: 40px 20px; color: #6B7280;">
            <div style="font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 8px;">No creators found</div>
            <div style="font-size: 13px;">Try searching by name or @username</div>
          </div>
        `;
        return;
      }

      container.innerHTML = creators.map(c => `
        <div class="supporter-item" style="width: 100%; cursor: pointer; margin-bottom: 12px;" onclick="selectCreator('${c.id}', '${c.display_name}', '${c.username || ''}', '${c.avatar_url || ''}')">
          <div style="display: flex; align-items: center; gap: 14px;">
            <img src="${c.avatar_url || `https://api.dicebear.com/7.x/adventurer/svg?seed=${c.telegram_id}`}" class="avatar-sm" style="border-radius: 50%;">
            <div>
              <div style="font-weight: 700;">${c.display_name}</div>
              <div style="font-size: 11px; color: #10B981;">@${c.username || 'creator'}</div>
            </div>
          </div>
          <i data-lucide="chevron-right" style="width: 18px; height: 18px; color: #9CA3AF;"></i>
        </div>
      `).join('');

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error('[TipJar Search]', err.message);
      container.innerHTML = `<div style="text-align: center; padding: 20px; color: #EF4444; font-size: 14px;">Search failed. Please try again.</div>`;
    }
  }, 400);
};

window.selectCreator = (id, name, username, avatar) => {
  // Update state with the selected creator's info
  state.creator.name   = name;
  state.creator.handle = `@${username || 'creator'}`;
  state.creator.avatar = avatar || `https://api.dicebear.com/7.x/adventurer/svg?seed=${id}`;
  state.selectedCreatorId = id;
  updateDynamicUI();
  nextStep(4);
};

const animateDashboardStats = () => {
  // Animate Chart Bars
  const chart = document.getElementById('earnings-chart');
  if (chart) {
    const bars = chart.querySelectorAll('.bar');
    bars.forEach(bar => {
      const h = bar.style.height;
      bar.style.height = '0%';
      setTimeout(() => bar.style.height = h, 50);
    });
  }

  // Animate Numbers
  const stats = document.querySelectorAll('.dashboard-stats .stat-card div:last-child');
  stats.forEach(stat => {
    const target = parseFloat(stat.innerText.replace(/[^0-9.]/g, ''));
    if (isNaN(target)) return;
    let current = 0;
    const increment = target / 30;
    const update = () => {
      current += increment;
      if (current < target) {
        stat.innerText = stat.innerText.includes('$') ? `$${current.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : Math.floor(current).toLocaleString();
        requestAnimationFrame(update);
      } else {
        stat.innerText = stat.innerText.includes('$') ? `$${target.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : target.toLocaleString();
      }
    };
    update();
  });
};

const showCoinRain = () => {
  for (let i = 0; i < 30; i++) {
    setTimeout(() => {
      const coin = document.createElement('div');
      coin.className = 'coin';
      coin.style.left = Math.random() * 100 + 'vw';
      coin.style.animationDuration = (Math.random() * 1 + 1.5) + 's';
      document.body.appendChild(coin);
      setTimeout(() => coin.remove(), 2500);
    }, i * 100);
  }
};

const showConfetti = () => {
  for (let i = 0; i < 50; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.left = Math.random() * 100 + 'vw';
    confetti.style.backgroundColor = ['#F79F1A', '#10B981', '#6366F1', '#EF4444'][Math.floor(Math.random() * 4)];
    confetti.style.transform = `scale(${Math.random()})`;
    confetti.style.animationDelay = Math.random() * 2 + 's';
    document.body.appendChild(confetti);
    setTimeout(() => confetti.remove(), 3000);
  }
};

// --- UI Updates ---
const updateTipUI = () => {
  document.querySelectorAll('.tip-card').forEach(c => {
    const amount = parseFloat(c.dataset.amount);
    c.classList.toggle('active', state.selectedAmount === amount && !state.customAmount);
  });
  
  const totalDisplay = document.getElementById('tip-total');
  if (totalDisplay) {
    totalDisplay.innerText = state.selectedAmount.toFixed(2);
  }
};

const updateDynamicUI = async () => {
  if (!state.creator) return;
  // Update avatars and names dynamically
  document.querySelectorAll('.alex-name').forEach(el => el.innerText = state.creator.name || 'Creator');
  document.querySelectorAll('.alex-handle').forEach(el => el.innerText = state.creator.handle || '@creator');
  const receiptAvatar = document.getElementById('receipt-avatar');
  if (receiptAvatar) receiptAvatar.src = state.creator.avatar;
  
  const totalAmountDisplays = document.querySelectorAll('.selected-total-amount');
  totalAmountDisplays.forEach(el => el.innerText = `$${state.selectedAmount.toFixed(2)}`);

  const receiptMsgContainer = document.getElementById('receipt-message-container');
  const receiptMsgText = document.getElementById('receipt-message-text');
  if (receiptMsgContainer && receiptMsgText) {
    if (state.selectedMessage && state.selectedMessage.trim() !== '') {
      receiptMsgText.innerText = `"${state.selectedMessage.trim()}"`;
      receiptMsgContainer.style.display = 'block';
    } else {
      receiptMsgContainer.style.display = 'none';
    }
  }

  // Update Balance
  document.querySelectorAll('.current-balance').forEach(el => {
    el.innerText = `$${state.balance.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
  });

  // Update Wallet
  document.querySelectorAll('#step-9 .method-card div div div:last-child').forEach(el => {
    el.innerText = state.walletAddress;
  });

  const tonDisplay = document.getElementById('ton-wallet-display');
  if (tonDisplay) {
    tonDisplay.innerText = state.tonAddress || 'Not Connected';
    tonDisplay.style.color = state.tonAddress ? '#0088CC' : '#6B7280';
  }

  // Update Tickets
  const ticketDisplay = document.getElementById('ticket-count');
  if (ticketDisplay) {
    ticketDisplay.innerText = state.tickets;
  }
  // Update Goal UI
  const goalTitle = document.getElementById('dashboard-goal-title');
  const goalCurrent = document.getElementById('dashboard-goal-current');
  const goalTarget = document.getElementById('dashboard-goal-target');
  const goalPercentText = document.getElementById('dashboard-goal-percent');
  
  if (goalTitle && state.goal) {
    goalTitle.innerText = state.goal.title;
    state.goal.current = state.balance; // Tie current goal progress to balance
    if (goalCurrent) goalCurrent.innerText = state.goal.current.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0});
    if (goalTarget) goalTarget.innerText = state.goal.target.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0});
    
    let percent = Math.min(100, Math.round((state.goal.current / state.goal.target) * 100));
    if(isNaN(percent)) percent = 0;
    if (goalPercentText) goalPercentText.innerText = `${percent}%`;
    if (window.animateGoal) window.animateGoal();
  }

  // Show skeletons if we are loading fresh data
  const profileSkeleton = document.getElementById('profile-skeleton');
  const profileContent = document.getElementById('profile-content');
  const dashSkeleton = document.getElementById('dashboard-skeleton');
  const dashContent = document.getElementById('dashboard-content');

  const showSkeletons = (loading) => {
    if (profileSkeleton) profileSkeleton.style.display = loading ? 'block' : 'none';
    if (profileContent) profileContent.style.display = loading ? 'none' : 'block';
    if (dashSkeleton) dashSkeleton.style.display = loading ? 'block' : 'none';
    if (dashContent) dashContent.style.display = loading ? 'none' : 'block';
  };

  // Fetch real analytics and history if viewing as creator
  let todayTotal = 0, weekTotal = 0, monthTotal = 0, allTotal = state.balance, supporterCount = 0;
  
  const targetId = state.selectedCreatorId || (dbCreator ? dbCreator.id : null);
  
  if (targetId) {
    showSkeletons(true);
    try {
      // If we are the owner, get full analytics
      if (dbCreator && targetId === dbCreator.id) {
        const metrics = await getAnalyticsMetrics(dbCreator.id);
        todayTotal = metrics.today;
        weekTotal = metrics.week;
        monthTotal = metrics.month;
        supporterCount = metrics.count;
        allTotal = metrics.total;
        state.balance = allTotal; 
        state.goal.current = allTotal;
      }
      
      // Fetch tips for activity feed/podium for ANY creator being viewed
      const tips = await getCreatorTips(targetId, 20);
      state.notifications = tips.map(t => ({
        id: t.id,
        text: `New tip from ${t.tipper_name || 'Supporter'}: $${(t.usd_value || 0).toFixed(2)}`,
        time: t.paid_at ? new Date(t.paid_at).toLocaleDateString() : 'Just now',
        type: 'tip'
      }));
    } catch (e) {
      console.warn('[TipJar] Could not load metrics/tips:', e);
    } finally {
      showSkeletons(false);
    }
  }

  // Update Notifications (Activity Feed)
  const notifyList = document.getElementById('notifications-list');
  if (notifyList) {
    if (state.notifications.length === 0) {
      notifyList.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: #6B7280;">
          <div style="background: #F3F4F6; width: 64px; height: 64px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;">
            <i data-lucide="inbox" style="width: 32px; height: 32px; color: #9CA3AF;"></i>
          </div>
          <div style="font-weight: 700; color: #111827; font-size: 16px; margin-bottom: 8px;">No tips yet!</div>
          <div style="font-size: 13px;">Share your QR code or link to get your first supporter.</div>
          <button class="btn-primary" style="padding: 12px 24px; font-size: 13px; border-radius: 100px; margin-top: 16px; width: auto;" onclick="openQRModal()">Share Profile</button>
        </div>
      `;
    } else {
      notifyList.innerHTML = state.notifications.map(n => `
        <div class="supporter-item" style="border: none; background: #F9FAFB; padding: 16px; border-radius: 20px; margin-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 14px;">
            <div class="action-icon" style="background: white;"><i data-lucide="${n.type === 'tip' ? 'heart' : n.type === 'payout' ? 'arrow-up-right' : 'info'}" style="width: 18px; height: 18px;"></i></div>
            <div>
              <div style="font-weight: 700; font-size: 14px;">${n.text}</div>
              <div style="font-size: 11px; color: #9CA3AF;">${n.time}</div>
            </div>
          </div>
        </div>
      `).join('');
    }
    if (window.lucide) window.lucide.createIcons();
  }

  // Update Supporters List
  const supportersList = document.getElementById('supporters-list');
  if (supportersList) {
    if (state.notifications.length === 0) {
      supportersList.innerHTML = `<div style="text-align: center; color: #9CA3AF; padding: 20px;">No supporters yet</div>`;
    } else {
      supportersList.innerHTML = state.notifications.map((n, idx) => `
        <div class="method-card" style="padding: 18px; border-radius: 20px; margin-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 14px;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background: ${idx < 3 ? '#FFFBEB' : '#F3F4F6'}; color: ${idx < 3 ? '#F79F1A' : '#9CA3AF'}; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 12px;">${idx + 1}</div>
            <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(n.text.split(':')[0])}" class="avatar-sm">
            <div>
              <div style="font-weight: 700;">${n.text.split('from ')[1]?.split(':')[0] || 'Supporter'}</div>
              <div style="font-size: 11px; color: #9CA3AF;">${n.time} • TON</div>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-weight: 700; color: #10B981; font-size: 16px;">${n.text.match(/\$([0-9.]+)/) ? n.text.match(/\$([0-9.]+)/)[0] : ''}</div>
          </div>
        </div>
      `).join('');
    }
  }

  // --- Dashboard avatar ---
  const dashAvatar = document.getElementById('dashboard-avatar');
  if (dashAvatar && state.creator.avatar) dashAvatar.src = state.creator.avatar;

  const statToday   = document.getElementById('stat-today');
  const statWeek    = document.getElementById('stat-week');
  const statAlltime = document.getElementById('stat-alltime');
  if (statToday)   statToday.innerText   = `$${todayTotal.toFixed(0)}`;
  if (statWeek)    statWeek.innerText    = `$${weekTotal.toFixed(0)}`;
  if (statAlltime) statAlltime.innerText = `$${allTotal.toLocaleString(undefined, {maximumFractionDigits: 0})}`;

  const monthTipsEl = document.getElementById('dashboard-monthly-tips');
  const supportersEl = document.getElementById('dashboard-total-supporters');
  if (monthTipsEl) monthTipsEl.innerText = `$${monthTotal.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}`;
  if (supportersEl) supportersEl.innerText = supporterCount.toLocaleString();

  const currentBalanceDisplays = document.querySelectorAll('.current-balance');
  currentBalanceDisplays.forEach(el => el.innerText = `$${allTotal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);

  // --- Payout wallet status in Settings ---
  const notSet       = document.getElementById('wallet-not-set');
  const savedDisplay = document.getElementById('wallet-saved-display');
  const addrDisplay  = document.getElementById('wallet-address-display');
  const walletInput  = document.getElementById('payout-wallet-input');
  const isWalletSet  = state.walletAddress && state.walletAddress !== '0x71C...39A2';

  if (notSet)       notSet.style.display        = isWalletSet ? 'none' : 'flex';
  if (savedDisplay) savedDisplay.style.display   = isWalletSet ? 'block' : 'none';
  if (addrDisplay && isWalletSet)  addrDisplay.innerText  = state.walletAddress;
  if (walletInput  && isWalletSet) walletInput.value      = state.walletAddress;

  // Bio Population
  const bioEl = document.getElementById('creator-bio');
  if (bioEl && state.creator.bio) {
    bioEl.innerText = state.creator.bio;
  }

  // --- Dynamic Template Population ---
  
  // 1. Top Supporter Card on Profile
  const topSupporterCard = document.getElementById('top-supporter-card');
  if (topSupporterCard) {
    const validTips = state.notifications.filter(n => n.type === 'tip');
    if (validTips.length > 0) {
      const topTip = [...validTips].sort((a, b) => {
        const valA = parseFloat(a.text.match(/\$([0-9.]+)/)?.[1] || 0);
        const valB = parseFloat(b.text.match(/\$([0-9.]+)/)?.[1] || 0);
        return valB - valA;
      })[0];
      
      const name = topTip.text.split('from ')[1]?.split(':')[0] || 'Supporter';
      const amount = topTip.text.match(/\$([0-9.]+)/)?.[0] || '$0';
      topSupporterCard.innerHTML = `
          <div style="background: linear-gradient(135deg, #FFFBEB 0%, #FEF3C7 100%); border: 1px solid #FCD34D; border-radius: 20px; padding: 12px 16px; margin: 24px 24px 0; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 10px 25px rgba(245, 158, 11, 0.15);">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div style="position: relative;">
                <img src="https://api.dicebear.com/7.x/adventurer/svg?seed=${name}" style="width: 42px; height: 42px; border-radius: 50%; border: 2px solid #F59E0B;">
                <div style="position: absolute; top: -10px; left: 50%; transform: translateX(-50%);">
                  <i data-lucide="crown" style="width: 18px; height: 18px; color: #F59E0B; fill: #F59E0B;"></i>
                </div>
              </div>
              <div style="text-align: left;">
                <div style="font-size: 10px; font-weight: 800; color: #D97706; text-transform: uppercase; letter-spacing: 0.05em;">Top Supporter</div>
                <div style="font-size: 14px; font-weight: 800; color: #92400E;">${name}</div>
              </div>
            </div>
            <div style="font-size: 16px; font-weight: 900; color: #D97706;">${amount}</div>
          </div>
      `;
      topSupporterCard.style.display = 'block';
    } else {
      topSupporterCard.style.display = 'none';
    }
  }

  // 2. Dashboard Activity List
  const dashActivity = document.getElementById('dashboard-activity-list');
  if (dashActivity) {
    if (state.notifications.length === 0) {
      dashActivity.innerHTML = `<div style="text-align: center; color: #9CA3AF; padding: 20px;">No activity yet</div>`;
    } else {
      dashActivity.innerHTML = state.notifications.slice(0, 5).map(n => `
        <div class="supporter-item" style="border: none; background: white; padding: 16px; border-radius: 20px; border: 1px solid #F3F4F6; margin-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 14px;">
            <img src="https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(n.text.split('from ')[1]?.split(':')[0] || 'S')}" class="avatar-sm">
            <div>
              <div style="font-weight: 700; font-size: 14px;">${n.text.split('from ')[1]?.split(':')[0] || 'Supporter'}</div>
              <div style="font-size: 11px; color: #9CA3AF;">${n.time} • TON</div>
            </div>
          </div>
          <div style="color: #10B981; font-weight: 700;">+${n.text.match(/\$([0-9.]+)/)?.[0] || '$0'}</div>
        </div>
      `).join('');
    }
  }

  // 3. Podium Population
  const podiumContainer = document.getElementById('podium-container');
  if (podiumContainer) {
    const validTips = state.notifications.filter(n => n.type === 'tip');
    if (validTips.length > 0) {
      const sorted = [...validTips].sort((a, b) => {
        const valA = parseFloat(a.text.match(/\$([0-9.]+)/)?.[1] || 0);
        const valB = parseFloat(b.text.match(/\$([0-9.]+)/)?.[1] || 0);
        return valB - valA;
      });
      
      const p1 = sorted[0];
      const p2 = sorted[1];
      const p3 = sorted[2];
      
      const renderRank = (n, rank, width, height, color, fallbackSeed) => {
        if (!n) return '';
        const name = n.text.split('from ')[1]?.split(':')[0] || 'Supporter';
        const amount = n.text.match(/\$([0-9.]+)/)?.[0] || '$0';
        return `
          <div class="podium-rank rank-${rank}" style="display: flex; flex-direction: column; align-items: center; position: relative; width: ${width}px; ${rank === 1 ? 'z-index: 10;' : ''}">
            ${rank === 1 ? `<div style="position: absolute; top: -32px; left: 50%; transform: translateX(-50%);"><i data-lucide="crown" style="width: 28px; height: 28px; fill: #F79F1A; color: #F79F1A;"></i></div>` : ''}
            <div style="position: relative; margin-bottom: 12px;">
              ${rank === 1 ? `<div class="glow-ring" style="position: absolute; inset: -6px; border-radius: 50%; background: linear-gradient(135deg, #F79F1A 0%, #FBBF24 100%); opacity: 0.2; filter: blur(8px);"></div>` : ''}
              <img src="https://api.dicebear.com/7.x/adventurer/svg?seed=${name}" style="width: ${rank === 1 ? 80 : 56}px; height: ${rank === 1 ? 80 : 56}px; border-radius: 50%; border: ${rank === 1 ? '4px solid #F79F1A' : '3px solid white'}; box-shadow: 0 10px 20px rgba(0,0,0,0.1); position: relative; z-index: 1;">
              <div style="position: absolute; bottom: -2px; right: 2px; width: ${rank === 1 ? 30 : 24}px; height: ${rank === 1 ? 30 : 24}px; background: ${color}; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: ${rank === 1 ? 14 : 12}px; font-weight: 800; border: ${rank === 1 ? 3 : 2}px solid white; z-index: 2;">${rank}</div>
            </div>
            <div style="font-weight: ${rank === 1 ? 800 : 700}; font-size: ${rank === 1 ? 12 : 11}px; color: #1E293B; margin-bottom: 6px; text-align: center; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${name}</div>
            <div style="background: white; width: 100%; padding: ${rank === 1 ? 16 : 12}px 4px; border-radius: ${rank === 1 ? 20 : 16}px ${rank === 1 ? 20 : 16}px 0 0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); text-align: center; border: 1px solid #F1F5F9; height: ${height}px;">
              <div style="font-size: ${rank === 1 ? 16 : 13}px; font-weight: ${rank === 1 ? 900 : 800}; color: ${rank === 1 ? '#F79F1A' : '#1E293B'};">${amount}</div>
            </div>
          </div>
        `;
      };
      
      podiumContainer.innerHTML = `
        ${renderRank(p2, 2, 100, 60, '#94A3B8')}
        ${renderRank(p1, 1, 120, 90, '#F79F1A')}
        ${renderRank(p3, 3, 100, 45, '#D97706')}
      `;
    } else {
      podiumContainer.innerHTML = `<div style="text-align: center; color: #9CA3AF; width: 100%; padding: 40px 0;">No supporters to display.</div>`;
    }
  }

  if (window.lucide) window.lucide.createIcons();

  // --- Role-based UI Toggles ---
  const dashNav = document.getElementById('dashboard-nav');
  const switchBtn = document.getElementById('switch-to-dashboard');
  const profileBackBtn = document.getElementById('profile-back-btn');
  const switchBtnText = document.getElementById('switch-btn-text');

  if (state.userRole === 'OWNER') {
    if (dashNav) dashNav.style.display = 'flex';
    if (switchBtn) {
      switchBtn.style.display = 'block';
      if (switchBtnText) switchBtnText.innerText = 'Switch to My Dashboard';
      switchBtn.onclick = () => nextStep(7);
    }
    if (profileBackBtn) profileBackBtn.style.display = 'flex';
  } else {
    if (dashNav) dashNav.style.display = 'none';
    if (switchBtn) {
      switchBtn.style.display = 'block';
      if (switchBtnText) switchBtnText.innerText = 'Create My TipJar';
      switchBtn.onclick = () => {
        // Clear param so they go to their own onboarding/dashboard
        const url = new URL(window.location.href);
        url.searchParams.delete('creator');
        window.history.pushState({}, '', url);
        location.reload(); // Hard reload to reset state as OWNER
      };
    }
    if (profileBackBtn) profileBackBtn.style.display = 'none';
  }
};

const showLoadingOverlay = (show, message = 'Processing...') => {
  let overlay = document.getElementById('loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `
      <div style="text-align: center;">
        <div id="lottie-container-overlay" style="width: 150px; height: 150px; margin: 0 auto 16px;"></div>
        <div id="loading-message" style="font-weight: 600; color: #111827;">${message}</div>
      </div>
    `;
    document.getElementById('app').appendChild(overlay);
    
    // Play animation — use App reference instead of broken `this`
    App.playLottie('lottie-container-overlay', '/coin-jar.json');
  }
  
  const msgEl = document.getElementById('loading-message');
  if (msgEl) msgEl.innerText = message;
  
  overlay.classList.toggle('visible', show);
};

const showToast = (message, type = 'info') => {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = message;
  document.body.appendChild(toast);
  
  // Haptic feedback for notifications
  if (type === 'error') triggerHaptic('error');
  else if (type === 'success') triggerHaptic('success');
  
  setTimeout(() => toast.classList.add('visible'), 100);
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
};

/** Native Telegram Haptic Feedback */
const triggerHaptic = (type = 'light') => {
  if (window.Telegram?.WebApp?.HapticFeedback) {
    const haptic = window.Telegram.WebApp.HapticFeedback;
    switch(type) {
      case 'light': haptic.impactOccurred('light'); break;
      case 'medium': haptic.impactOccurred('medium'); break;
      case 'success': haptic.notificationOccurred('success'); break;
      case 'error': haptic.notificationOccurred('error'); break;
      case 'warning': haptic.notificationOccurred('warning'); break;
      default: haptic.impactOccurred('light');
    }
  }
};
window.triggerHaptic = triggerHaptic;

// Export to window for inline onclick handlers
window.showToast = showToast;
window.showConfetti = showConfetti;
window.showLoadingOverlay = showLoadingOverlay;
window.updateDynamicUI = updateDynamicUI;

window.confirmWithdraw = async () => {
  if (state.balance < 10) {
    showToast("Minimum withdrawal is $10.00");
    return;
  }
  if (!state.walletAddress || state.walletAddress === '0x71C...39A2') {
    showToast("Please set your Payout Wallet in Settings first.");
    return;
  }

  showLoadingOverlay(true, "Processing withdrawal...");
  try {
    await requestWithdrawal(dbCreator.id, {
      grossAmount: state.balance,
      wallet: state.walletAddress,
      currency: 'TON'
    });
    
    state.balance = 0; 
    await window.updateDynamicUI();
    
    const modal = document.getElementById('withdraw-modal');
    if(modal) modal.classList.remove('active');
    
    showLoadingOverlay(false);
    showToast("Withdrawal requested successfully!");
  } catch (e) {
    showLoadingOverlay(false);
    showToast("Failed to request withdrawal.");
    console.error(e);
  }
};

// ============================================================
// First-Tip Celebration
// ============================================================
window.showFirstTipCelebration = (amount, currency, tipperName) => {
  const overlay   = document.getElementById('first-tip-overlay');
  const amountEl  = document.getElementById('first-tip-amount');
  const fromEl    = document.getElementById('first-tip-from');
  const confettiEl = document.getElementById('first-tip-confetti');

  if (!overlay) return;

  triggerHaptic('success');

  if (amountEl) amountEl.innerText = `+$${parseFloat(amount).toFixed(2)}`;
  if (fromEl)   fromEl.innerText   = tipperName ? `Tipped by ${tipperName} 💜` : 'Your first supporter 💜';

  // Launch confetti
  if (confettiEl) {
    const colors = ['#F79F1A', '#10B981', '#6366F1', '#EF4444', '#FBBF24', '#A78BFA'];
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement('div');
      piece.className = 'first-tip-confetti-piece';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.bottom = '-20px';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDelay = `${Math.random() * 1.5}s`;
      piece.style.animationDuration = `${1.5 + Math.random() * 1.5}s`;
      piece.style.width = `${6 + Math.random() * 10}px`;
      piece.style.height = piece.style.width;
      confettiEl.appendChild(piece);
      setTimeout(() => piece.remove(), 3000);
    }
  }

  overlay.style.display = 'flex';
};

window.dismissFirstTip = () => {
  const overlay = document.getElementById('first-tip-overlay');
  if (overlay) overlay.style.display = 'none';
  nextStep(7); // Go to creator dashboard
};

// ============================================================
// Real Share Link (uses creator's Telegram ID for bot deep link)
// ============================================================
window.shareProfileLink = () => {
  const telegramId = dbCreator?.telegram_id;
  const link = telegramId
    ? `https://t.me/TipJarBot?start=creator_${telegramId}`
    : `https://t.me/TipJarBot`;

  if (window.Telegram?.WebApp) {
    // Native Telegram share
    window.Telegram.WebApp.openTelegramLink(
      `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Support me on TipJar 💰')}`
    );
  } else {
    navigator.clipboard.writeText(link).then(() => showToast('Profile link copied! 🔗'));
  }
};

// Update QR modal copy button to use real link
window.openQRModal = () => {
  const modal = document.getElementById('qr-modal');
  if (!modal) return;

  // Update the copy button with the real link
  const telegramId = dbCreator?.telegram_id;
  const link = telegramId
    ? `https://t.me/TipJarBot?start=creator_${telegramId}`
    : `https://tipjar.app/${dbCreator?.username || 'creator'}`;

  // Generate real QR code using a public API
  const qrImage = document.getElementById('qr-image');
  const qrLoader = document.getElementById('qr-loader');
  if (qrImage) {
    qrImage.style.display = 'none';
    if (qrLoader) qrLoader.style.display = 'block';
    
    qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(link)}&bgcolor=FFFFFF&color=111827&margin=10`;
    qrImage.onload = () => {
      qrImage.style.display = 'block';
      if (qrLoader) qrLoader.style.display = 'none';
    };
  }

  const copyBtn = modal.querySelector('button.btn-primary');
  if (copyBtn) copyBtn.onclick = () => copyToClipboard(link);

  modal.classList.add('visible');
};

window.closeQRModal = () => {
  const modal = document.getElementById('qr-modal');
  if (modal) modal.classList.remove('visible');
};

window.animateGoal = () => {
  const progressBar = document.getElementById('goal-progress-bar');
  if (progressBar && state.goal) {
    progressBar.style.width = '0%';
    void progressBar.offsetWidth;
    let percent = Math.min(100, Math.round((state.goal.current / state.goal.target) * 100));
    if (isNaN(percent)) percent = 0;
    setTimeout(() => progressBar.style.width = `${percent}%`, 100);
  }
};

// Update Settings share link to use real bot link
window.updateSettingsShareLink = () => {
  const linkInput = document.getElementById('tipjar-link');
  const telegramId = dbCreator?.telegram_id;
  if (linkInput && telegramId) {
    const link = `https://t.me/TipJarBot?start=creator_${telegramId}`;
    linkInput.value = link;
  }
};


// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize non-UI logic
  App.init();
  
  const welcomeCard = document.getElementById('card-welcome');
  const readyCard   = document.getElementById('card-ready');
  if (welcomeCard) welcomeCard.style.backgroundImage = 'url(/creator_card.png)';
  if (readyCard)   readyCard.style.backgroundImage   = 'url(/creator_card.png)';

  const urlParams      = new URLSearchParams(window.location.search);
  const creatorIdParam = urlParams.get('creator');
  state.chatId         = urlParams.get('chat_id');

  // Authenticate creator if inside Telegram Web App
  const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (tgUser) {
    try {
      const creator = await initTelegramAuth();
      dbCreator = creator;
      state.creator.name = creator.display_name;
      state.creator.handle = `@${creator.username || 'creator'}`;
      state.creator.avatar = creator.avatar_url || state.creator.avatar;
      state.selectedCreatorId = creator.id;
      state.walletAddress = creator.withdrawal_wallet || creator.payout_wallet || state.walletAddress;
    } catch (err) {
      console.warn('[TipJar] Telegram auth failed, continuing as guest', err);
    }
  }

  // Determine initial step and role
  if (creatorIdParam) {
    try {
      const { data: targetCreator } = await supabase
        .from('creators')
        .select('id, telegram_id, display_name, username, avatar_url, goal_title, goal_target, balance_usd, bio')
        .eq('id', creatorIdParam)
        .single();

      if (targetCreator) {
        // If the viewer is the creator themselves, treat them as OWNER
        if (dbCreator && dbCreator.id === targetCreator.id) {
          state.userRole = 'OWNER';
        } else {
          state.userRole = 'VIEWER';
        }

        state.creator.name   = targetCreator.display_name;
        state.creator.handle = `@${targetCreator.username || 'creator'}`;
        state.creator.avatar = targetCreator.avatar_url || state.creator.avatar;
        state.creator.bio    = targetCreator.bio || state.creator.bio;
        state.selectedCreatorId = targetCreator.id;
        
        // Update goal state from real data
        state.goal.title = targetCreator.goal_title || state.goal.title;
        state.goal.target = targetCreator.goal_target || state.goal.target;
        state.balance = targetCreator.balance_usd || 0;

        state.currentStep = 4; // Tipping Profile
      }
    } catch (err) {
      console.warn('[TipJar] Error loading creator:', err);
    }
  } else if (dbCreator) {
    state.userRole = 'OWNER';
    state.currentStep = 7; // Dashboard
    
    // Sync dashboard creator state
    state.creator.name = dbCreator.display_name;
    state.creator.handle = `@${dbCreator.username || 'creator'}`;
    state.creator.avatar = dbCreator.avatar_url || state.creator.avatar;
    state.creator.bio    = dbCreator.bio || state.creator.bio;
    state.selectedCreatorId = dbCreator.id;
    state.goal.title = dbCreator.goal_title || state.goal.title;
    state.goal.target = dbCreator.goal_target || state.goal.target;
    state.balance = dbCreator.balance_usd || 0;
  } else {
    try {
      // Not in Telegram or no user info - check local storage
      const hasOnboarded = localStorage.getItem('tipjar_onboarded') === 'true';
      state.userRole = 'OWNER'; // If no param and no dbCreator, assume they are starting fresh
      state.currentStep = hasOnboarded ? 7 : 1;
    } catch (err) {
      console.warn('[TipJar] Initialization fallback');
      state.userRole = 'OWNER';
      state.currentStep = 1;
    }
  }

  // Final Render
  App.render();
  
  if (state.currentStep === 8) {
    App.loadTopSupporters();
  }
  if (state.currentStep === 9 && window.updateSettingsShareLink) {
    window.updateSettingsShareLink();
  }

  // Start onboarding timer if we're on step 1
  if (state.currentStep === 1) {
    startOnboardingTimer(1);
  }

  // Sync Avatars
  if (state.creator) {
    const alexAvatar  = document.getElementById('alex-avatar');
    const summaryAvatar = document.getElementById('summary-avatar');
    const receiptAvatar = document.getElementById('receipt-avatar');
    if (alexAvatar) alexAvatar.src = state.creator.avatar || '';
    if (summaryAvatar) summaryAvatar.src = state.creator.avatar || '';
    if (receiptAvatar) receiptAvatar.src = state.creator.avatar || '';

    document.querySelectorAll('.alex-name').forEach(el => el.innerText = state.creator.name || 'Creator');
  }
  
  if (window.animateGoal) window.animateGoal();
});

window.toggleInterest = (btn, interest) => {
  btn.classList.toggle('selected');
  if (btn.classList.contains('selected')) {
    state.interests.push(interest);
  } else {
    state.interests = state.interests.filter(i => i !== interest);
  }
};

window.saveInterestsAndContinue = async () => {
  if (state.interests.length < 1) {
    showToast("Please pick at least one interest!");
    return;
  }
  
  if (dbCreator) {
    try {
      await supabase.from('creators').update({ interests: state.interests }).eq('id', dbCreator.id);
    } catch (e) {
      console.warn('[TipJar] Failed to save interests');
    }
  }
  
  nextStep(3);
};
