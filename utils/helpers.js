/**
 * helpers.js — Shared utility functions for BluberiBuy
 * No Chrome APIs used here — safe to import from any context.
 */

// ─── Item ID ──────────────────────────────────────────────────────────────────

/**
 * Generate a stable, short ID from a product URL.
 * Strips query params / fragments so ?size=M and ?size=L on the same product
 * produce the same ID. If you ever want size-specific tracking, pass the full URL.
 */
export function generateItemId(url) {
  const canonical = url.split('?')[0].split('#')[0].replace(/\/$/, '');
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = Math.imul(31, hash) + canonical.charCodeAt(i) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ─── Currency formatting ───────────────────────────────────────────────────────

export function formatPrice(price, currency = 'USD') {
  if (price == null || isNaN(price)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(price);
}

export function formatPriceChange(change, currency = 'USD') {
  if (change == null || isNaN(change)) return '';
  const sign = change < 0 ? '↓ ' : change > 0 ? '↑ ' : '';
  return sign + formatPrice(Math.abs(change), currency);
}

export function formatPercent(from, to) {
  if (!from || !to) return '';
  const pct = ((to - from) / from) * 100;
  const sign = pct < 0 ? '↓' : '↑';
  return `${sign} ${Math.abs(pct).toFixed(1)}%`;
}

/**
 * Format a discount off the original/MSRP price.
 * Returns e.g. "36% off" or "" if data is missing.
 */
export function formatDiscount(originalPrice, currentPrice) {
  if (!originalPrice || !currentPrice || originalPrice <= currentPrice) return '';
  const pct = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
  return `${pct}% off`;
}

// ─── Date formatting ───────────────────────────────────────────────────────────

export function formatTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1)    return 'just now';
  if (diffMins < 60)   return `${diffMins}m ago`;
  if (diffHours < 24)  return `${diffHours}h ago`;
  if (diffDays === 1)  return 'yesterday';
  if (diffDays < 30)   return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Inventory helpers ─────────────────────────────────────────────────────────

const INVENTORY_LABEL = {
  in_stock:    { text: 'In Stock',     color: '#22c55e' },
  low:         { text: 'Low Stock',    color: '#f59e0b' },
  out_of_stock:{ text: 'Out of Stock', color: '#ef4444' },
  sold:        { text: 'Sold',         color: '#6b7280' },
  unknown:     { text: '',             color: 'transparent' },
};

export function getInventoryLabel(inventory) {
  return INVENTORY_LABEL[inventory] || INVENTORY_LABEL.unknown;
}

// ─── Sparkline drawing ─────────────────────────────────────────────────────────

/**
 * Draw a price history sparkline, inspired by Google Flights price charts.
 *
 * Features:
 *   - Price line with gradient fill (violet by default)
 *   - Dashed horizontal MSRP reference line + "MSRP" label (when opts.originalPrice is set)
 *   - Green dot + price label at the all-time low
 *   - Violet dot at the current (rightmost) price
 *   - Fill color shifts greener the deeper the discount below MSRP
 *   - Vertical dotted break lines + ↺ icon at restock episode boundaries
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{price:number, timestamp:number}|{type:'restock',...}>} history
 * @param {object} opts
 *   opts.originalPrice  {number|null} — MSRP reference line
 *   opts.lineColor      {string}      — CSS color for the price line
 *   opts.textColor      {string}      — CSS color for labels
 */
export function drawSparkline(canvas, history, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Separate real price entries from restock sentinel markers
  const priceEntries   = (history || []).filter(h => h.type !== 'restock');
  const restockMarkers = (history || []).filter(h => h.type === 'restock');

  if (priceEntries.length < 2) {
    ctx.fillStyle  = opts.textColor || '#6b7280';
    ctx.font       = '11px -apple-system, sans-serif';
    ctx.textAlign  = 'center';
    ctx.fillText('Not enough data yet', W / 2, H / 2 + 4);
    return;
  }

  const prices        = priceEntries.map(h => h.price);
  const originalPrice = opts.originalPrice || null;

  // Y scale: include MSRP at the top so the gap is always visible
  const yMin  = Math.min(...prices) * 0.96;
  const yMax  = Math.max(Math.max(...prices), originalPrice || 0) * 1.04;
  const range = yMax - yMin || 1;

  // Reserve right-side padding for the "MSRP" label
  const padL = 6, padR = originalPrice ? 38 : 6, padT = 10, padB = 6;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const toX = (i) => padL + (i / Math.max(prices.length - 1, 1)) * plotW;
  const toY = (p) => padT + plotH - ((p - yMin) / range) * plotH;

  // ── Decide line/fill color based on discount depth ──────────────────────────
  // >30% off MSRP → green  |  10-30% → violet  |  <10% or no MSRP → violet
  let lineColor = opts.lineColor || '#a78bfa';
  if (originalPrice && prices[prices.length - 1] < originalPrice) {
    const discountPct = (originalPrice - prices[prices.length - 1]) / originalPrice;
    if (discountPct >= 0.30) lineColor = '#22c55e';
  }

  // ── Build episode segments (split at restock boundaries) ────────────────────
  // Each segment is a contiguous slice of priceEntries in one episode.
  const segments = [];
  if (restockMarkers.length === 0) {
    segments.push({ indices: priceEntries.map((_, i) => i) });
  } else {
    let segStart = 0;
    for (const restock of restockMarkers) {
      const nextIdx = priceEntries.findIndex(e => e.timestamp >= restock.timestamp);
      if (nextIdx > segStart) {
        segments.push({ indices: priceEntries.slice(segStart, nextIdx).map((_, i) => segStart + i) });
      }
      segStart = nextIdx >= 0 ? nextIdx : segStart;
    }
    // Last segment (current episode)
    if (segStart < priceEntries.length) {
      segments.push({ indices: priceEntries.slice(segStart).map((_, i) => segStart + i) });
    }
  }

  // ── Draw gradient fill + price line for each episode segment ─────────────────
  for (const seg of segments) {
    const { indices } = seg;
    if (indices.length < 1) continue;

    // Gradient fill
    const gradient = ctx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, lineColor + '33');
    gradient.addColorStop(1, lineColor + '00');

    ctx.beginPath();
    ctx.moveTo(toX(indices[0]), toY(prices[indices[0]]));
    for (let j = 1; j < indices.length; j++) {
      ctx.lineTo(toX(indices[j]), toY(prices[indices[j]]));
    }
    const lastIdx = indices[indices.length - 1];
    ctx.lineTo(toX(lastIdx), H);
    ctx.lineTo(toX(indices[0]), H);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Price line
    if (indices.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(toX(indices[0]), toY(prices[indices[0]]));
    for (let j = 1; j < indices.length; j++) {
      ctx.lineTo(toX(indices[j]), toY(prices[indices[j]]));
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.stroke();
  }

  // ── Restock break lines (dotted vertical + ↺ icon) ───────────────────────────
  for (const restock of restockMarkers) {
    const nextIdx = priceEntries.findIndex(e => e.timestamp >= restock.timestamp);
    if (nextIdx <= 0) continue;

    // Place break line halfway between the last old-episode point and first new-episode point
    const x = padL + ((nextIdx - 0.5) / Math.max(prices.length - 1, 1)) * plotW;

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([2, 3]);
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.strokeStyle = 'rgba(107,114,128,0.55)';
    ctx.lineWidth   = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // ↺ icon near the top of the break line
    ctx.fillStyle = '#9ca3af';
    ctx.font      = '9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('↺', x, padT + 8);
    ctx.restore();
  }

  // ── MSRP dashed reference line ───────────────────────────────────────────────
  if (originalPrice) {
    const msrpY = toY(originalPrice);

    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.moveTo(padL, msrpY);
    ctx.lineTo(padL + plotW, msrpY);
    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth   = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // "MSRP" label at the right
    ctx.fillStyle  = '#6b7280';
    ctx.font       = 'bold 9px -apple-system, sans-serif';
    ctx.textAlign  = 'left';
    ctx.fillText('MSRP', padL + plotW + 4, msrpY + 3);
  }

  // ── All-time low marker (green dot + price) ───────────────────────────────────
  const lowPrice = Math.min(...prices);
  const lowIdx   = prices.lastIndexOf(lowPrice); // prefer the most recent if tied
  const lowX     = toX(lowIdx);
  const lowY     = toY(lowPrice);

  ctx.beginPath();
  ctx.arc(lowX, lowY, 4, 0, Math.PI * 2);
  ctx.fillStyle   = '#22c55e';
  ctx.fill();
  ctx.strokeStyle = '#0f0f0f';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Price label above the low dot (flip to below if too close to top)
  const labelY = lowY < padT + 14 ? lowY + 14 : lowY - 6;
  ctx.fillStyle  = '#22c55e';
  ctx.font       = 'bold 9px -apple-system, sans-serif';
  ctx.textAlign  = lowIdx < prices.length * 0.8 ? 'center' : 'right';
  ctx.fillText(formatPrice(lowPrice, opts.currency || 'USD'), lowX, labelY);

  // ── Current price dot (right end of line) ────────────────────────────────────
  const lastX = toX(prices.length - 1);
  const lastY = toY(prices[prices.length - 1]);

  // Only draw if it's not the same point as the low marker
  if (lowIdx !== prices.length - 1) {
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle   = lineColor;
    ctx.fill();
    ctx.strokeStyle = '#0f0f0f';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }
}
