/**
 * The Algorithm tab's alerts.
 *
 * Deliberately unlike the hand-built rules in `alerts`. There is exactly one
 * thing it will email about — a holding reading **very strong buy** — and that is
 * not configurable, because it is a claim about the signal rather than a taste.
 * Two timings are the user's, and they are both about volume rather than meaning:
 * how many consecutive readings count as real, and how long the same holding then
 * stays quiet.
 *
 * WHY THERE IS NO SELL ALERT. The measurement is in README and the short version
 * is that a sell reading is not an event. Across the current holdings the sell
 * side is on 39% of all days, and 76% for the strongest performer — whose sell
 * days were then followed by +13.8% over the next 60. An alert that is true most
 * of the time and loudest where it is most wrong is a way to train someone to
 * ignore their own inbox, and it would take the hand-built alerts' credibility
 * with it. Selling is covered by the target rule, which fires off the user's own
 * cost basis and therefore genuinely happens once.
 *
 * The weekly standings exist so the sell side is still *visible* without being
 * pushed: a summary cannot spam, because nothing triggers it.
 */

const signals = require('./algorithm');

/** Only the top tier is worth an email. Everything else is the tab's job. */
const ALERT_TIER = 'VeryStrong';
const ALERT_DIRECTION = 'Buy';

/** A signal computed off a stale price file is not a signal. */
const MAX_PRICE_AGE_DAYS = 5;

function heldTickers(db, userId) {
  return db.prepare('SELECT DISTINCT ticker FROM transactions WHERE user_id = ? ORDER BY ticker').all(userId);
}

function priceSeries(db, ticker) {
  return db.prepare(
    'SELECT price_date AS date, price_native AS close, price_eur AS closeEur, currency FROM prices WHERE ticker = ? AND price_native IS NOT NULL ORDER BY price_date ASC'
  ).all(ticker);
}

/**
 * Has this holding read very-strong-buy for `holdDays` consecutive readings,
 * ending today?
 *
 * Consecutive means consecutive *scored trading days* — a weekend does not break
 * the run, a Neutral Tuesday does. Returns the reading that triggered it, or null.
 */
function sustainedSignal(scored, holdDays) {
  const usable = scored.filter(d => d.complete);
  if (usable.length < holdDays) return null;
  const window = usable.slice(-holdDays);
  const allOn = window.every(d =>
    d.early.direction === ALERT_DIRECTION && d.early.tier === ALERT_TIER);
  return allOn ? usable[usable.length - 1] : null;
}

/**
 * Days since this holding last had something emailed about it.
 * Null when it never has, which always clears the cooldown.
 */
function daysSinceLastAlert(db, userId, ticker, now) {
  const row = db.prepare(
    'SELECT fired_at FROM algo_alert_log WHERE user_id = ? AND ticker = ? ORDER BY fired_at DESC LIMIT 1'
  ).get(userId, ticker);
  if (!row) return null;
  // Rows written here are ISO; anything SQLite wrote with CURRENT_TIMESTAMP is
  // 'YYYY-MM-DD HH:MM:SS' in UTC and needs saying so explicitly.
  const stamp = row.fired_at.includes('T') ? row.fired_at : row.fired_at.replace(' ', 'T') + 'Z';
  return (now.getTime() - Date.parse(stamp)) / 864e5;
}

/**
 * Where every holding stands today — the weekly summary's content.
 *
 * Everything that is not silent, strongest first, both directions. This is the
 * only place the sell side appears, and it appears as a list rather than a
 * demand for attention.
 */
function standingsFor(db, userId, now = new Date()) {
  const out = [];
  for (const { ticker } of heldTickers(db, userId)) {
    const series = priceSeries(db, ticker);
    if (series.length < 60) continue;
    const scored = signals.scoreSeries(series).filter(d => d.complete);
    if (!scored.length) continue;
    const today = scored[scored.length - 1];
    if (today.early.direction === 'None') continue;
    const latest = series[series.length - 1];
    out.push({
      ticker,
      direction: today.early.direction,
      tier: today.early.tier,
      confidence: today.early.confidencePct,
      price: latest.close,
      currency: latest.currency || 'USD',
      regimes: today.regimes
    });
  }
  const rank = { VeryStrong: 4, Strong: 3, Signal: 2, Watch: 1 };
  // Buys first — they are the side that is actually actionable — then by strength.
  return out.sort((a, b) =>
    (a.direction === b.direction ? 0 : a.direction === 'Buy' ? -1 : 1) ||
    (rank[b.tier] - rank[a.tier]));
}

/**
 * Evaluate every user's holdings and return the items to email, keyed by
 * recipient, in the same shape the alert digest already renders.
 *
 * Writing to `algo_alert_log` happens here rather than after a successful send,
 * for the same reason `alerts.last_triggered_at` does: a mail failure that left
 * the cooldown unset would retry the same alert every day until it succeeded,
 * which is the one failure mode worse than not sending it.
 */
function evaluateAlgorithmSignals(db, now = new Date(), log = () => {}, identityDb = null) {
  const byRecipient = new Map();
  // Settings live on the financial side keyed by the opaque id; the address that
  // the email actually goes to lives in the identity database and is fetched
  // separately. Nothing here can turn a key back into a person without it.
  const idb = identityDb || (db && db.identity) || null;
  const emailOf = new Map();
  if (idb) {
    try {
      for (const r of idb.prepare('SELECT user_key, email FROM users').all()) emailOf.set(r.user_key, r.email);
    } catch { /* no identities reachable */ }
  }
  const users = db.prepare(
    'SELECT user_id AS id, algo_hold_days AS holdDays, algo_cooldown_days AS cooldownDays FROM user_settings WHERE algo_alerts_enabled = 1'
  ).all().map(u => ({ ...u, email: emailOf.get(u.id) || null }));

  const record = db.prepare(
    'INSERT INTO algo_alert_log (user_id, ticker, fired_at, signal_date, tier, direction, confidence) VALUES (?,?,?,?,?,?,?)'
  );
  const firedAt = now.toISOString();

  for (const user of users) {
    if (!user.email) continue;
    for (const { ticker } of heldTickers(db, user.id)) {
      try {
        const series = priceSeries(db, ticker);
        if (series.length < 60) continue;

        const newest = series[series.length - 1];
        if ((now.getTime() - Date.parse(newest.date)) / 864e5 > MAX_PRICE_AGE_DAYS) {
          log(`  ⏭  ${ticker}: prices stale (${newest.date}), not scoring`);
          continue;
        }

        const hit = sustainedSignal(signals.scoreSeries(series), user.holdDays);
        if (!hit) continue;

        const since = daysSinceLastAlert(db, user.id, ticker, now);
        if (since !== null && since < user.cooldownDays) {
          log(`  🔇 ${ticker}: very strong buy, but quiet for another ${Math.ceil(user.cooldownDays - since)} day(s)`);
          continue;
        }

        const cost = require('./portfolio').getAvgCostPerShare(db, user.id, ticker);
        const item = {
          kind: 'algo',
          ticker,
          price: newest.close,
          priceEur: newest.closeEur,
          currency: newest.currency || 'USD',
          tier: hit.early.tier,
          confidence: hit.early.confidencePct,
          holdDays: user.holdDays,
          percentiles: hit.percentiles,
          avgCost: cost ? cost.avgCostEUR : null,
          gainPct: cost && newest.closeEur ? (newest.closeEur / cost.avgCostEUR - 1) * 100 : null
        };

        if (!byRecipient.has(user.email)) byRecipient.set(user.email, []);
        byRecipient.get(user.email).push(item);
        record.run(user.id, ticker, firedAt, hit.date, hit.early.tier, hit.early.direction, hit.early.confidencePct);
        log(`  🟢 ${ticker}: very strong buy held ${user.holdDays} day(s) → ${user.email}`);
      } catch (err) {
        log(`  ❌ ${ticker}: ${err.message}`);
      }
    }
  }
  return byRecipient;
}

/** Monday, in UTC — the day the standings ride along. */
function isStandingsDay(now = new Date()) {
  return now.getUTCDay() === 1;
}

module.exports = {
  evaluateAlgorithmSignals, standingsFor, sustainedSignal, daysSinceLastAlert,
  isStandingsDay, ALERT_TIER, ALERT_DIRECTION, MAX_PRICE_AGE_DAYS
};
