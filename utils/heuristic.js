/**
 * heuristic.js — "Buy now or wait?" signal for BluberiBuy
 *
 * Combines two complementary approaches:
 *
 *   Option A — Linear regression
 *     Fits a trend line to the price history.  A downward slope means prices
 *     are falling; hold off.  A flat or upward slope with other buy signals
 *     means now is relatively good.
 *
 *   Option B — Rule-based heuristics
 *     - Is the current price at or near the all-time tracked low?
 *     - How many drops happened in the last 30 days? (3+ → still falling)
 *     - Has the price been flat for ≥2 weeks? (suggests a floor)
 *     - Is the MSRP discount ≥40%? (deep deals rarely deepen further)
 *     - What is the inventory status, and how urgent is it for this site?
 *
 *   Site-aware inventory weighting:
 *     - therealreal  — consignment/unique items; low stock is a STRONG buy signal
 *     - fashionphile — consignment/resale; same as therealreal
 *     - theoutnet    — luxury outlet; limited stock, items don't restock; treated as consignment
 *     - ssense       — retail/potentially restockable; low stock is a moderate signal
 *
 *   Episode awareness:
 *     Only price history from the *current episode* (after the most recent
 *     restock marker) is used for regression and recency rules, so a historic
 *     episode doesn't distort the analysis of a relisted item.
 *
 * @param {object} item — TrackedItem from storage (must include priceHistory, site, etc.)
 * @returns {{ verdict: 'buy'|'wait'|'hold', reason: string, confidence: 'low'|'medium'|'high' }}
 */
export function analyzePriceTrend(item) {
  const allHistory = item.priceHistory || [];

  // ── Extract current episode (post-restock) ────────────────────────────────
  // Walk backwards to find the most recent restock marker.
  let episodeStart = 0;
  for (let i = allHistory.length - 1; i >= 0; i--) {
    if (allHistory[i].type === 'restock') {
      episodeStart = i + 1;
      break;
    }
  }

  // Current-episode price entries (no sentinels)
  const episode = allHistory.slice(episodeStart).filter(h => h.type !== 'restock');

  // Full history price entries (for watermarks; already stored on item)
  // Use episode for regression/rules; fall back to full if episode is tiny.
  const working = episode.length >= 3 ? episode : allHistory.filter(h => h.type !== 'restock');

  if (working.length < 2) {
    return {
      verdict:    'hold',
      reason:     'Not enough price history yet.',
      confidence: 'low',
    };
  }

  // ── Option A: Linear regression on normalized timestamps ─────────────────
  const ts        = working.map(h => h.timestamp);
  const prices    = working.map(h => h.price);
  const tMin      = Math.min(...ts);
  const tMax      = Math.max(...ts);
  const tRange    = tMax - tMin || 1;
  const xs        = ts.map(t => (t - tMin) / tRange); // [0..1]
  const n         = xs.length;
  const sumX      = xs.reduce((a, b) => a + b, 0);
  const sumY      = prices.reduce((a, b) => a + b, 0);
  const sumXY     = xs.reduce((s, x, i) => s + x * prices[i], 0);
  const sumX2     = xs.reduce((s, x) => s + x * x, 0);
  const denom     = n * sumX2 - sumX * sumX;
  const slope     = denom ? (n * sumXY - sumX * sumY) / denom : 0;

  // Slope as % of current price per full time range (negative = falling)
  const currentPrice = item.currentPrice;
  const slopePct     = (slope * 100) / (currentPrice || 1);

  // ── Option B: Rule-based checks ──────────────────────────────────────────
  const now           = Date.now();
  const originalPrice = item.originalPrice;
  const inventory     = item.inventory;
  const site          = item.site;
  // Consignment/resale sites: unique items, low stock is a strong signal
  const isConsignment = site === 'therealreal' || site === 'fashionphile' || site === 'theoutnet';

  // Already gone or not yet available — short-circuit
  if (inventory === 'sold' || inventory === 'out_of_stock') {
    return {
      verdict:    'hold',
      reason:     isConsignment
        ? 'This item has sold — consignment pieces rarely return at the same price.'
        : 'Currently out of stock — check back for restocks.',
      confidence: 'high',
    };
  }
  if (inventory === 'coming_soon') {
    return {
      verdict:    'hold',
      reason:     'This item is not yet available — check back when it goes on sale.',
      confidence: 'high',
    };
  }

  // Count price drops in last 30 days (within current episode)
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const recentEpisode = working.filter(h => h.timestamp >= thirtyDaysAgo);
  let dropCount = 0;
  for (let i = 1; i < recentEpisode.length; i++) {
    if (recentEpisode[i].price < recentEpisode[i - 1].price) dropCount++;
  }

  // Days since last price change
  let daysSinceChange = Infinity;
  for (let i = working.length - 1; i >= 1; i--) {
    if (working[i].price !== working[i - 1].price) {
      daysSinceChange = (now - working[i].timestamp) / 86_400_000;
      break;
    }
  }

  // Is current price at or near the all-time tracked low (within 2%)?
  const isAtLow   = currentPrice <= item.lowPrice * 1.02;

  // Discount vs MSRP
  const discountPct = originalPrice && originalPrice > currentPrice
    ? (originalPrice - currentPrice) / originalPrice
    : 0;

  // Inventory urgency (0 = none, 1 = moderate, 2 = high)
  let inventoryUrgency = 0;
  if (inventory === 'low') {
    inventoryUrgency = isConsignment ? 2 : 1;

    // Bonus: did inventory JUST turn low this check? Even more urgent.
    const inventoryHistory = working;
    const lastTwo = inventoryHistory.slice(-2);
    if (lastTwo.length === 2 &&
        lastTwo[1].inventory === 'low' &&
        lastTwo[0].inventory === 'in_stock') {
      if (isConsignment) inventoryUrgency = 2; // already 2, leave it
      else inventoryUrgency = Math.min(inventoryUrgency + 1, 2);
    }
  }

  // ── Score signals ─────────────────────────────────────────────────────────
  // Positive → buy,  negative → wait,  near-zero → hold
  let score   = 0;
  const why   = [];

  // A: Regression
  if (slopePct < -3)  { score += 2; why.push('price is trending down'); }
  else if (slopePct > 3) { score -= 2; why.push('price is trending up'); }

  // B: Rules
  if (isAtLow) {
    score += 3;
    why.push('at its lowest tracked price');
  }
  if (dropCount >= 3) {
    score -= 2;
    why.push(`${dropCount} drops in the last 30 days`);
  }
  if (daysSinceChange >= 14 && daysSinceChange < Infinity) {
    score += 1;
    why.push('price stable for 2+ weeks');
  }
  if (discountPct >= 0.40) {
    score += 2;
    why.push(`${Math.round(discountPct * 100)}% off original`);
  }
  if (inventoryUrgency === 2) {
    score += 4;
    why.push(isConsignment ? 'low stock on a consignment item' : 'very low stock');
  } else if (inventoryUrgency === 1) {
    score += 2;
    why.push('low stock');
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  let verdict, confidence;
  if (score >= 4) {
    verdict    = 'buy';
    confidence = score >= 7 ? 'high' : 'medium';
  } else if (score <= -2) {
    verdict    = 'wait';
    confidence = score <= -4 ? 'high' : 'medium';
  } else {
    verdict    = 'hold';
    confidence = 'low';
  }

  // Summarise the top two signals into a human-readable reason
  const topTwo   = why.slice(0, 2);
  const reasonRaw = topTwo.length
    ? topTwo.join(' & ')
    : 'Mixed or insufficient signals.';
  const reason   = reasonRaw.charAt(0).toUpperCase() + reasonRaw.slice(1) + '.';

  return { verdict, reason, confidence };
}
