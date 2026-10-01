/**
 * popup.js — BluberiBuy popup controller
 */

import {
  getSettings, saveSettings,
  getAllItems, getItem, isTracked,
  addItem, removeItem,
  updateItemNotifications,
  setTargetPrice,
  getFolders, addFolder, renameFolder, removeFolder, setItemFolder,
  getRefreshJob, REFRESH_JOB_KEY, ROOT_KEY, EMAIL_STATUS_KEY,
} from '../utils/storage.js';

import {
  formatPrice, formatTimestamp,
  drawSparkline, getInventoryLabel, formatDiscount,
} from '../utils/helpers.js';

import { analyzePriceTrend } from '../utils/heuristic.js';
import { isEmailConfigured, SENDER_ADDRESS } from '../utils/email-config.js';

// ─── Supported sites ──────────────────────────────────────────────────────────

const SUPPORTED_HOSTS = ['ssense.com', 'therealreal.com', 'fashionphile.com', 'theoutnet.com', 'vestiairecollective.com'];

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
    if (tab.dataset.tab === 'drops')   openDropsTab();
  });
});

// ─── Settings panel ───────────────────────────────────────────────────────────

function openSettings() {
  $('settings-panel').classList.remove('hidden');
  document.body.classList.add('settings-open');
  window.scrollTo(0, 0);
  return loadSettingsIntoForm();
}

function closeSettings() {
  $('settings-panel').classList.add('hidden');
  document.body.classList.remove('settings-open');
  refreshEmailWarning();
}

$('btn-settings').addEventListener('click', async () => {
  if ($('settings-panel').classList.contains('hidden')) await openSettings();
  else closeSettings();
});

$('btn-close-settings').addEventListener('click', closeSettings);

$('btn-save-settings').addEventListener('click', async () => {
  const intervalHours = parseInt($('setting-interval').value, 10);

  await saveSettings({
    checkIntervalHours:  intervalHours,
    browserNotifications: $('setting-browser-notif').checked,
    emailAddress:         $('setting-email').value.trim(),
  });
  chrome.runtime.sendMessage({ type: 'UPDATE_CHECK_INTERVAL', intervalHours });

  const saved = $('settings-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 1800);
});

// Flag an address that doesn't look like an email while it's being typed
function refreshSettingsEmailWarning() {
  const input = $('setting-email');
  const bad   = input.value.trim() !== '' && !input.checkValidity();
  const warn  = $('settings-email-warn');
  warn.textContent = bad ? '⚠️ That doesn\'t look like a valid email address.' : '';
  warn.classList.toggle('hidden', !bad);
}

$('setting-email').addEventListener('input', refreshSettingsEmailWarning);

/** Returns a short description of what's missing for email alerts, or null if ready. */
function emailSetupProblem(s) {
  if (!s.emailAddress)        return 'No email address set.';
  if (!isEmailConfigured())   return 'Email sending isn\'t set up in this build yet.';
  return null;
}

$('sender-address').textContent = SENDER_ADDRESS;

async function loadSettingsIntoForm() {
  const s = await getSettings();
  $('setting-interval').value          = String(s.checkIntervalHours);
  $('setting-browser-notif').checked   = s.browserNotifications;
  $('setting-email').value             = s.emailAddress || '';
  refreshSettingsEmailWarning();  const { [EMAIL_STATUS_KEY]: status } = await chrome.storage.local.get(EMAIL_STATUS_KEY);
  renderEmailStatus(status);
}

// Last alert email's outcome — failures are otherwise invisible
function renderEmailStatus(status) {
  const el = $('email-status');
  el.classList.toggle('hidden', !status);
  if (!status) return;
  el.className = status.ok ? 'email-status email-status--ok' : 'warn';
  el.textContent = status.ok
    ? `✓ Last email sent ${formatTimestamp(status.at)}`
    : `⚠️ Last email failed ${formatTimestamp(status.at)}: ${status.error}`;
}

$('btn-test-email').addEventListener('click', async () => {
  const btn = $('btn-test-email');
  const email = $('setting-email').value.trim();
  if (!email || !$('setting-email').checkValidity()) {
    renderEmailStatus({ ok: false, error: 'Enter a valid email address first.', at: Date.now() });
    return;
  }
  btn.disabled    = true;
  btn.textContent = 'Sending…';
  // Save first so the test goes to the address currently in the field
  await saveSettings({ emailAddress: email });
  let res;
  try {
    // EmailJS gets 15s in the worker; give up a little after that
    res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'SEND_TEST_EMAIL' }),
      new Promise(resolve => setTimeout(() => resolve({
        ok: false, error: 'No response — try reloading the extension at chrome://extensions.',
      }), 20_000)),
    ]);
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  if (!res) res = { ok: false, error: 'No response — try reloading the extension at chrome://extensions.' };
  renderEmailStatus({ ...res, at: Date.now() });
  if (res?.ok) {
    $('email-status').textContent =
      `✓ Test email sent to ${email}. Not in your inbox? Check spam, mark it "Not spam", ` +
      `and add ${SENDER_ADDRESS} to your contacts.`;
  }
  btn.disabled    = false;
  btn.textContent = 'Send test email';
});

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
    // Through the service worker, so a drop seen here still sends its alerts
    await chrome.runtime.sendMessage({ type: 'PAGE_PRICE_UPDATE', data: currentProductData }).catch(() => {});
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
    $('toggle-browser').checked      = item.notifications?.browser ?? true;
    $('toggle-email-drop').checked   = wantsEmail(item, 'drop');
    $('toggle-email-target').checked = wantsEmail(item, 'target');
    $('toggle-browser').onchange = async (e) => {
      await updateItemNotifications(currentItemId, { browser: e.target.checked });
    };
    $('toggle-email-drop').onchange = async (e) => {
      await updateItemNotifications(currentItemId, { emailDrop: e.target.checked });
      await refreshEmailWarning();
    };
    $('toggle-email-target').onchange = async (e) => {
      await updateItemNotifications(currentItemId, { emailTarget: e.target.checked });
      await refreshEmailWarning();
    };
    await refreshEmailWarning();

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

// Older items stored a single `email` flag — it now seeds both email options
function wantsEmail(item, kind) {
  const n = item.notifications || {};
  return (kind === 'target' ? n.emailTarget : n.emailDrop) ?? n.email ?? false;
}

async function refreshEmailWarning() {
  const warn = $('email-warn');
  const anyOn = $('toggle-email-drop').checked || $('toggle-email-target').checked;
  const msg = anyOn ? emailSetupProblem(await getSettings()) : null;
  warn.classList.toggle('hidden', !msg);
  if (!msg) return;
  warn.innerHTML = `⚠️ ${escHtml(msg)} <a id="email-warn-link">Add your email</a> to get these.`;
  $('email-warn-link').addEventListener('click', openSettings);
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

// ─── Drops tab ────────────────────────────────────────────────────────────────

/**
 * Recent price drops, newest first. Derived from each item's priceHistory —
 * nothing extra is stored; the window only limits what's shown.
 *
 * Per item, the drops inside the window are combined: "was" is the price just
 * before the earliest of them, "now" is the current price, and the row is
 * dated by the latest. Items whose price has since climbed back to (or above)
 * the "was" price are left out — that drop is over.
 */
function findRecentDrops(items, windowDays) {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const drops  = [];

  for (const item of Object.values(items)) {
    const entries = (item.priceHistory || []).filter(h => h.type !== 'restock');
    let wasPrice = null, lastDropAt = 0, count = 0;

    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1], cur = entries[i];
      if (cur.timestamp < cutoff || cur.price >= prev.price) continue;
      if (wasPrice == null) wasPrice = prev.price;
      lastDropAt = cur.timestamp;
      count++;
    }

    const now = item.currentPrice;
    if (!count || now == null || now >= wasPrice) continue;
    drops.push({ item, wasPrice, nowPrice: now, lastDropAt, count });
  }

  return drops.sort((a, b) => b.lastDropAt - a.lastDropAt);
}

// "Seen" cutoff as of when the tab was opened, so NEW marks survive filter changes
let dropsSeenAtOnOpen = 0;

async function openDropsTab() {
  const settings = await getSettings();
  dropsSeenAtOnOpen = settings.dropsSeenAt;
  $('drops-window').value = String(settings.dropsWindowDays);
  await renderDrops(dropsSeenAtOnOpen);
  // Rows keep their "new" mark while the tab is open; next time they're seen
  await saveSettings({ dropsSeenAt: Date.now() });
  $('drops-new-count').classList.add('hidden');
}

async function renderDrops(seenAt) {
  const windowDays = parseInt($('drops-window').value, 10);
  const hideSold   = $('drops-hide-sold').checked;
  const items      = await getAllItems();

  let drops = findRecentDrops(items, windowDays);
  if (hideSold) drops = drops.filter(d => d.item.inventory !== 'sold');

  const list = $('drop-list');
  list.innerHTML = '';
  $('drops-empty').classList.toggle('hidden', drops.length > 0);
  $('drops-empty-sub').textContent =
    `None of your tracked items dropped in price in the last ${windowDays} days${hideSold ? ' (sold items hidden)' : ''}.`;

  for (const d of drops) list.appendChild(buildDropRow(d, d.lastDropAt > seenAt));
}

function buildDropRow({ item, wasPrice, nowPrice, lastDropAt, count }, isNew) {
  const row = document.createElement('div');
  row.className = `drop-row${item.inventory === 'sold' ? ' drop-row--sold' : ''}`;

  const img = document.createElement('img');
  img.className = 'drop-row__img';
  img.src       = item.image || '';
  img.alt       = '';
  img.onerror   = () => {
    const ph = document.createElement('div');
    ph.className   = 'drop-row__img img-placeholder';
    ph.textContent = (item.brand || item.name || '?').charAt(0).toUpperCase();
    img.replaceWith(ph);
  };
  row.appendChild(img);

  const pct    = Math.round(((wasPrice - nowPrice) / wasPrice) * 100);
  const status = item.inventory === 'sold' ? ' · Sold' : '';
  const times  = count > 1 ? ` · ${count} drops` : '';

  const body = document.createElement('div');
  body.className = 'drop-row__body';
  body.innerHTML = `
    <div class="drop-row__brand">
      ${isNew ? '<span class="drop-row__new">NEW</span>' : ''}
      <span>${escHtml(item.brand || item.siteName)}</span>
    </div>
    <div class="drop-row__name">${escHtml(item.name)}</div>
    <div class="drop-row__meta">${escHtml(item.siteName)} · ${formatTimestamp(lastDropAt)}${times}${status}</div>
  `;
  row.appendChild(body);

  const prices = document.createElement('div');
  prices.className = 'drop-row__prices';
  prices.innerHTML = `
    <span class="drop-row__now">${formatPrice(nowPrice, item.currency)}</span>
    <span class="drop-row__was">${formatPrice(wasPrice, item.currency)}</span>
    <span class="drop-row__pct">↓ ${pct}%</span>
  `;
  row.appendChild(prices);

  row.addEventListener('click', () => chrome.tabs.create({ url: item.url }));
  return row;
}

/** Tab badge: drops (within the window) the user hasn't seen yet. */
async function updateDropsBadge() {
  const [settings, items] = await Promise.all([getSettings(), getAllItems()]);
  const unseen = findRecentDrops(items, settings.dropsWindowDays)
    .filter(d => d.lastDropAt > settings.dropsSeenAt && d.item.inventory !== 'sold').length;
  const badge = $('drops-new-count');
  badge.textContent = String(unseen);
  badge.classList.toggle('hidden', unseen === 0 || !$('panel-drops').classList.contains('hidden'));
}

$('drops-window').addEventListener('change', async () => {
  await saveSettings({ dropsWindowDays: parseInt($('drops-window').value, 10) });
  await renderDrops(dropsSeenAtOnOpen);
});
$('drops-hide-sold').addEventListener('change', () => renderDrops(dropsSeenAtOnOpen));

// ─── Tracked items tab ────────────────────────────────────────────────────────

// Refresh all tracked items — the service worker runs the job and stores its
// progress; the popup only starts it and renders whatever is stored.
$('btn-refresh-all').addEventListener('click', async () => {
  $('btn-refresh-all').disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'REFRESH_ALL' });
  } catch {
    $('btn-refresh-all').disabled = false;
    $('refresh-all-status').textContent = 'Couldn\'t start refresh';
  }
});

function renderRefreshJob(job) {
  const btn      = $('btn-refresh-all');
  const status   = $('refresh-all-status');
  const progress = $('refresh-progress');
  const running  = !!job?.running;

  btn.disabled = running;
  btn.classList.toggle('spinning', running);
  $('btn-refresh-all-label').textContent = running ? 'Checking…' : 'Refresh all';
  progress.classList.toggle('hidden', !running);

  if (running) {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    $('refresh-progress-fill').style.width = `${pct}%`;
    const now = job.current?.length ? ` · now: ${job.current.join(', ')}` : '';
    $('refresh-progress-text').textContent = `${job.done} of ${job.total} checked${now}`;
    status.textContent = '';
  } else if (job?.finishedAt) {
    const ok = job.total - job.failures.length;
    status.textContent = job.total === 0
      ? 'Nothing to check'
      : `${ok}/${job.total} updated · ${formatTimestamp(job.finishedAt)}`;
  } else {
    status.textContent = '';
  }

  // Failures stay listed after the run so it's clear which items didn't update
  const failures = job?.failures || [];
  const failEl   = $('refresh-failures');
  failEl.classList.toggle('hidden', failures.length === 0);
  if (failures.length) {
    $('refresh-failures-summary').textContent =
      `${failures.length} item${failures.length !== 1 ? 's' : ''} couldn't be checked`;
    $('refresh-failures-list').innerHTML = failures
      .map(f => `<li><strong>${escHtml(f.name)}</strong> — ${escHtml(f.reason)}</li>`)
      .join('');
  }
}

async function initRefreshJob() {
  const job = await getRefreshJob();
  renderRefreshJob(job);
  // If a run was cut off (browser closed, worker shut down), messaging the
  // worker wakes it, and on wake it resumes the unfinished items.
  if (job?.running) chrome.runtime.sendMessage({ type: 'PING' }).catch(() => {});
}

// Live updates: job progress, and item prices changing while the list is open
let listRerenderTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes[REFRESH_JOB_KEY]) renderRefreshJob(changes[REFRESH_JOB_KEY].newValue);

  if (changes[ROOT_KEY]) {
    updateDropsBadge();
    if (!$('panel-drops').classList.contains('hidden')) renderDrops(dropsSeenAtOnOpen);
  }

  if (changes[ROOT_KEY] && !$('panel-tracked').classList.contains('hidden')) {
    clearTimeout(listRerenderTimer);
    listRerenderTimer = setTimeout(() => {
      // Don't yank the list out from under a drag or an in-progress rename
      if (dragItemId || document.activeElement?.classList.contains('folder-header__rename')) return;
      renderTrackedList();
    }, 400);
  }
});

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
  card.className      = `item-card${item.site ? ` item-card--${item.site}` : ''}`;
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
  // A drop since tracking started beats the store's MSRP discount
  if (delta < 0) {
    deltaHtml = `<span class="item-card__delta item-card__delta--drop">↓ ${formatPrice(Math.abs(delta), item.currency)}</span>`;
  } else if (item.originalPrice && item.originalPrice > item.currentPrice) {
    deltaHtml = `<span class="item-card__delta item-card__delta--drop">${formatDiscount(item.originalPrice, item.currentPrice)}</span>`;
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
  updateDropsBadge();
  initRefreshJob();
  await initCurrentTab();
})();
