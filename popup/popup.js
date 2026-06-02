/**
 * popup.js — BluberiBuy popup controller
 */

import {
  getSettings, saveSettings,
  getAllItems, getItem, isTracked,
  addItem, removeItem, recordPrice,
  updateItemNotifications,
  setTargetPrice,
  getFolders, addFolder, renameFolder, removeFolder, setItemFolder,
} from '../utils/storage.js';

import {
  formatPrice, formatTimestamp,
  drawSparkline, getInventoryLabel, formatDiscount,
} from '../utils/helpers.js';

import { analyzePriceTrend } from '../utils/heuristic.js';

// ─── Supported sites ──────────────────────────────────────────────────────────

const SUPPORTED_HOSTS = ['ssense.com', 'therealreal.com', 'fashionphile.com'];

function isSupportedUrl(url) {
  try { return SUPPORTED_HOSTS.some(h => new URL(url).hostname.includes(h)); }
  catch { return false; }
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

  await saveSettings({
    checkIntervalHours:  intervalHours,
    browserNotifications: $('setting-browser-notif').checked,
    emailNotifications:   $('setting-email-notif').checked,
    emailAddress:         $('setting-email').value.trim(),
    emailJsServiceId:     $('setting-emailjs-service').value.trim(),
    emailJsTemplateId:    $('setting-emailjs-template').value.trim(),
    emailJsPublicKey:     $('setting-emailjs-key').value.trim(),
  });
  chrome.runtime.sendMessage({ type: 'UPDATE_CHECK_INTERVAL', intervalHours });

  const saved = $('settings-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 1800);
});

async function loadSettingsIntoForm() {
  const s = await getSettings();
  $('setting-interval').value          = String(s.checkIntervalHours);
  $('setting-browser-notif').checked   = s.browserNotifications;
  $('setting-email-notif').checked     = s.emailNotifications;
  $('setting-email').value             = s.emailAddress || '';
  $('setting-emailjs-service').value   = s.emailJsServiceId || '';
  $('setting-emailjs-template').value  = s.emailJsTemplateId || '';
  $('setting-emailjs-key').value       = s.emailJsPublicKey || '';
}

// ─── State helpers ────────────────────────────────────────────────────────────

function showState(name) {
  Object.entries(states).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

// ─── Current item tab ─────────────────────────────────────────────────────────

let currentProductData = null;
let currentItemId      = null;

async function initCurrentTab() {
  showState('loading');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !isSupportedUrl(tab.url)) { showState('unsupported'); return; }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PRODUCT_DATA' });
  } catch {
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
  const img = $('product-img');
  img.src   = product.image || '';
  img.alt   = product.name;
  img.onerror = () => {
    const ph = document.createElement('div');
    ph.className   = 'product-card__hero img-placeholder';
    ph.textContent = (product.brand || product.name || '?').charAt(0).toUpperCase();
    img.replaceWith(ph);
  };

  $('product-brand').textContent = product.brand || '';
  $('product-name').textContent  = product.name;
  $('product-site').textContent  = product.siteName;

  $('price-current').textContent = formatPrice(product.price, product.currency);

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

  const { text: invText, color: invColor } = getInventoryLabel(product.inventory);
  const invBadge = $('inventory-badge');
  if (invText) {
    invBadge.textContent           = invText;
    invBadge.style.background      = invColor + '22';
    invBadge.style.color           = invColor;
    invBadge.classList.remove('hidden');
  } else {
    invBadge.classList.add('hidden');
  }

  await refreshTrackingUI();
}

async function refreshTrackingUI() {
  if (!currentItemId) return;

  let item = await getItem(currentItemId);
  const tracked = item !== null;

  if (tracked && currentProductData && currentProductData.price !== item.currentPrice) {
    await recordPrice(currentItemId, currentProductData.price, currentProductData.inventory || item.inventory);
    item = await getItem(currentItemId);
  }

  const btn = $('btn-track');

  if (tracked) {
    btn.textContent = '✓  Tracking';
    btn.className   = 'btn btn--tracking';

    $('wm-high').textContent   = formatPrice(item.highPrice, item.currency);
    $('wm-low').textContent    = formatPrice(item.lowPrice,  item.currency);
    $('wm-checks').textContent = item.priceHistory.filter(h => h.type !== 'restock').length;
    $('watermarks').classList.remove('hidden');

    const priceEntries = item.priceHistory.filter(h => h.type !== 'restock');
    if (priceEntries.length >= 2) {
      $('chart-wrap').classList.remove('hidden');
      drawSparkline($('sparkline'), item.priceHistory, {
        originalPrice: item.originalPrice || null,
        currency:      item.currency,
      });
    }

    const verdictEl = $('verdict-badge');
    if (priceEntries.length >= 2) {
      const { verdict, reason, confidence } = analyzePriceTrend(item);
      const ICONS  = { buy: '🟢', wait: '🟡', hold: '⚪' };
      const LABELS = { buy: 'Buy now', wait: 'Wait a bit', hold: 'Hold steady' };
      const DOTS   = { high: '●●●', medium: '●●○', low: '●○○' };

      verdictEl.className             = `verdict verdict--${verdict}`;
      $('verdict-icon').textContent   = ICONS[verdict];
      $('verdict-label').textContent  = LABELS[verdict];
      $('verdict-reason').textContent = reason;
      $('verdict-conf').textContent   = DOTS[confidence] ?? '';
      $('verdict-conf').title         = `Confidence: ${confidence}`;
    } else {
      verdictEl.className = 'verdict hidden';
    }

    // Notification toggles
    $('notif-settings').classList.remove('hidden');
    $('toggle-browser').checked  = item.notifications?.browser ?? true;
    $('toggle-email').checked    = item.notifications?.email   ?? false;
    $('toggle-browser').onchange = async (e) => {
      await updateItemNotifications(currentItemId, { browser: e.target.checked });
    };
    $('toggle-email').onchange = async (e) => {
      await updateItemNotifications(currentItemId, { email: e.target.checked });
    };

    // Target price
    const targetInput = $('target-price');
    targetInput.value = item.targetPrice != null ? String(item.targetPrice) : '';
    targetInput.onchange = async () => {
      const val = targetInput.value.trim();
      const price = val === '' ? null : parseFloat(val);
      await setTargetPrice(currentItemId, isNaN(price) ? null : price);
    };

    // Last-checked timestamp
    $('refresh-ts').textContent = item.lastChecked
      ? `Updated ${formatTimestamp(item.lastChecked)}`
      : '';

  } else {
    btn.textContent = 'Track this item';
    btn.className   = 'btn btn--primary';
    $('watermarks').classList.add('hidden');
    $('chart-wrap').classList.add('hidden');
    $('verdict-badge').className = 'verdict hidden';
    $('notif-settings').classList.add('hidden');
  }
}

// Track / Untrack
$('btn-track').addEventListener('click', async () => {
  if (!currentProductData) return;
  const btn     = $('btn-track');
  btn.disabled  = true;

  const tracked = await isTracked(currentItemId);
  if (tracked) {
    await removeItem(currentItemId);
  } else {
    await addItem(currentProductData);
  }

  btn.disabled = false;
  await refreshTrackingUI();
  updateTrackedBadge();
});

// Manual refresh
$('btn-refresh').addEventListener('click', async () => {
  if (!currentItemId) return;
  const refreshBtn = $('btn-refresh');
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;

  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'REFRESH_ITEM', itemId: currentItemId },
        (res) => res?.success ? resolve() : reject(new Error(res?.error || 'failed'))
      );
    });
    await refreshTrackingUI();
  } catch {
    // Silently ignore — UI stays current from last known state
  }

  refreshBtn.classList.remove('spinning');
  refreshBtn.disabled = false;
});

// ─── Tracked items tab ────────────────────────────────────────────────────────

let dragItemId   = null;
let dragSourceId = null;

async function renderTrackedList() {
  const [allItems, folders] = await Promise.all([getAllItems(), getFolders()]);
  const container = $('folder-list');
  const empty     = $('tracked-empty');

  container.innerHTML = '';

  // Sort & filter
  const sortBy      = $('sort-select').value;
  const inStockOnly = $('filter-instock').checked;

  let itemArr = Object.values(allItems);
  if (inStockOnly) {
    itemArr = itemArr.filter(i => i.inventory === 'in_stock' || i.inventory === 'low');
  }
  itemArr = sortItems(itemArr, sortBy);

  if (itemArr.length === 0) {
    empty.classList.remove('hidden');
    $('summary-bar').classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Summary bar
  renderSummaryBar(Object.values(allItems));

  // Build an id→item map from the sorted+filtered array so folder rendering respects the sort
  const sortedIds = itemArr.map(i => i.id);

  const folderArr = Object.values(folders).sort((a, b) => a.order - b.order);
  for (const folder of folderArr) {
    const folderItems = sortedIds
      .map(id => allItems[id])
      .filter(item => item && (item.folderId || item.site) === folder.id);

    if (folder.isDefault && folderItems.length === 0) continue;
    container.appendChild(buildFolderSection(folder, folderItems, folders));
  }
}

function sortItems(items, by) {
  return [...items].sort((a, b) => {
    switch (by) {
      case 'drop': {
        const dropA = a.originalPrice ? (a.originalPrice - a.currentPrice) / a.originalPrice
          : (a.priceHistory[0]?.price - a.currentPrice) / (a.priceHistory[0]?.price || 1);
        const dropB = b.originalPrice ? (b.originalPrice - b.currentPrice) / b.originalPrice
          : (b.priceHistory[0]?.price - b.currentPrice) / (b.priceHistory[0]?.price || 1);
        return dropB - dropA;
      }
      case 'updated':
        return (b.lastChecked || 0) - (a.lastChecked || 0);
      case 'price-asc':
        return a.currentPrice - b.currentPrice;
      default: // 'added'
        return (b.addedAt || 0) - (a.addedAt || 0);
    }
  });
}

function renderSummaryBar(items) {
  const bar      = $('summary-bar');
  const countEl  = $('summary-count');
  const savingsEl= $('summary-savings');

  bar.classList.remove('hidden');
  countEl.textContent = `${items.length} item${items.length !== 1 ? 's' : ''} tracked`;

  const totalSavings = items.reduce((sum, item) => {
    if (item.originalPrice && item.originalPrice > item.currentPrice) {
      return sum + (item.originalPrice - item.currentPrice);
    }
    return sum;
  }, 0);

  if (totalSavings > 0) {
    savingsEl.textContent = `${formatPrice(totalSavings, 'USD')} off MSRP`;
    savingsEl.classList.remove('hidden');
  } else {
    savingsEl.classList.add('hidden');
  }
}

// Sort/filter change listeners
$('sort-select').addEventListener('change', renderTrackedList);
$('filter-instock').addEventListener('change', renderTrackedList);

function buildFolderSection(folder, folderItems, allFolders) {
  const section = document.createElement('div');
  section.className        = 'folder-section';
  section.dataset.folderId = folder.id;

  const header = document.createElement('div');
  header.className = 'folder-header';
  header.innerHTML = `
    <span class="folder-header__chevron">▾</span>
    <span class="folder-header__name">${escHtml(folder.name)}</span>
    <span class="folder-header__count">${folderItems.length}</span>
    <div class="folder-header__actions">
      <button class="folder-action-btn" data-action="rename" title="Rename">✎</button>
      ${!folder.isDefault ? `<button class="folder-action-btn folder-action-btn--delete" data-action="delete" title="Delete">✕</button>` : ''}
    </div>
  `;

  header.addEventListener('click', (e) => {
    if (e.target.dataset.action) return;
    section.classList.toggle('folder-section--collapsed');
  });

  header.querySelector('[data-action="rename"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    startRename(header, folder);
  });

  const deleteBtn = header.querySelector('[data-action="delete"]');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (deleteBtn.dataset.confirming === 'true') {
        await removeFolder(folder.id);
        await renderTrackedList();
        updateTrackedBadge();
      } else {
        deleteBtn.dataset.confirming = 'true';
        deleteBtn.textContent        = 'Sure?';
        deleteBtn.style.color        = 'var(--red)';
        setTimeout(() => {
          if (deleteBtn.dataset.confirming === 'true') {
            deleteBtn.dataset.confirming = 'false';
            deleteBtn.textContent        = '✕';
            deleteBtn.style.color        = '';
          }
        }, 2500);
      }
    });
  }

  section.addEventListener('dragover', (e) => {
    e.preventDefault();
    section.classList.add('folder-section--drag-over');
  });
  section.addEventListener('dragleave', (e) => {
    if (!section.contains(e.relatedTarget)) section.classList.remove('folder-section--drag-over');
  });
  section.addEventListener('drop', async (e) => {
    e.preventDefault();
    section.classList.remove('folder-section--drag-over');
    if (!dragItemId || dragSourceId === folder.id) return;
    await setItemFolder(dragItemId, folder.id);
    await renderTrackedList();
  });

  const body = document.createElement('div');
  body.className = 'folder-body';

  if (folderItems.length === 0) {
    const empty = document.createElement('div');
    empty.className   = 'folder-empty';
    empty.textContent = 'Drop items here';
    body.appendChild(empty);
  } else {
    for (const item of folderItems) {
      body.appendChild(buildItemCard(item, folder.id));
    }
  }

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

function buildItemCard(item, folderId) {
  const card = document.createElement('div');
  card.className      = 'item-card';
  card.draggable      = true;
  card.dataset.itemId = item.id;

  // Inventory dot
  const dot = document.createElement('div');
  dot.className = `item-card__inv-dot item-card__inv-dot--${item.inventory}`;
  card.appendChild(dot);

  // Image
  const img = document.createElement('img');
  img.className = 'item-card__img';
  img.src       = item.image || '';
  img.alt       = item.name;
  img.onerror   = () => {
    const ph = document.createElement('div');
    ph.className   = 'item-card__img img-placeholder';
    ph.textContent = (item.brand || item.name || '?').charAt(0).toUpperCase();
    img.replaceWith(ph);
  };
  card.appendChild(img);

  // Hover overlay
  const overlay = document.createElement('div');
  overlay.className = 'item-card__overlay';

  const firstPrice = item.priceHistory[0]?.price ?? item.currentPrice;
  const delta      = item.currentPrice - firstPrice;
  let deltaHtml    = '';
  if (item.originalPrice && item.originalPrice > item.currentPrice) {
    deltaHtml = `<span class="item-card__delta item-card__delta--drop">${formatDiscount(item.originalPrice, item.currentPrice)}</span>`;
  } else if (delta < 0) {
    deltaHtml = `<span class="item-card__delta item-card__delta--drop">↓ ${formatPrice(Math.abs(delta), item.currency)}</span>`;
  } else if (delta > 0) {
    deltaHtml = `<span class="item-card__delta item-card__delta--rise">↑ ${formatPrice(delta, item.currency)}</span>`;
  }

  overlay.innerHTML = `
    <div class="item-card__brand">${escHtml(item.brand || item.siteName)}</div>
    <div class="item-card__name">${escHtml(item.name)}</div>
    <div class="item-card__price-row">
      <span class="item-card__price">${formatPrice(item.currentPrice, item.currency)}</span>
      ${deltaHtml}
    </div>
  `;
  card.appendChild(overlay);

  // Remove button
  const removeBtn = document.createElement('button');
  removeBtn.className    = 'item-card__remove';
  removeBtn.title        = 'Stop tracking';
  removeBtn.textContent  = '✕';
  removeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await removeItem(item.id);
    card.remove();
    updateTrackedBadge();
    await renderTrackedList();
  });
  card.appendChild(removeBtn);

  // Open product page on click (not on remove)
  card.addEventListener('click', (e) => {
    if (e.target === removeBtn) return;
    chrome.tabs.create({ url: item.url });
  });

  // Drag
  card.addEventListener('dragstart', (e) => {
    dragItemId   = item.id;
    dragSourceId = folderId;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    dragItemId   = null;
    dragSourceId = null;
    card.classList.remove('dragging');
    document.querySelectorAll('.folder-section--drag-over')
      .forEach(el => el.classList.remove('folder-section--drag-over'));
  });

  return card;
}

// ─── Inline folder rename ─────────────────────────────────────────────────────

function startRename(header, folder) {
  const nameEl = header.querySelector('.folder-header__name');
  const input  = document.createElement('input');
  input.className = 'folder-header__rename';
  input.value     = folder.name;
  input.maxLength = 40;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim() || folder.name;
    await renameFolder(folder.id, newName);
    await renderTrackedList();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') { input.value = folder.name; input.blur(); }
  });
}

// ─── Add folder button ────────────────────────────────────────────────────────

$('btn-add-folder').addEventListener('click', async () => {
  const folder = await addFolder('New Folder');
  await renderTrackedList();
  const newSection = document.querySelector(`[data-folder-id="${folder.id}"]`);
  if (newSection) startRename(newSection.querySelector('.folder-header'), folder);
});

// ─── Badge & summary ──────────────────────────────────────────────────────────

async function updateTrackedBadge() {
  const items = await getAllItems();
  const count = Object.keys(items).length;
  const badge = $('tracked-count');
  badge.textContent = count > 0 ? String(count) : '';
  badge.classList.toggle('hidden', count === 0);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
  await updateTrackedBadge();
  await initCurrentTab();
})();
