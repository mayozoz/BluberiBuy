/**
 * service-worker.js — BluberiBuy background service worker (MV3)
 *
 * Responsibilities:
 *   1. Set up a recurring alarm to background-check all tracked item prices
 *   2. Fetch product pages and parse prices from JSON-LD (no active tab needed)
 *   3. Fire browser notifications on price drops or inventory changes
 *   4. Passively receive live price updates pushed by content.js on page visits
 *
 * Why fetch from the service worker instead of opening a tab?
 *   Chrome MV3 service workers can fetch URLs directly with the extension's
 *   host_permissions. This avoids interrupting the user with a visible tab.
 *   Note: sites with heavy anti-bot protection may block this; in that case
 *   the passive update from content.js (when the user visits the page) is the
 *   reliable fallback.
 *
 * Email notifications:
 *   Implemented via EmailJS using the shared account in utils/email-config.js;
 *   users only supply their address. Called directly from the service worker.
 */

import {
  getAllItems,
  getItem,
  getSettings,
  recordPrice,
  saveSettings,
  getRefreshJob,
  saveRefreshJob,
  migrateItemIds,
  cleanCorruptedHistory,
  setItemUrl,
  EMAIL_STATUS_KEY,
} from '../utils/storage.js';

import { EMAILJS, isEmailConfigured } from '../utils/email-config.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const ALARM_NAME    = 'bluberiBuy_check';
const ICON_PATH     = '/icons/icon48.png';

// Minimum drop percentage to trigger a notification.
// Drops smaller than this are recorded in history but silently ignored.
const MIN_DROP_PCT  = 0.05; // 5%

// ─── Installation / startup ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  console.log('[BluberiBuy] onInstalled:', reason);
  const migrated = await migrateItemIds();
  if (migrated) console.log(`[BluberiBuy] Re-keyed ${migrated} items to www-agnostic ids`);

  const { recheck, fixed, hidden } = await cleanCorruptedHistory();
  if (fixed || hidden) {
    console.log(`[BluberiBuy] Repaired history on ${fixed} items, hid ${hidden} non-product items`);
  }
  // Items whose whole history was bad: fetch their real price now
  if (recheck.length) {
    const settings = await getSettings();
    for (const id of recheck) {
      const item = await getItem(id);
      if (!item) continue;
      try {
        await checkItemPrice(item, settings);
      } catch (err) {
        console.warn(`[BluberiBuy] Re-check of "${item.name}" failed:`, err.message);
      }
    }
  }
  const settings = await getSettings();
  scheduleAlarm(settings.checkIntervalHours);
});

// Re-schedule alarm on browser startup (service workers can be killed between sessions)
chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  scheduleAlarm(settings.checkIntervalHours);
});

// ─── Alarm ────────────────────────────────────────────────────────────────────

function scheduleAlarm(intervalHours) {
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes:  intervalHours * 60,   // first run after one interval
      periodInMinutes: intervalHours * 60,   // repeat
    });
    console.log(`[BluberiBuy] Alarm scheduled every ${intervalHours}h`);
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  console.log('[BluberiBuy] Running scheduled price check');
  await startRefreshAll();
});

// ─── Price checking ───────────────────────────────────────────────────────────

// Items checked in parallel during a full refresh — kept small to avoid tripping bot detection
const CHECK_CONCURRENCY = 3;

// Give up on a product page that hasn't loaded after this long
const FETCH_TIMEOUT_MS = 15_000;

// The in-flight refresh-all run in this worker, if any
let refreshJobPromise = null;

/**
 * Start checking every active item unless a run is already going.
 * Progress is written to storage (see RefreshJob in storage.js) after every
 * item, so the popup can show it and can be closed without stopping the run.
 * Returns the run's promise.
 */
function startRefreshAll(resumeJob = null) {
  if (!refreshJobPromise) {
    refreshJobPromise = runRefreshJob(resumeJob)
      .catch(err => console.warn('[BluberiBuy] Refresh-all failed:', err.message))
      .finally(() => { refreshJobPromise = null; });
  }
  return refreshJobPromise;
}

async function runRefreshJob(resumeJob) {
  let job = resumeJob;
  if (!job) {
    const items = await getAllItems();
    const ids   = Object.values(items).filter(item => item.isActive).map(item => item.id);
    job = {
      running: true, total: ids.length, done: 0, pending: ids, current: [],
      failures: [], startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null,
    };
  } else {
    // Items that were mid-check when the previous worker died start over
    job = { ...job, current: [], done: job.total - job.pending.length };
  }
  await saveRefreshJob(job);

  console.log(`[BluberiBuy] Checking ${job.pending.length} of ${job.total} active items`);

  // Chrome stops an idle service worker after ~30s. Calling an extension API
  // resets that timer, so ping one while the run is in progress.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);

  const settings = await getSettings();
  const queue    = [...job.pending];

  const save = () => { job.updatedAt = Date.now(); return saveRefreshJob(job); };

  async function worker() {
    while (queue.length) {
      const id   = queue.shift();
      const item = await getItem(id);
      const name = item ? (item.brand ? `${item.brand} ${item.name}` : item.name) : id;

      if (item) {
        job.current.push(name);
        await save();
        try {
          await checkItemPrice(item, settings);
        } catch (err) {
          job.failures.push({ id, name, reason: err.message });
          console.warn(`[BluberiBuy] Failed to check "${item.name}":`, err.message);
        }
        job.current = job.current.filter(n => n !== name);
      }
      // A missing item was removed while the run was going — nothing to check

      job.pending = job.pending.filter(p => p !== id);
      job.done++;
      await save();
    }
  }

  try {
    await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
  } finally {
    clearInterval(keepAlive);
    job.running    = false;
    job.current    = [];
    job.finishedAt = Date.now();
    await save();
    // Re-key items whose URL changed during the run (see setItemUrl above)
    await migrateItemIds();
  }

  console.log(`[BluberiBuy] Refresh-all done: ${job.total - job.failures.length}/${job.total} ok`);
}

// A fresh worker start while a run is marked as going means the previous
// worker was shut down mid-run — pick up the items it didn't finish.
async function resumeInterruptedRefresh() {
  const job = await getRefreshJob();
  if (job?.running && !refreshJobPromise) {
    console.log(`[BluberiBuy] Resuming refresh-all (${job.pending.length} left)`);
    startRefreshAll(job);
  }
}
resumeInterruptedRefresh();

/**
 * Fetch the product page and extract the current price via JSON-LD.
 * Throws an Error with a short, user-facing reason if the page can't be
 * loaded or no price can be found.
 */
async function checkItemPrice(item, settings) {
  let html, finalUrl;
  try {
    const response = await fetch(item.url, {
      method: 'GET',
      headers: {
        // Mimic a regular browser request to reduce bot-detection triggers
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // Bypass the HTTP cache without a Cache-Control header — that header isn't
      // CORS-safelisted and would trigger a preflight the stores reject.
      cache:       'no-store',
      // Send the user's cookies for the store: bot protection (e.g. PerimeterX
      // on The RealReal) lets requests through that carry a session that has
      // already passed its checks in a normal visit.
      credentials: 'include',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(response.status === 403 || response.status === 429
        ? `Site's bot protection blocked the check (HTTP ${response.status}) — visit the page to update it`
        : `Page returned HTTP ${response.status}`);
    }

    html     = await response.text();
    finalUrl = response.redirected ? response.url : null;
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('Page took too long to load');
    if (err.name === 'TypeError')    throw new Error('Couldn\'t reach the site');
    throw err;
  }

  const { price, inventory } = parseFromHtml(html, item.site);

  if (!price) throw new Error('Couldn\'t find a price on the page');

  // The store moved this product to a new address — remember it so the saved
  // link and the item's id match the page the user will actually land on.
  // Only trusted when the page parsed as a product, so a redirect to a home
  // or search page never overwrites the link.
  if (finalUrl && finalUrl !== item.url) await setItemUrl(item.id, finalUrl.split('?')[0]);

  const result = await handlePriceObservation(item, price, inventory, settings);
  if (!result) throw new Error('Item is no longer tracked');
}

/**
 * Record a newly observed price / stock level for a tracked item and send any
 * alerts it triggers. Every source of prices (background checks, page visits,
 * the popup) must go through here — recording a price anywhere else would
 * swallow the drop, since the next check compares against the new price.
 */
async function handlePriceObservation(item, price, inventory, settings) {
  const result = await recordPrice(item.id, price, inventory);
  if (!result) return null;

  const { dropped, prevPrice, newPrice } = result;

  // ── Notify: price drop (only if drop meets the minimum threshold) ──
  if (dropped) {
    const dropPct = (prevPrice - newPrice) / prevPrice;
    // Small epsilon so an exact 5% drop isn't lost to floating-point rounding
    if (dropPct >= MIN_DROP_PCT - 1e-9) {
      console.log(`[BluberiBuy] Price drop on "${item.name}": ${prevPrice} → ${newPrice} (${Math.round(dropPct * 100)}%)`);
      await notifyPriceDrop(item, prevPrice, newPrice, settings);
    } else {
      console.log(`[BluberiBuy] Drop on "${item.name}" too small to notify (${(dropPct * 100).toFixed(1)}% < ${MIN_DROP_PCT * 100}%)`);
    }
  }

  // ── Notify: inventory change (low / sold out) ──
  // (no alert when the previous status was unknown — nothing actually changed
  // that we know of, e.g. first reading after a history repair)
  const prevInventory = item.inventory;
  if (inventory !== prevInventory && prevInventory !== 'unknown' &&
      (inventory === 'low' || inventory === 'out_of_stock' || inventory === 'sold')) {
    await notifyInventoryChange(item, inventory, settings);
  }

  // ── Notify: target price reached ──
  const freshItem = await getItem(item.id);
  if (freshItem?.targetPrice != null &&
      newPrice <= freshItem.targetPrice &&
      prevPrice > freshItem.targetPrice) {
    await notifyTargetPrice(freshItem, newPrice, settings);
  }

  return result;
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────

// Resale sites list one-of-a-kind items, so "no longer offered" means sold
const RESALE_SITES = ['fashionphile', 'therealreal', 'vestiairecollective'];

/**
 * Extract price + inventory from raw HTML by scanning JSON-LD blocks.
 * We don't spin up a full DOM parser in the service worker — a regex scan is
 * sufficient and avoids loading a heavy library.
 */
function parseFromHtml(html, site) {
  if (site === 'vestiairecollective') {
    const fromNext = parseVestiaireNextData(html);
    if (fromNext) return fromNext;
  }

  const blockRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let sawProduct = false;

  while ((match = blockRe.exec(html)) !== null) {
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { continue; }

    const candidates = (Array.isArray(parsed) ? parsed : [parsed])
      .flatMap(node => node?.['@graph'] ?? [node]);

    for (const node of candidates) {
      const type = node?.['@type'];
      if (type !== 'Product' && !(Array.isArray(type) && type.includes('Product'))) continue;
      sawProduct = true;

      const offers = flattenOffers(node.offers);
      if (offers.length === 0) continue;

      // Stock across all offers (one per size on multi-size listings)
      const avails = offers.map(o => String(o.availability || '').toLowerCase());
      let inventory = 'unknown';
      if      (avails.some(a => a.includes('instock')))       inventory = 'in_stock';
      else if (avails.some(a => a.includes('limitedavail')))  inventory = 'low';
      else if (avails.some(a => a.includes('discontinued')))  inventory = 'sold';
      else if (avails.some(a => a.includes('outofstock') || a.includes('soldout'))) inventory = 'out_of_stock';

      // Prefer the price of an offer that can actually be bought
      const buyable = offers.find(o => /instock|limitedavail/i.test(o.availability || ''));
      const price   = toPrice((buyable || offers[0]).price ?? (buyable || offers[0]).lowPrice);
      if (price == null) continue;

      return { price, inventory };
    }
  }

  // Some sites (e.g. Fashionphile) drop the offer from a listing once it sells
  // but keep the last price in the Open Graph tags.
  const metaPrice = toPrice(
    html.match(/<meta[^>]+(?:og|product):price:amount["'][^>]*content=["']([^"']+)["']/i)?.[1]
  );
  if (metaPrice != null) {
    const inventory = sawProduct
      ? (RESALE_SITES.includes(site) ? 'sold' : 'out_of_stock')
      : 'unknown';
    return { price: metaPrice, inventory };
  }

  return { price: null, inventory: 'unknown' };
}

// Vestiaire Collective (Next.js): product at props.pageProps.product in the
// __NEXT_DATA__ script, price in cents. Mirrors extractVestiaire() in content.js.
function parseVestiaireNextData(html) {
  const raw = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!raw) return null;

  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  const product = data?.props?.pageProps?.product || findNextProduct(data);
  const cents   = Number(product?.price?.cents);
  if (!cents) return null;

  let inventory = 'in_stock';
  if (product.sold)                                                 inventory = 'sold';
  else if (product.reserved)                                        inventory = 'low';
  else if (product.inStock === false || product.available === false) inventory = 'out_of_stock';

  return { price: cents / 100, inventory };
}

function findNextProduct(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (node.name && node.price?.cents != null) return node;
  for (const value of Object.values(node)) {
    const found = findNextProduct(value, depth + 1);
    if (found) return found;
  }
  return null;
}

// offers may be a single Offer, an array, or an AggregateOffer wrapping more offers
function flattenOffers(offers) {
  if (!offers) return [];
  return (Array.isArray(offers) ? offers : [offers]).flatMap(o =>
    o?.offers ? [o, ...flattenOffers(o.offers)] : [o]
  ).filter(Boolean);
}

// "4,045.00" → 4045; returns null for missing / unparseable values
function toPrice(value) {
  if (value == null) return null;
  const n = parseFloat(String(value).replace(/,/g, ''));
  return isNaN(n) || n <= 0 ? null : n;
}

// ─── Notifications ────────────────────────────────────────────────────────────

// "Moncler Down Jacket" — brand alone is ambiguous when several items share it.
// Some sites (Fashionphile) already start the name with the brand; don't repeat it.
function itemLabel(item) {
  const name  = item.name || '';
  const brand = item.brand || '';
  if (!brand || name.toLowerCase().startsWith(brand.toLowerCase())) return name || brand || item.siteName;
  return `${brand} ${name}`;
}

function fmtPrice(price, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    // $675 for whole amounts, $79.50 (never $79.5) otherwise
    minimumFractionDigits: Number.isInteger(price) ? 0 : 2, maximumFractionDigits: 2,
  }).format(price);
}

function canEmail(settings) {
  return !!settings.emailAddress && isEmailConfigured();
}

// kind: 'drop' (price drops + out of stock / sold) or 'target' (target price reached).
// Older items stored a single `email` flag, which seeds both.
function wantsEmail(item, kind) {
  const n = item.notifications || {};
  return (kind === 'target' ? n.emailTarget : n.emailDrop) ?? n.email ?? false;
}

/**
 * Send one email through EmailJS. Returns { ok, error }. The outcome is also
 * stored (EMAIL_STATUS_KEY) so Settings can show when sending is broken —
 * EmailJS reports problems like a bad service ID only in the response body.
 */
async function sendEmailNotification(settings, { subject, itemName, message, itemUrl }) {
  let outcome;
  try {
    const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id:  EMAILJS.serviceId,
        template_id: EMAILJS.templateId,
        user_id:     EMAILJS.publicKey,
        template_params: {
          to_email:  settings.emailAddress,
          subject,
          item_name: itemName,
          message,
          item_url:  itemUrl,
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    outcome = response.ok
      ? { ok: true }
      : { ok: false, error: `EmailJS: ${(await response.text()).trim() || `HTTP ${response.status}`}` };
  } catch (err) {
    outcome = { ok: false, error: `Couldn't reach EmailJS (${err.message})` };
  }

  if (!outcome.ok) console.warn('[BluberiBuy] Email send failed:', outcome.error);
  await chrome.storage.local.set({ [EMAIL_STATUS_KEY]: { ...outcome, at: Date.now() } });
  return outcome;
}

async function notifyPriceDrop(item, prevPrice, newPrice, settings) {
  const drop = prevPrice - newPrice;
  const pct  = Math.round((drop / prevPrice) * 100);
  const msg  = `${item.siteName}: ${fmtPrice(prevPrice, item.currency)} → ${fmtPrice(newPrice, item.currency)} (${pct}% off, save ${fmtPrice(drop, item.currency)})`;

  if (settings.browserNotifications) {
    chrome.notifications.create(`drop_${item.id}_${Date.now()}`, {
      type:    'basic',
      iconUrl: ICON_PATH,
      title:   `Price drop on ${itemLabel(item)}`,
      message: msg,
      buttons: [{ title: 'View item' }],
    });
  }

  if (canEmail(settings) && wantsEmail(item, 'drop')) {
    await sendEmailNotification(settings, {
      subject:  `Price drop: ${itemLabel(item)}`,
      itemName: itemLabel(item),
      message:  msg,
      itemUrl:  item.url,
    });
  }
}

async function notifyInventoryChange(item, inventory, settings) {
  const labels = {
    low:          `Low inventory — only a few left`,
    out_of_stock: `Now out of stock`,
    sold:         `This item has sold`,
  };

  const msg = labels[inventory];
  if (!msg) return;

  if (settings.browserNotifications) {
    chrome.notifications.create(`inv_${item.id}_${Date.now()}`, {
      type:    'basic',
      iconUrl: ICON_PATH,
      title:   `Inventory alert: ${itemLabel(item)}`,
      message: `${item.siteName}: ${msg}`,
      buttons: [{ title: 'View item' }],
    });
  }

  // Low stock is browser-only; email is reserved for out of stock / sold
  if (inventory !== 'low' && canEmail(settings) && wantsEmail(item, 'drop')) {
    await sendEmailNotification(settings, {
      subject:  `Inventory alert: ${itemLabel(item)}`,
      itemName: itemLabel(item),
      message:  `${item.siteName}: ${msg}`,
      itemUrl:  item.url,
    });
  }
}

async function notifyTargetPrice(item, newPrice, settings) {
  const msg = `${item.siteName}: now ${fmtPrice(newPrice, item.currency)} — your target was ${fmtPrice(item.targetPrice, item.currency)}`;

  if (settings.browserNotifications) {
    chrome.notifications.create(`target_${item.id}_${Date.now()}`, {
      type:    'basic',
      iconUrl: ICON_PATH,
      title:   `Target price reached: ${itemLabel(item)}`,
      message: msg,
      buttons: [{ title: 'View item' }],
    });
  }

  if (canEmail(settings) && wantsEmail(item, 'target')) {
    await sendEmailNotification(settings, {
      subject:  `Target price reached: ${itemLabel(item)}`,
      itemName: itemLabel(item),
      message:  msg,
      itemUrl:  item.url,
    });
  }
}

// Open the item's page when the user clicks "View item" in a notification
chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (btnIdx !== 0) return;

  // Extract itemId from notification ID format: "drop_<itemId>_<ts>"
  const parts  = notifId.split('_');
  const itemId = parts[1];
  if (!itemId) return;

  const item = await getItem(itemId);
  if (item?.url) {
    chrome.tabs.create({ url: item.url });
  }

  chrome.notifications.clear(notifId);
});

// ─── Messages from popup / content scripts ────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    // Popup updated check interval in settings — reschedule the alarm
    case 'UPDATE_CHECK_INTERVAL':
      scheduleAlarm(message.intervalHours);
      sendResponse({ success: true });
      break;

    // Popup requested an immediate price check for a single item
    case 'REFRESH_ITEM': {
      const { itemId } = message;
      if (!itemId) { sendResponse({ success: false, error: 'no itemId' }); break; }

      getItem(itemId).then(async (item) => {
        if (!item) { sendResponse({ success: false, error: 'not tracked' }); return; }
        const settings = await getSettings();
        try {
          await checkItemPrice(item, settings);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      });
      break;
    }

    // Popup requested an immediate price check for every tracked item.
    // Replies right away; progress is reported through the stored RefreshJob.
    case 'REFRESH_ALL':
      sendResponse({ success: true, alreadyRunning: !!refreshJobPromise });
      startRefreshAll();
      break;

    // Popup opened while a run is marked as going — waking the worker is enough
    // to trigger resumeInterruptedRefresh(); this just confirms it's alive.
    case 'PING':
      sendResponse({ success: true, running: !!refreshJobPromise });
      break;

    // Content script pushed a live price update (user just visited the page)
    // A page visit (content script) or the popup saw the item's live price.
    // Replies once the price is recorded and any alerts are sent.
    case 'PAGE_PRICE_UPDATE': {
      const { data } = message;
      if (!data?.id || !data?.price) { sendResponse({ success: false }); break; }

      getItem(data.id).then(async (item) => {
        if (!item) { sendResponse({ success: false, error: 'not tracked' }); return; }
        const settings = await getSettings();
        await handlePriceObservation(item, data.price, data.inventory || item.inventory, settings);
        sendResponse({ success: true });
      }).catch(err => sendResponse({ success: false, error: err.message }));
      break;
    }

    // Settings → "Send test email"
    case 'SEND_TEST_EMAIL':
      getSettings().then(async (settings) => {
        if (!settings.emailAddress) { sendResponse({ ok: false, error: 'No email address saved.' }); return; }
        if (!isEmailConfigured())   { sendResponse({ ok: false, error: 'Email sending isn\'t set up in this build.' }); return; }
        sendResponse(await sendEmailNotification(settings, {
          subject:  'BluberiBuy test email',
          itemName: 'Test alert',
          message:  'Email alerts are working. You\'ll get emails like this when a tracked item drops in price.',
          itemUrl:  'https://mayozoz.github.io/BluberiBuy/',
        }));
      }).catch(err => sendResponse({ ok: false, error: err.message }));
      break;

    // Unknown message: say so right away instead of leaving the sender waiting
    // for a reply that will never come.
    default:
      return false;
  }

  // Keep the channel open — handlers above may reply asynchronously
  return true;
});
