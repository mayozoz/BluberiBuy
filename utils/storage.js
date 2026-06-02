/**
 * storage.js — BluberiBuy data layer
 *
 * All reads/writes go through this module. The API is intentionally
 * backend-agnostic: swap the internals to Firebase/Supabase in Phase 2
 * without touching any other file.
 *
 * Data shape stored in chrome.storage.local:
 * {
 *   bluberiBuy: {
 *     trackedItems: { [itemId]: TrackedItem },
 *     settings: Settings
 *   }
 * }
 *
 * TrackedItem: {
 *   id:           string   — stable hash of the canonical URL
 *   url:          string
 *   site:         string   — "ssense" | "therealreal" | …
 *   siteName:     string   — display name
 *   name:         string
 *   brand:        string
 *   image:        string   — product thumbnail URL
 *   currentPrice:  number
 *   originalPrice: number | null  — brand MSRP / crossed-out price, static reference
 *   currency:      string   — "USD" | "CAD" | …
 *   highPrice:     number   — highest observed sale price (tracked low watermark)
 *   lowPrice:      number   — lowest observed sale price (tracked low watermark)
 *   inventory:     "in_stock" | "low" | "out_of_stock" | "sold" | "unknown"
 *   priceHistory:  Array<{ price: number, inventory: string, timestamp: number }>
 *   addedAt:      number   — ms timestamp
 *   lastChecked:  number   — ms timestamp
 *   isActive:     boolean  — false = paused (won't background-check)
 *   notifications: {
 *     browser: boolean
 *     email:   boolean
 *   }
 * }
 *
 * Settings: {
 *   checkIntervalHours: number   — how often to background-check (default 6)
 *   browserNotifications: boolean
 *   emailNotifications:   boolean
 *   emailAddress:         string
 *   emailJsServiceId:     string
 *   emailJsTemplateId:    string
 *   emailJsPublicKey:     string
 * }
 *
 * Folder: {
 *   id:        string   — "ssense" | "therealreal" | uuid for user folders
 *   name:      string   — display name (user-editable)
 *   isDefault: boolean  — true = auto-created per site, cannot be deleted
 *   order:     number   — display order
 * }
 *
 * Items have folderId: string — set to site id by default, or any folder id.
 */

const ROOT_KEY = 'bluberiBuy';

const DEFAULT_SETTINGS = {
  checkIntervalHours: 6,
  browserNotifications: true,
  emailNotifications: false,
  emailAddress: '',
  emailJsServiceId: '',
  emailJsTemplateId: '',
  emailJsPublicKey: '',
};

// ─── Low-level read / write ───────────────────────────────────────────────────

// Default folders created automatically (one per supported site)
const DEFAULT_FOLDERS = [
  { id: 'ssense',       name: 'SSENSE',        isDefault: true, order: 0 },
  { id: 'therealreal',  name: 'The RealReal',   isDefault: true, order: 1 },
  { id: 'fashionphile', name: 'Fashionphile',   isDefault: true, order: 2 },
];

async function _read() {
  return new Promise((resolve) => {
    chrome.storage.local.get(ROOT_KEY, (result) => {
      const data = result[ROOT_KEY] || {};
      resolve({
        trackedItems: data.trackedItems || {},
        settings:     { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
        folders:      data.folders      || {},
      });
    });
  });
}

async function _write(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ROOT_KEY]: data }, resolve);
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings() {
  const data = await _read();
  return { ...DEFAULT_SETTINGS, ...data.settings };
}

export async function saveSettings(patch) {
  const data = await _read();
  data.settings = { ...data.settings, ...patch };
  await _write(data);
  return data.settings;
}

// ─── Tracked items ────────────────────────────────────────────────────────────

export async function getAllItems() {
  const data = await _read();
  // Exclude soft-deleted (hidden) items
  const result = {};
  for (const [id, item] of Object.entries(data.trackedItems)) {
    if (!item.isHidden) result[id] = item;
  }
  return result; // { [id]: TrackedItem }
}

export async function getItem(itemId) {
  const data = await _read();
  const item = data.trackedItems[itemId];
  // Hidden items are treated as "not tracked" to the rest of the app
  if (!item || item.isHidden) return null;
  return item;
}

export async function isTracked(itemId) {
  const item = await getItem(itemId);
  return item !== null;
}

/**
 * Add a new item to tracking.
 *
 * If the item was previously soft-deleted (isHidden: true), it is silently
 * restored with its full price history intact.  A restock sentinel is
 * inserted when the item appears to have come back in stock after a sold/
 * out-of-stock state.
 *
 * @param {object} productData — as returned by the content script
 */
export async function addItem(productData) {
  const data = await _read();
  const now = Date.now();
  const inv = productData.inventory || 'unknown';

  // ── Silent restore path ─────────────────────────────────────────────────────
  const existing = data.trackedItems[productData.id];
  if (existing && existing.isHidden) {
    existing.isHidden     = false;
    existing.isActive     = true;
    existing.currentPrice = productData.price;
    existing.image        = productData.image || existing.image;
    existing.lastChecked  = now;

    // If last known state was sold/out_of_stock and it's now available,
    // insert a restock episode marker so the sparkline shows a visual break.
    const lastEntry = existing.priceHistory[existing.priceHistory.length - 1];
    const wasGone   = lastEntry &&
      (lastEntry.inventory === 'out_of_stock' || lastEntry.inventory === 'sold');
    const nowAvail  = inv === 'in_stock' || inv === 'low';

    if (wasGone && nowAvail) {
      existing.priceHistory.push({
        type: 'restock', price: productData.price, inventory: inv, timestamp: now,
      });
    }

    // Append fresh price point
    existing.priceHistory.push({ price: productData.price, inventory: inv, timestamp: now });

    // Update watermarks
    if (productData.price > existing.highPrice) existing.highPrice = productData.price;
    if (productData.price < existing.lowPrice)  existing.lowPrice  = productData.price;

    data.trackedItems[existing.id] = existing;
    await _write(data);
    return existing;
  }

  // ── Already tracked (not hidden) — just update current price and image ───────
  if (existing && !existing.isHidden) {
    existing.currentPrice = productData.price;
    existing.image        = productData.image || existing.image;
    existing.lastChecked  = now;
    data.trackedItems[existing.id] = existing;
    await _write(data);
    return existing;
  }

  // ── Normal (first-time) add ─────────────────────────────────────────────────
  const item = {
    id:           productData.id,
    url:          productData.url,
    site:         productData.site,
    siteName:     productData.siteName,
    name:         productData.name,
    brand:        productData.brand,
    image:        productData.image,
    currentPrice:  productData.price,
    originalPrice: productData.originalPrice || null,
    currency:      productData.currency || 'USD',
    folderId:      productData.site || null,  // default to site folder
    highPrice:     productData.price,
    lowPrice:      productData.price,
    inventory:     inv,
    priceHistory: [
      { price: productData.price, inventory: inv, timestamp: now },
    ],
    addedAt:      now,
    lastChecked:  now,
    isActive:     true,
    isHidden:     false,
    notifications: { browser: true, email: false },
    targetPrice:  null,
  };

  data.trackedItems[item.id] = item;
  await _write(data);
  return item;
}

/**
 * Soft-delete: mark item as hidden rather than destroying data.
 * If the user re-tracks the same URL, history is silently restored via addItem().
 */
export async function removeItem(itemId) {
  const data = await _read();
  if (data.trackedItems[itemId]) {
    data.trackedItems[itemId].isHidden = true;
    data.trackedItems[itemId].isActive = false; // pause background checks
    await _write(data);
  }
}

export async function setItemActive(itemId, isActive) {
  const data = await _read();
  if (data.trackedItems[itemId]) {
    data.trackedItems[itemId].isActive = isActive;
    await _write(data);
  }
}

export async function updateItemNotifications(itemId, patch) {
  const data = await _read();
  if (data.trackedItems[itemId]) {
    data.trackedItems[itemId].notifications = {
      ...data.trackedItems[itemId].notifications,
      ...patch,
    };
    await _write(data);
  }
}

export async function setTargetPrice(itemId, price) {
  const data = await _read();
  if (data.trackedItems[itemId]) {
    data.trackedItems[itemId].targetPrice = price;
    await _write(data);
  }
}

// ─── Folders ──────────────────────────────────────────────────────────────────

/**
 * Return all folders (default + user-created), merged with defaults.
 * Always guarantees the site default folders exist.
 */
export async function getFolders() {
  const data = await _read();
  const merged = { ...data.folders };
  for (const f of DEFAULT_FOLDERS) {
    if (!merged[f.id]) merged[f.id] = { ...f };
  }
  return merged; // { [id]: Folder }
}

/** Create a new user folder. Returns the new folder object. */
export async function addFolder(name) {
  const data = await _read();
  const id   = `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const order = Object.keys(data.folders).length + DEFAULT_FOLDERS.length;
  const folder = { id, name, isDefault: false, order };
  data.folders[id] = folder;
  await _write(data);
  return folder;
}

/** Rename any folder (including defaults). */
export async function renameFolder(folderId, newName) {
  const data = await _read();
  // Ensure default folders exist in storage before renaming
  for (const f of DEFAULT_FOLDERS) {
    if (!data.folders[f.id]) data.folders[f.id] = { ...f };
  }
  if (data.folders[folderId]) {
    data.folders[folderId].name = newName;
    await _write(data);
  }
}

/**
 * Delete a user-created folder.
 * Items in this folder are reassigned to their site's default folder.
 */
export async function removeFolder(folderId) {
  const data = await _read();
  const folder = data.folders[folderId] || DEFAULT_FOLDERS.find(f => f.id === folderId);
  if (!folder || folder.isDefault) return; // can't delete default folders

  delete data.folders[folderId];

  // Reassign items back to their site folder
  for (const item of Object.values(data.trackedItems)) {
    if (item.folderId === folderId) {
      item.folderId = item.site || null;
    }
  }
  await _write(data);
}

/** Move an item to a different folder. */
export async function setItemFolder(itemId, folderId) {
  const data = await _read();
  if (data.trackedItems[itemId]) {
    data.trackedItems[itemId].folderId = folderId;
    await _write(data);
  }
}

/**
 * Record a new price observation for an item.
 * Returns { prevPrice, newPrice, dropped: boolean, change: number } or null if item not found.
 */
export async function recordPrice(itemId, newPrice, inventory = 'unknown') {
  const data = await _read();
  const item = data.trackedItems[itemId];
  if (!item) return null;

  const prevPrice     = item.currentPrice;
  const prevInventory = item.inventory;
  const now           = Date.now();

  // Detect restock: item was sold/out-of-stock and is now available again
  const wasGone  = prevInventory === 'out_of_stock' || prevInventory === 'sold';
  const nowAvail = inventory === 'in_stock' || inventory === 'low';
  const isRestock = wasGone && nowAvail;

  if (isRestock) {
    // Insert a restock episode marker — sparkline will draw a visual break here
    item.priceHistory.push({ type: 'restock', price: newPrice, inventory, timestamp: now });
  }

  // Always append a price entry after a restock marker; otherwise only if the
  // price changed (or history is empty) to avoid duplicate entries.
  const realEntries = item.priceHistory.filter(h => h.type !== 'restock');
  if (isRestock || newPrice !== prevPrice || realEntries.length === 0) {
    item.priceHistory.push({ price: newPrice, inventory, timestamp: now });
  }

  // Update high / low watermarks
  if (newPrice > item.highPrice) item.highPrice = newPrice;
  if (newPrice < item.lowPrice)  item.lowPrice  = newPrice;

  item.currentPrice = newPrice;
  item.inventory    = inventory;
  item.lastChecked  = now;

  data.trackedItems[itemId] = item;
  await _write(data);

  return {
    prevPrice,
    newPrice,
    dropped: newPrice < prevPrice,
    change:  newPrice - prevPrice,
  };
}
