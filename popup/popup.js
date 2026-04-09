/**
 * popup.js — PriceThread popup controller
 *
 * Loaded as an ES module (type="module" in popup.html).
 * Imports from utils/ using relative paths — no bundler needed.
 *
 * Flow:
 *  1. Get the active tab's URL
 *  2. If it matches a supported site, ask the content script for product data
 *  3. Check chrome.storage to see if the item is already tracked
 *  4. Render the appropriate UI state
 *  5. Handle track / untrack / notifications / settings interactions
 */

import {
  getSettings, saveSettings,
  getAllItems,  getItem, isTracked,
  addItem, removeItem, recordPrice,
  updateItemNotifications,
  getFolders, addFolder, renameFolder, removeFolder, setItemFolder,
} from '../utils/storage.js';

import {
  formatPrice, formatTimestamp,
  drawSparkline, getInventoryLabel, formatDiscount,
} from '../utils/helpers.js';

import { analyzePriceTrend } from '../utils/heuristic.js';

// ─── Supported sites (must mirror manifest.json host_permissions) ─────────────

const SUPPORTED_HOSTS = ['ssense.com', 'therealreal.com'];

function isSupportedUrl(url) {
  try {
    return SUPPORTED_HOSTS.some(h => new URL(url).hostname.includes(h));
  } catch { return false; }
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const states = {
  loading:     $('state-loading'),
  unsupported: $('state-unsupported'),
  error:       $('state-error'),
  product:     $('state-product'),
};

// ─── Tab switching ────────────────────────────────────────────────────────────

const tabs = document.querySelectorAll('.tab');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('tab--active'));
    tab.classList.add('tab--active');

    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    $(`panel-${tab.dataset.tab}`).classList.remove('hidden');

    if (tab.dataset.tab === 'tracked') renderTrackedList();
  });
});

// ─── Settings panel ───────────────────────────────────────────────────────────

$('btn-settings').addEventListener('click', async () => {
  const panel = $('settings-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) await loadSettingsIntoForm();
});

$('btn-close-settings').addEventListener('click', () => {
  $('settings-panel').classList.add('hidden');
});

$('btn-save-settings').addEventListener('click', async () => {
  const intervalHours = parseInt($('setting-interval').value, 10);
  const browserNotif  = $('setting-browser-notif').checked;

  await saveSettings({
    checkIntervalHours:   intervalHours,
    browserNotifications: browserNotif,
  });

  // Tell the service worker to reschedule the alarm
  chrome.runtime.sendMessage({ type: 'UPDATE_CHECK_INTERVAL', intervalHours });

  // Flash "Saved"
  const saved = $('settings-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 1800);
});

async function loadSettingsIntoForm() {
  const s = await getSettings();
  $('setting-interval').value          = String(s.checkIntervalHours);
  $('setting-browser-notif').checked   = s.browserNotifications;
  $('setting-email').value             = s.emailAddress || '';
}

// ─── Show / hide state helpers ────────────────────────────────────────────────

function showState(name) {
  Object.entries(states).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

// ─── Current item tab ─────────────────────────────────────────────────────────

let currentProductData = null; // product data from content script
let currentItemId      = null;

async function initCurrentTab() {
  showState('loading');

  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !isSupportedUrl(tab.url)) {
    showState('unsupported');
    return;
  }

  // Ask the content script for product data
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PRODUCT_DATA' });
  } catch (err) {
    // Content script might not be injected yet (e.g., extension just installed)
    showState('error');
    $('state-error-msg').textContent = 'Reload the product page and try again.';
    return;
  }

  if (!response?.success) {
    showState('error');
    $('state-error-msg').textContent = response?.error || 'Unknown error reading the page.';
    return;
  }

  currentProductData = response.data;
  currentItemId      = response.data.id;

  await renderProductView(response.data);
  showState('product');
}

async function renderProductView(product) {
  // Product card
  const img = $('product-img');
  img.src = product.image || '';
  img.alt = product.name;
  img.onerror = () => { img.style.display = 'none'; };

  $('product-brand').textContent = product.brand || '';
  $('product-name').textContent  = product.name;
  $('product-site').textContent  = product.siteName;

  // Current price
  $('price-current').textContent = formatPrice(product.price, product.currency);

  // MSRP + discount (shown even before tracking, straight from the page)
  const origEl     = $('price-original');
  const discountEl = $('price-discount');
  if (product.originalPrice && product.originalPrice > product.price) {
    origEl.textContent     = formatPrice(product.originalPrice, product.currency);
    discountEl.textContent = formatDiscount(product.originalPrice, product.price);
    origEl.classList.remove('hidden');
    discountEl.classList.remove('hidden');
  } else {
    origEl.classList.add('hidden');
    discountEl.classList.add('hidden');
  }

  // Inventory badge
  const { text: invText, color: invColor } = getInventoryLabel(product.inventory);
  const invBadge = $('inventory-badge');
  if (invText) {
    invBadge.textContent  = invText;
    invBadge.style.background = invColor + '22';
    invBadge.style.color      = invColor;
    invBadge.classList.remove('hidden');
  } else {
    invBadge.classList.add('hidden');
  }

  // Check if already tracked and render watermarks / sparkline / button
  await refreshTrackingUI();
}

async function refreshTrackingUI() {
  if (!currentItemId) return;

  let item = await getItem(currentItemId);
  const tracked = item !== null;

  // If the live page shows a price we haven't recorded yet, persist it now.
  // This keeps the watermarks, chart, and check-count in sync whenever the
  // popup is opened on a tracked product page.
  if (tracked && currentProductData && currentProductData.price !== item.currentPrice) {
    await recordPrice(
      currentItemId,
      currentProductData.price,
      currentProductData.inventory || item.inventory,
    );
    item = await getItem(currentItemId); // re-fetch with updated watermarks + history
  }
  const btn     = $('btn-track');

  if (tracked) {
    btn.textContent = '✓  Tracking';
    btn.className   = 'btn btn--tracking';

    // Watermarks
    $('wm-high').textContent   = formatPrice(item.highPrice, item.currency);
    $('wm-low').textContent    = formatPrice(item.lowPrice, item.currency);
    $('wm-checks').textContent = item.priceHistory.filter(h => h.type !== 'restock').length;
    $('watermarks').classList.remove('hidden');

    // Sparkline — pass originalPrice so it draws the MSRP reference line
    const priceEntries = item.priceHistory.filter(h => h.type !== 'restock');
    if (priceEntries.length >= 2) {
      $('chart-wrap').classList.remove('hidden');
      drawSparkline($('sparkline'), item.priceHistory, {
        originalPrice: item.originalPrice || null,
      });
    }

    // Verdict badge — show once we have at least 2 real price entries
    const verdictEl = $('verdict-badge');
    if (priceEntries.length >= 2) {
      const { verdict, reason, confidence } = analyzePriceTrend(item);
      const ICONS   = { buy: '🟢', wait: '🟡', hold: '⚪' };
      const LABELS  = { buy: 'Buy now',  wait: 'Wait a bit', hold: 'Hold steady' };
      const DOTS    = { high: '●●●', medium: '●●○', low: '●○○' };

      verdictEl.className = `verdict verdict--${verdict}`;
      $('verdict-icon').textContent  = ICONS[verdict];
      $('verdict-label').textContent = LABELS[verdict];
      $('verdict-reason').textContent = reason;
      $('verdict-conf').textContent  = DOTS[confidence] ?? '';
      $('verdict-conf').title = `Confidence: ${confidence}`;
    } else {
      verdictEl.className = 'verdict hidden';
    }

    // Notification toggles
    $('notif-settings').classList.remove('hidden');
    $('toggle-browser').checked = item.notifications?.browser ?? true;
    $('toggle-email').checked   = item.notifications?.email   ?? false;

    $('toggle-browser').onchange = async (e) => {
      await updateItemNotifications(currentItemId, { browser: e.target.checked });
    };

  } else {
    btn.textContent = 'Track this item';
    btn.className   = 'btn btn--primary';
    $('watermarks').classList.add('hidden');
    $('chart-wrap').classList.add('hidden');
    $('verdict-badge').className = 'verdict hidden';
    $('notif-settings').classList.add('hidden');
  }
}

// Track / Untrack button
$('btn-track').addEventListener('click', async () => {
  if (!currentProductData) return;

  const tracked = await isTracked(currentItemId);
  if (tracked) {
    await removeItem(currentItemId);
  } else {
    await addItem(currentProductData);
  }

  await refreshTrackingUI();
  updateTrackedBadge();
});

// ─── Tracked items tab — folder view ─────────────────────────────────────────

// Drag state
let dragItemId   = null;
let dragSourceId = null; // folder the item came from

async function renderTrackedList() {
  const [items, folders] = await Promise.all([getAllItems(), getFolders()]);
  const container = $('folder-list');
  const empty     = $('tracked-empty');
  const itemArr   = Object.values(items);

  container.innerHTML = '';

  if (itemArr.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Sort folders by order, then render each
  const folderArr = Object.values(folders).sort((a, b) => a.order - b.order);

  for (const folder of folderArr) {
    // Items belonging to this folder (migrate old items with no folderId to site folder)
    const folderItems = itemArr
      .filter(item => (item.folderId || item.site) === folder.id)
      .sort((a, b) => b.addedAt - a.addedAt);

    // Skip default folders that have no items (keep UI clean)
    if (folder.isDefault && folderItems.length === 0) continue;

    container.appendChild(buildFolderSection(folder, folderItems, folders));
  }
}

function buildFolderSection(folder, folderItems, allFolders) {
  const section = document.createElement('div');
  section.className = 'folder-section';
  section.dataset.folderId = folder.id;

  // ── Header ──────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'folder-header';
  header.innerHTML = `
    <span class="folder-header__chevron">▾</span>
    <span class="folder-header__name">${escHtml(folder.name)}</span>
    <span class="folder-header__count">${folderItems.length}</span>
    <div class="folder-header__actions">
      <button class="folder-action-btn" data-action="rename" title="Rename">✎</button>
      ${!folder.isDefault ? `<button class="folder-action-btn folder-action-btn--delete" data-action="delete" title="Delete folder">✕</button>` : ''}
    </div>
  `;

  // Toggle collapse
  header.addEventListener('click', (e) => {
    if (e.target.dataset.action) return; // let action buttons handle their own clicks
    section.classList.toggle('folder-section--collapsed');
  });

  // Rename
  header.querySelector('[data-action="rename"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    startRename(header, folder);
  });

  // Delete folder — two-step to prevent accidental deletion
  // (window.confirm is blocked in MV3 extension popups)
  const deleteBtn = header.querySelector('[data-action="delete"]');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (deleteBtn.dataset.confirming === 'true') {
        // Second click — confirmed, do the delete
        await removeFolder(folder.id);
        await renderTrackedList();
        updateTrackedBadge();
      } else {
        // First click — ask for confirmation inline
        deleteBtn.dataset.confirming = 'true';
        deleteBtn.textContent = 'Sure?';
        deleteBtn.style.color = 'var(--red)';
        // Auto-reset if user doesn't confirm within 2.5 seconds
        setTimeout(() => {
          if (deleteBtn.dataset.confirming === 'true') {
            deleteBtn.dataset.confirming = 'false';
            deleteBtn.textContent = '✕';
            deleteBtn.style.color = '';
          }
        }, 2500);
      }
    });
  }

  // ── Drag-over on header = drop into this folder ──────────────────────────────
  section.addEventListener('dragover', (e) => {
    e.preventDefault();
    section.classList.add('folder-section--drag-over');
  });
  section.addEventListener('dragleave', (e) => {
    if (!section.contains(e.relatedTarget)) {
      section.classList.remove('folder-section--drag-over');
    }
  });
  section.addEventListener('drop', async (e) => {
    e.preventDefault();
    section.classList.remove('folder-section--drag-over');
    if (!dragItemId || dragSourceId === folder.id) return;
    await setItemFolder(dragItemId, folder.id);
    await renderTrackedList();
  });

  // ── Body ─────────────────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'folder-body';

  if (folderItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'folder-empty';
    empty.textContent = 'Drop items here';
    body.appendChild(empty);
  } else {
    for (const item of folderItems) {
      body.appendChild(buildItemRow(item, folder.id));
    }
  }

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

function buildItemRow(item, folderId) {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.draggable = true;
  row.dataset.itemId = item.id;

  // Delta label
  const history    = item.priceHistory;
  const firstPrice = history[0]?.price ?? item.currentPrice;
  const delta      = item.currentPrice - firstPrice;
  let deltaClass   = 'item-row__delta--same';
  let deltaText    = '';

  if (item.originalPrice && item.originalPrice > item.currentPrice) {
    deltaClass = 'item-row__delta--drop';
    deltaText  = formatDiscount(item.originalPrice, item.currentPrice);
  } else if (delta < 0) {
    deltaClass = 'item-row__delta--drop';
    deltaText  = `↓ ${formatPrice(Math.abs(delta), item.currency)}`;
  } else if (delta > 0) {
    deltaClass = 'item-row__delta--rise';
    deltaText  = `↑ ${formatPrice(delta, item.currency)}`;
  }

  row.innerHTML = `
    <span class="item-row__drag" title="Drag to move">⠿</span>
    <img class="item-row__img" src="${escHtml(item.image)}" alt="${escHtml(item.name)}"
         onerror="this.style.display='none'" />
    <div class="item-row__body">
      <div class="item-row__brand">${escHtml(item.brand || item.siteName)}</div>
      <div class="item-row__name">${escHtml(item.name)}</div>
      <div class="item-row__price-wrap">
        <span class="item-row__price">${formatPrice(item.currentPrice, item.currency)}</span>
        ${deltaText ? `<span class="item-row__delta ${deltaClass}">${deltaText}</span>` : ''}
      </div>
    </div>
    <button class="item-row__remove" title="Stop tracking" aria-label="Remove">✕</button>
  `;

  // Open product page on body click
  row.querySelector('.item-row__body').addEventListener('click', () => {
    chrome.tabs.create({ url: item.url });
  });

  // Remove
  row.querySelector('.item-row__remove').addEventListener('click', async (e) => {
    e.stopPropagation();
    await removeItem(item.id);
    row.remove();
    updateTrackedBadge();
    // Re-render to clean up empty folder sections
    await renderTrackedList();
  });

  // Drag source events
  row.addEventListener('dragstart', (e) => {
    dragItemId   = item.id;
    dragSourceId = folderId;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => {
    dragItemId   = null;
    dragSourceId = null;
    row.classList.remove('dragging');
    // Clean up any leftover drag-over states
    document.querySelectorAll('.folder-section--drag-over')
      .forEach(el => el.classList.remove('folder-section--drag-over'));
  });

  return row;
}

// ── Inline folder rename ──────────────────────────────────────────────────────

function startRename(header, folder) {
  const nameEl = header.querySelector('.folder-header__name');
  const input  = document.createElement('input');
  input.className   = 'folder-header__rename';
  input.value       = folder.name;
  input.maxLength   = 40;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim() || folder.name;
    await renameFolder(folder.id, newName);
    await renderTrackedList();
  };

  input.addEventListener('blur',    commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { input.blur(); }
    if (e.key === 'Escape') { input.value = folder.name; input.blur(); }
  });
}

// ── Add folder button ─────────────────────────────────────────────────────────

$('btn-add-folder').addEventListener('click', async () => {
  const folder = await addFolder('New Folder');
  await renderTrackedList();
  // Immediately start renaming the new folder
  const newSection = document.querySelector(`[data-folder-id="${folder.id}"]`);
  if (newSection) {
    const header = newSection.querySelector('.folder-header');
    startRename(header, folder);
  }
});

// ─── Badge ────────────────────────────────────────────────────────────────────

async function updateTrackedBadge() {
  const items = await getAllItems();
  const count = Object.keys(items).length;
  const badge = $('tracked-count');
  badge.textContent = count > 0 ? String(count) : '';
  badge.classList.toggle('hidden', count === 0);
}

// Re-render tracked list when tab is clicked (keeps it fresh after tracking/untracking)
tabs.forEach(tab => {
  if (tab.dataset.tab === 'tracked') {
    tab.addEventListener('click', renderTrackedList, { once: false });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
  await updateTrackedBadge();
  await initCurrentTab();
})();
