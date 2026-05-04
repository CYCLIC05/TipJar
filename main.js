// TipJar — Main App Entry Point
import { supabase } from './src/lib/supabase.js';
import { initTelegramAuth } from './src/lib/auth.js';
import { getCreatorTips, createTipRecord, updateCreator } from './src/lib/db.js';
import { createInvoice, checkInvoicePaid } from './src/lib/cryptopay.js';

// The authenticated creator record from Supabase (populated on load)
let dbCreator = null;

// Application State
const state = {
  currentStep: 1,
  selectedInterests: [],
  selectedAmount: 5,
  customAmount: '',
  selectedMethod: 'usdt',
  balance: 2450.12,
  notifications: [
    { id: 1, text: 'New tip from @crypto_king: $120.00', time: '2m ago', type: 'tip' },
    { id: 2, text: 'Withdrawal of $500.00 processed', time: '1h ago', type: 'payout' },
    { id: 3, text: 'Welcome to TipJar! Your channel is live.', time: '1d ago', type: 'system' }
  ],
  creator: {
    name: 'Alex Rivers',
    handle: '@alex_creates',
    avatar: 'https://api.dicebear.com/7.x/adventurer/svg?seed=Alex'
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
  walletAddress: "0x71C...39A2",
  tonAddress: null,
  goal: {
    title: 'New Studio Camera 🎥',
    current: 2450.12,
    target: 3000
  }
};

// --- App Controller ---
const App = {
  init() {
    this.bindEvents();
    this.render();
    if (window.lucide) window.lucide.createIcons();
    startOnboardingTimer(1);
  },

  bindEvents() {
    window.addEventListener('popstate', () => {
      // Basic back navigation handling
    });
  },

  render() {
    updateDynamicUI();
  }
};
window.nextStep = async (step) => {
  const currentScreen = document.querySelector('.screen:not(.hidden)');
  const nextScreen = document.getElementById(`step-${step}`);
  
  if (!nextScreen) return;

  // Clear any existing onboarding timer
  if (state.onboardingTimer) {
    clearTimeout(state.onboardingTimer);
    state.onboardingTimer = null;
  }

  // Step 6 — Real Crypto Pay invoice
  if (step === 6) {
    const tipMsgInput = document.getElementById('tip-message');
    if (tipMsgInput) state.tipMessage = tipMsgInput.value;

    const currencyMap = { ton: 'TON', usdt: 'USDT', trx: 'TRX', eth: 'ETH' };
    const currency = currencyMap[state.selectedMethod] || 'TON';

    showLoadingOverlay(true, 'Creating Secure Invoice...');

    try {
      // Create the invoice via Crypto Pay API
      const invoice = await createInvoice({
        currency,
        cryptoAmount: state.selectedAmount,
        creatorName: state.creator.name,
        message: state.tipMessage,
        payload: JSON.stringify({ creator_id: dbCreator?.id, currency, usd: state.selectedAmount }),
      });

      // Save a PENDING tip record in Supabase
      if (dbCreator) {
        await createTipRecord({
          creatorId: dbCreator.id,
          tipperName: 'Anonymous',
          message: state.tipMessage,
          currency,
          cryptoAmount: state.selectedAmount,
          usdValue: state.selectedAmount,
          invoiceId: String(invoice.invoice_id),
          payUrl: invoice.pay_url,
        });
      }

      // Update receipt screen with real data
      const methodEl = document.getElementById('receipt-method');
      const txEl = document.getElementById('receipt-tx-id');
      const statusEl = document.getElementById('receipt-status');
      if (methodEl) methodEl.innerText = `${currency} via CryptoPay`;
      if (txEl) txEl.innerText = `Invoice #${invoice.invoice_id}`;
      if (statusEl) { statusEl.innerText = 'AWAITING PAYMENT'; statusEl.style.color = '#F79F1A'; }

      showLoadingOverlay(false);
      transitionScreen(currentScreen, nextScreen);
      state.currentStep = step;

      // Open the Crypto Pay native payment screen
      if (invoice.pay_url) {
        if (window.Telegram?.WebApp) {
          window.Telegram.WebApp.openLink(invoice.pay_url);
        } else {
          window.open(invoice.pay_url, '_blank');
        }
      }

      // Poll for payment confirmation (every 3s for up to 3 min)
      let attempts = 0;
      const pollInterval = setInterval(async () => {
        attempts++;
        try {
          const paid = await checkInvoicePaid(invoice.invoice_id);
          if (paid) {
            clearInterval(pollInterval);
            if (statusEl) { statusEl.innerText = 'COMPLETED ✓'; statusEl.style.color = '#10B981'; }
            state.balance += state.selectedAmount;
            state.notifications.unshift({
              id: Date.now(),
              text: `New tip of $${state.selectedAmount.toFixed(2)} received (${currency})`,
              time: 'Just now',
              type: 'tip',
            });
            showConfetti();
            showCoinRain();
            updateDynamicUI();
          }
        } catch { /* ignore poll errors */ }
        if (attempts >= 60) clearInterval(pollInterval); // stop after 3 min
      }, 3000);

    } catch (err) {
      showLoadingOverlay(false);
      console.error('[TipJar] Invoice error:', err);
      showToast('Payment failed. Please try again.');
    }
    return;
  }

  if (step === 7) {
    transitionScreen(currentScreen, nextScreen);
    if (window.animateGoal) setTimeout(window.animateGoal, 400);
  } else {
    transitionScreen(currentScreen, nextScreen);
    
    // Auto-advance logic for onboarding (Steps 1, 2, 3)
    if (step < 4) {
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
    if (step < 3) {
      nextStep(step + 1);
    } else if (step === 3) {
      nextStep(4); // Go to Profile
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
  if (!state.walletAddress || state.walletAddress === '0x71C...39A2') {
    closeModal(null, 'withdraw-modal');
    showToast('⚠️ Please set a payout wallet in Settings first!');
    nextStep(9);
    return;
  }
  const modal = document.getElementById('withdraw-modal');
  if (modal) modal.classList.remove('visible');
  showLoadingOverlay(true, 'Submitting withdrawal request...');
  setTimeout(() => {
    state.balance = 0;
    showLoadingOverlay(false);
    showToast('Withdrawal request submitted! Funds will be sent shortly.');
    updateDynamicUI();
  }, 2000);
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

window.connectTON = () => {
  showLoadingOverlay(true, "Connecting to TON Wallet...");
  setTimeout(() => {
    state.tonAddress = "EQD4...k8hZ"; // Mocked TON address
    showLoadingOverlay(false);
    showToast("TON Wallet connected!");
    updateDynamicUI();
  }, 1500);
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

const updateDynamicUI = () => {
  // Update avatars and names dynamically
  document.querySelectorAll('.alex-name').forEach(el => el.innerText = state.creator.name);
  document.querySelectorAll('.alex-handle').forEach(el => el.innerText = state.creator.handle);
  const receiptAvatar = document.getElementById('receipt-avatar');
  if (receiptAvatar) receiptAvatar.src = state.creator.avatar;
  
  const totalAmountDisplays = document.querySelectorAll('.selected-total-amount');
  totalAmountDisplays.forEach(el => el.innerText = `$${state.selectedAmount.toFixed(2)}`);

  const receiptMsgContainer = document.getElementById('receipt-message-container');
  const receiptMsgText = document.getElementById('receipt-message-text');
  if (receiptMsgContainer && receiptMsgText) {
    if (state.tipMessage && state.tipMessage.trim() !== '') {
      receiptMsgText.innerText = `"${state.tipMessage.trim()}"`;
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
  }

  // Update Notifications (Empty State Handling)
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
            <div class="action-icon" style="background: white;"><i data-lucide="${n.type === 'tip' ? 'heart' : n.type === 'payout' ? 'zap' : 'info'}" style="width: 18px; height: 18px;"></i></div>
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

  // --- Dashboard avatar ---
  const dashAvatar = document.getElementById('dashboard-avatar');
  if (dashAvatar && state.creator.avatar) dashAvatar.src = state.creator.avatar;

  // --- Stat cards from tip history ---
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart  = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 7);

  const completedTips = state.notifications.filter(n => n.type === 'tip');
  let todayTotal = 0, weekTotal = 0, allTotal = state.balance;

  completedTips.forEach(n => {
    const amt = parseFloat((n.text.match(/\$([0-9.]+)/) || [])[1] || 0);
    todayTotal += amt;
    weekTotal  += amt;
  });

  const statToday   = document.getElementById('stat-today');
  const statWeek    = document.getElementById('stat-week');
  const statAlltime = document.getElementById('stat-alltime');
  if (statToday)   statToday.innerText   = `$${todayTotal.toFixed(0)}`;
  if (statWeek)    statWeek.innerText    = `$${weekTotal.toFixed(0)}`;
  if (statAlltime) statAlltime.innerText = `$${allTotal.toLocaleString(undefined, {maximumFractionDigits: 0})}`;

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
};

const showLoadingOverlay = (show, message = 'Processing...') => {
  let overlay = document.getElementById('loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `
      <div style="text-align: center;">
        <div class="spinner" style="margin: 0 auto 16px;"></div>
        <div id="loading-message" style="font-weight: 600; color: #111827;">${message}</div>
      </div>
    `;
    document.getElementById('app').appendChild(overlay);
  }
  
  const msgEl = document.getElementById('loading-message');
  if (msgEl) msgEl.innerText = message;
  
  overlay.classList.toggle('visible', show);
};

const showToast = (message) => {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('visible'), 100);
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  // Set images
  const welcomeCard = document.getElementById('card-welcome');
  const readyCard   = document.getElementById('card-ready');
  const alexAvatar  = document.getElementById('alex-avatar');
  const summaryAvatar = document.getElementById('summary-avatar');

  if (welcomeCard) welcomeCard.style.backgroundImage = 'url(/creator_card.png)';
  if (readyCard)   readyCard.style.backgroundImage   = 'url(/creator_card.png)';

  // -------------------------------------------------------
  // Check URL params: ?creator=<uuid>
  // This is set when a tipper opens a creator's deep link
  // -------------------------------------------------------
  const urlParams      = new URLSearchParams(window.location.search);
  const creatorIdParam = urlParams.get('creator');

  if (creatorIdParam) {
    // Tipper mode: load the specific creator's profile
    try {
      const { data: targetCreator } = await supabase
        .from('creators')
        .select('id, telegram_id, display_name, username, avatar_url, goal_title')
        .eq('id', creatorIdParam)
        .single();

      if (targetCreator) {
        state.creator.name   = targetCreator.display_name;
        state.creator.handle = `@${targetCreator.username || 'creator'}`;
        state.creator.avatar = targetCreator.avatar_url || state.creator.avatar;
        state.selectedCreatorId = targetCreator.id;

        // Get tipper's Telegram identity
        const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
        if (tgUser) {
          state.tipperName   = `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim();
          state.tipperHandle = tgUser.username ? `@${tgUser.username}` : null;
        }

        // Skip onboarding — jump straight to tipping
        updateDynamicUI();
        nextStep(4);
        console.log('[TipJar] Tipper mode: tipping', targetCreator.display_name);
      }
    } catch (err) {
      console.warn('[TipJar] Could not load creator from URL param:', err.message);
    }
  } else {
    // -------------------------------------------------------
    // Creator mode: authenticate as the creator
    // -------------------------------------------------------
    try {
      dbCreator = await initTelegramAuth();
      console.log('[TipJar] ✅ Supabase connected. Creator:', dbCreator.display_name);

      // Sync live DB data → local state
      state.creator.name   = dbCreator.display_name || state.creator.name;
      state.creator.handle = `@${dbCreator.username || 'creator'}`;
      state.creator.avatar = dbCreator.avatar_url   || state.creator.avatar;
      state.balance        = dbCreator.balance_usd  ?? state.balance;
      state.goal.title     = dbCreator.goal_title   || state.goal.title;
      state.goal.target    = dbCreator.goal_target  || state.goal.target;
      state.goal.current   = state.balance;

      // Restore saved wallet address
      if (dbCreator.withdrawal_wallet) {
        state.walletAddress = dbCreator.withdrawal_wallet;
      }

      // Load recent tips from the database
      const tips = await getCreatorTips(dbCreator.id, 10);
      if (tips.length > 0) {
        state.notifications = tips.map(t => ({
          id: t.id,
          text: `${t.tipper_name} tipped ${t.crypto_currency}: $${parseFloat(t.usd_value).toFixed(2)}`,
          time: 'recently',
          type: 'tip',
          message: t.message,
        }));
      }
    } catch (err) {
      console.warn('[TipJar] ⚠️ Supabase not reachable — running in offline/demo mode.', err.message);
    }

    // Start onboarding auto-advance (only in creator mode)
    startOnboardingTimer(1);
  }

  // Update avatars
  if (alexAvatar)    alexAvatar.src    = state.creator.avatar;
  if (summaryAvatar) summaryAvatar.src = state.creator.avatar;

  // window.animateGoal definition
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

  window.animateGoal();
  if (window.lucide) window.lucide.createIcons();
  updateDynamicUI();
});

// ============================================================
// First-Tip Celebration
// ============================================================
window.showFirstTipCelebration = (amount, currency, tipperName) => {
  const overlay   = document.getElementById('first-tip-overlay');
  const amountEl  = document.getElementById('first-tip-amount');
  const fromEl    = document.getElementById('first-tip-from');
  const confettiEl = document.getElementById('first-tip-confetti');

  if (!overlay) return;

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

  const copyBtn = modal.querySelector('button.btn-primary');
  if (copyBtn) copyBtn.onclick = () => copyToClipboard(link);

  modal.classList.add('visible');
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

