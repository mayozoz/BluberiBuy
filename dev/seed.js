/**
 * seed.js — Dev helper for PriceThread
 *
 * Injects three test TrackedItems directly into chrome.storage.local so you
 * can preview the sparkline, verdict badge, and restock visual break without
 * waiting for real price history to accumulate.
 *
 * Loaded as a module by dev/seed.html.
 */

// ─── Build realistic timestamps ───────────────────────────────────────────────

/** Return a timestamp N days before now (+ optional hour offset). */
function daysAgo(n, hoursOffset = 0) {
  return Date.now() - n * 86_400_000 - hoursOffset * 3_600_000;
}

// ─── Test item definitions ────────────────────────────────────────────────────

/**
 * Item 1: SSENSE — Bottega Veneta Mini Jodie
 * Scenario: 4 drops in 30 days → expect "Wait" verdict
 */
const ITEM_WAIT = {
  id:           'test_wait_bv',
  url:          'https://www.ssense.com/en-us/women/product/bottega-veneta/green-mini-jodie-bag/test',
  site:         'ssense',
  siteName:     'SSENSE',
  name:         'Mini Jodie Bag',
  brand:        'Bottega Veneta',
  image:        'https://img.ssensemedia.com/images/242338F048022_1/bottega-veneta-green-mini-jodie-bag.jpg',
  currentPrice:  649,
  originalPrice: 1850,
  currency:      'USD',
  folderId:      'ssense',
  highPrice:     849,
  lowPrice:      649,
  inventory:     'in_stock',
  priceHistory: [
    { price: 849, inventory: 'in_stock',  timestamp: daysAgo(42) },
    { price: 849, inventory: 'in_stock',  timestamp: daysAgo(35) },
    { price: 799, inventory: 'in_stock',  timestamp: daysAgo(28) }, // drop 1
    { price: 799, inventory: 'in_stock',  timestamp: daysAgo(21) },
    { price: 749, inventory: 'in_stock',  timestamp: daysAgo(16) }, // drop 2
    { price: 749, inventory: 'in_stock',  timestamp: daysAgo(11) },
    { price: 699, inventory: 'low',       timestamp: daysAgo(7)  }, // drop 3
    { price: 649, inventory: 'in_stock',  timestamp: daysAgo(3)  }, // drop 4
    { price: 649, inventory: 'in_stock',  timestamp: daysAgo(0, 6) },
  ],
  addedAt:      daysAgo(42),
  lastChecked:  daysAgo(0, 6),
  isActive:     true,
  isHidden:     false,
  notifications: { browser: true, email: false },
};

/**
 * Item 2: The RealReal — Totême Scarf Coat
 * Scenario: at all-time low, 69% off MSRP, inventory just turned "low" on TRR
 * → expect "Buy now" (high confidence)
 */
const ITEM_BUY = {
  id:           'test_buy_toteme',
  url:          'https://www.therealreal.com/products/women/clothing/coats/test-toteme-scarf-coat',
  site:         'therealreal',
  siteName:     'The RealReal',
  name:         'Scarf Coat',
  brand:        'Totême',
  image:        'https://cdn.thereareal.com/uploads/test-toteme-coat.jpg',
  currentPrice:  399,
  originalPrice: 1290,
  currency:      'USD',
  folderId:      'therealreal',
  highPrice:     649,
  lowPrice:      399,
  inventory:     'low',
  priceHistory: [
    { price: 649, inventory: 'in_stock',  timestamp: daysAgo(36) },
    { price: 649, inventory: 'in_stock',  timestamp: daysAgo(29) },
    { price: 549, inventory: 'in_stock',  timestamp: daysAgo(22) },
    { price: 499, inventory: 'in_stock',  timestamp: daysAgo(15) },
    { price: 449, inventory: 'in_stock',  timestamp: daysAgo(10) },
    { price: 399, inventory: 'in_stock',  timestamp: daysAgo(6)  },
    { price: 399, inventory: 'in_stock',  timestamp: daysAgo(3)  },
    { price: 399, inventory: 'low',       timestamp: daysAgo(0, 8) }, // just turned low!
  ],
  addedAt:      daysAgo(36),
  lastChecked:  daysAgo(0, 8),
  isActive:     true,
  isHidden:     false,
  notifications: { browser: true, email: false },
};

/**
 * Item 3: SSENSE — Acne Studios Wool Scarf
 * Scenario: previous episode (sold out) + restock marker + new episode
 * → sparkline shows visual break; verdict is "Hold" (too few new-episode points)
 */
const ITEM_RESTOCK = {
  id:           'test_restock_acne',
  url:          'https://www.ssense.com/en-us/women/product/acne-studios/blue-wool-scarf/test',
  site:         'ssense',
  siteName:     'SSENSE',
  name:         'Wool Scarf',
  brand:        'Acne Studios',
  image:        'https://img.ssensemedia.com/images/test-acne-scarf.jpg',
  currentPrice:  185,
  originalPrice: 295,
  currency:      'USD',
  folderId:      'ssense',
  highPrice:     195,
  lowPrice:      165,
  inventory:     'in_stock',
  priceHistory: [
    // ── Episode 1 (old) ───────────────────────────────────────────────────────
    { price: 195, inventory: 'in_stock',   timestamp: daysAgo(60) },
    { price: 195, inventory: 'in_stock',   timestamp: daysAgo(52) },
    { price: 175, inventory: 'in_stock',   timestamp: daysAgo(44) },
    { price: 165, inventory: 'in_stock',   timestamp: daysAgo(37) },
    { price: 165, inventory: 'low',        timestamp: daysAgo(32) },
    { price: 165, inventory: 'out_of_stock', timestamp: daysAgo(28) },
    // ── Restock sentinel ─────────────────────────────────────────────────────
    { type: 'restock', price: 185, inventory: 'in_stock', timestamp: daysAgo(10) },
    // ── Episode 2 (current) ───────────────────────────────────────────────────
    { price: 185, inventory: 'in_stock',   timestamp: daysAgo(10) },
    { price: 185, inventory: 'in_stock',   timestamp: daysAgo(3)  },
  ],
  addedAt:      daysAgo(60),
  lastChecked:  daysAgo(3),
  isActive:     true,
  isHidden:     false,
  notifications: { browser: true, email: false },
};

// ─── Storage helpers ──────────────────────────────────────────────────────────

const TEST_IDS = [ITEM_WAIT.id, ITEM_BUY.id, ITEM_RESTOCK.id];

async function readStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['trackedItems', 'folders'], resolve);
  });
}

async function writeStorage(patch) {
  return new Promise((resolve) => {
    chrome.storage.local.set(patch, resolve);
  });
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function seed() {
  const data = await readStorage();
  const items = data.trackedItems || {};

  items[ITEM_WAIT.id]    = ITEM_WAIT;
  items[ITEM_BUY.id]     = ITEM_BUY;
  items[ITEM_RESTOCK.id] = ITEM_RESTOCK;

  // Make sure default site folders exist
  const folders = data.folders || {};
  if (!folders.ssense) {
    folders.ssense = { id: 'ssense', name: 'SSENSE', isDefault: true, order: 0 };
  }
  if (!folders.therealreal) {
    folders.therealreal = { id: 'therealreal', name: 'The RealReal', isDefault: true, order: 1 };
  }

  await writeStorage({ trackedItems: items, folders });
}

// ─── Clear test items ─────────────────────────────────────────────────────────

async function clearTestItems() {
  const data = await readStorage();
  const items = data.trackedItems || {};
  for (const id of TEST_IDS) delete items[id];
  await writeStorage({ trackedItems: items });
}

// ─── Wire up buttons ──────────────────────────────────────────────────────────

const statusEl = document.getElementById('status');

function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className   = isError ? 'status--err' : 'status--ok';
  statusEl.style.display = 'block';
  setTimeout(() => { statusEl.style.display = 'none'; }, 3500);
}

document.getElementById('btn-seed').addEventListener('click', async () => {
  try {
    await seed();
    showStatus('✓ 3 test items seeded. Open the popup → Tracked tab to see them.');
  } catch (err) {
    showStatus(`Error: ${err.message}`, true);
  }
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  try {
    await clearTestItems();
    showStatus('✓ Test items removed.');
  } catch (err) {
    showStatus(`Error: ${err.message}`, true);
  }
});
