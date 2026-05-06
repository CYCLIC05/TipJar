// TipJar — Main App Entry Point
import { supabase } from './src/lib/supabase.js';
import { initTelegramAuth } from './src/lib/auth.js';
import { getCreatorTips, createTipRecord, updateCreator } from './src/lib/db.js';
import { TonConnectUI } from '@tonconnect/ui';

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
    this.initTonConnect();
    this.render();
    if (window.lucide) window.lucide.createIcons();
    startOnboardingTimer(1);
  },

  initTonConnect() {
    try {
      const manifestPath = `${window.location.origin}/tonconnect-manifest.json`;
      console.log('[TipJar] 📦 Initializing TON Connect with manifest:', manifestPath);

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
          
          // AUTO-PAYMENT LOGIC:
          // If the user is on the payment screen (Step 6), trigger the transaction immediately
          if (state.currentStep === 6) {
            console.log('[TipJar] ⚡ Auto-triggering transaction signature...');
            App.handleTonPayment();
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

    try {
      const MERCHANT_ADDRESS = 'UQDwT-v0d7vO-u6nO7wA99N61v0p5wzP-5p8V4O0x_1W6fHj';
      showLoadingOverlay(true, 'Waiting for wallet signature...');
      
      if (sendTxBtn) {
        sendTxBtn.innerHTML = 'Processing... <div class="spinner-custom" style="width: 18px; height: 18px; border-width: 2px;"></div>';
        sendTxBtn.style.opacity = '0.7';
        sendTxBtn.style.pointerEvents = 'none';
      }

      const transaction = {
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [
          {
            address: MERCHANT_ADDRESS,
            amount: "50000000", // 0.05 TON
          }
        ]
      };

      const result = await tonConnectUI.sendTransaction(transaction);
      console.log('[TipJar] ✅ TON Payment Success:', result);
      
      showLoadingOverlay(false);
      
      // Update Success Screen Info
      const successAmountEl = document.getElementById('success-amount');
      const successCreatorEl = document.getElementById('success-creator-name');
      if (successAmountEl) successAmountEl.innerText = state.selectedAmount.toFixed(2);
      if (successCreatorEl) successCreatorEl.innerText = state.creator.name;

      // Show Confetti and Go to Success Screen
      showConfetti();
      nextStep(13);
      App.playLottie('lottie-container-success', '/coin-jar.json'); 
      
      state.balance += state.selectedAmount;
      updateDynamicUI();

      // Record in DB for the target creator
      const targetId = state.selectedCreatorId || (dbCreator ? dbCreator.id : null);
      if (targetId) {
        await createTipRecord({
          creatorId: targetId,
          tipperName: state.tipperName || 'Supporter',
          amountUsd: state.selectedAmount,
          currency: 'TON',
          txId: result.boc || 'TON_TRANSFER'
        });
      }
    } catch (err) {
      showLoadingOverlay(false);
      console.error('[TipJar] ❌ Payment Error:', err);
      
      if (statusEl) { statusEl.innerText = 'PAYMENT FAILED'; statusEl.style.color = '#EF4444'; }
      
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
      if (headerTitle) headerTitle.innerText = 'Payment Canceled';
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

  // If authenticated as a creator, skip onboarding steps 1-3 and go straight to dashboard.
  // We allow step 4, 5, 6 (tipping flow) so they can preview their profile.
  if (dbCreator && step > 1 && step < 4) {
    const dashboardScreen = document.getElementById('step-7');
    if (dashboardScreen) {
      transitionScreen(currentScreen, dashboardScreen);
      state.currentStep = 7;
      updateDynamicUI();
      return;
    }
  }

  // Step 6 — Payment Logic (TON Wallet Exclusive)
  if (step === 6) {
    const sendTxBtn = document.getElementById('send-tx-btn');
    const doneBtn = document.getElementById('receipt-done-btn');
    const connectWrapper = document.getElementById('ton-connect-wrapper');
    const statusEl = document.getElementById('receipt-status');
    const methodEl = document.getElementById('receipt-method');
    const txEl = document.getElementById('receipt-tx-id');

    if (methodEl) methodEl.innerText = 'TON Wallet';
    if (txEl) txEl.innerText = 'Self-Custody Transfer';
    if (statusEl) { statusEl.innerText = 'CONNECT WALLET'; statusEl.style.color = '#F79F1A'; }
    
    transitionScreen(currentScreen, nextScreen);
    state.currentStep = step;

    if (doneBtn) doneBtn.style.display = 'none';
    if (connectWrapper) connectWrapper.style.display = 'flex';

    // Load premium animations
    if (step === 1) {
      App.playLottie('lottie-container-welcome', '/coin-jar.json');
      if (fill) fill.classList.add('active');
    }

    if (step === 3) {
      App.playLottie('lottie-container-ready', '/coin-jar.json');
    }

    if (step === 6) {
      if (sendTxBtn) {
        sendTxBtn.style.display = 'flex';
        sendTxBtn.classList.add('pulse-ready');
      }
      if (statusEl) { statusEl.innerText = 'READY TO SIGN'; statusEl.style.color = '#3B82F6'; }
      if (connectWrapper) connectWrapper.style.display = 'none'; // Hide the giant pill
      
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

      // Update header for connected state
      const headerTitle = document.querySelector('#awaiting-header h1');
      const headerText = document.querySelector('#awaiting-header p');
      if (headerTitle) headerTitle.innerText = 'Confirm Payment';
      if (headerText) headerText.innerText = 'Wallet linked! Tap confirm to sign the transaction.';
    } else {
      if (sendTxBtn) {
        sendTxBtn.style.display = 'none';
        sendTxBtn.classList.remove('pulse-ready');
      }
      if (connectWrapper) connectWrapper.style.display = 'flex'; // Show pill if not connected
      if (methodEl) methodEl.innerText = 'TON Wallet';

      // Revert header if disconnected
      const headerTitle = document.querySelector('#awaiting-header h1');
      const headerText = document.querySelector('#awaiting-header p');
      if (headerTitle) headerTitle.innerText = 'Connect Wallet';
      if (headerText) headerText.innerText = 'Connect your TON wallet to sign the transaction.';
    }

    // Handle manual click if auto-trigger fails
    if (sendTxBtn) {
      sendTxBtn.onclick = () => App.handleTonPayment();
    }
    return;
  }

  if (step === 7) {
    localStorage.setItem('tipjar_onboarded', 'true');
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
    if (step === 1) {
      nextStep(3); // Skip step 2 (Interests)
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
    if (window.animateGoal) window.animateGoal();
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
        <div id="lottie-container-overlay" style="width: 150px; height: 150px; margin: 0 auto 16px;"></div>
        <div id="loading-message" style="font-weight: 600; color: #111827;">${message}</div>
      </div>
    `;
    document.getElementById('app').appendChild(overlay);
    
    // Play animation
    this.playLottie('lottie-container-overlay', '/coin-jar.json');
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
  App.init();
  
  // Set images
  const welcomeCard = document.getElementById('card-welcome');
  const readyCard   = document.getElementById('card-ready');
  const alexAvatar  = document.getElementById('alex-avatar');
  const summaryAvatar = document.getElementById('summary-avatar');

  if (welcomeCard) welcomeCard.style.backgroundImage = 'url(/creator_card.png)';
  if (readyCard)   readyCard.style.backgroundImage   = 'url(/creator_card.png)';

  const urlParams      = new URLSearchParams(window.location.search);
  const creatorIdParam = urlParams.get('creator');

  if (creatorIdParam) {
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

        const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
        if (tgUser) {
          state.tipperName   = `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim();
          state.tipperHandle = tgUser.username ? `@${tgUser.username}` : null;
        }

        updateDynamicUI();
        nextStep(4);
      }
    } catch (err) {
      console.warn('[TipJar] Error loading creator:', err);
    }
  } else {
    try {
      const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
      if (tgUser) {
        const { data: creator } = await supabase
          .from('creators')
          .select('*')
          .eq('telegram_id', tgUser.id.toString())
          .single();

        if (creator) {
          dbCreator = creator;
          state.creator.name = creator.display_name;
          state.creator.handle = `@${creator.username || 'creator'}`;
          state.creator.avatar = creator.avatar_url || state.creator.avatar;
          state.payoutWallet = creator.payout_wallet;

          // SKIP: Go to dashboard but DON'T return, allow rest of init to run
          console.log('[TipJar] 🏠 Returning creator recognized.');
          nextStep(7);
        }
      }
    } catch (err) {
      console.warn('[TipJar] Offline mode');
    }

    // Persistent Onboarding Check
    const hasOnboarded = localStorage.getItem('tipjar_onboarded') === 'true';
    if (hasOnboarded && !creatorIdParam) {
      console.log('[TipJar] ⏩ Onboarding already completed.');
      setTimeout(() => nextStep(7), 100); // Small delay to ensure App.init finishes
    }
  }

  if (alexAvatar) alexAvatar.src = state.creator.avatar;
  if (summaryAvatar) summaryAvatar.src = state.creator.avatar;
  const receiptAvatar = document.getElementById('receipt-avatar');
  if (receiptAvatar) receiptAvatar.src = state.creator.avatar;

  document.querySelectorAll('.alex-name').forEach(el => el.innerText = state.creator.name);
  window.animateGoal();
  updateDynamicUI();
});
