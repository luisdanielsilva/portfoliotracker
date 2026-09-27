/**
 * One row for every alert this app has actually told somebody about.
 *
 * WHY A LOG AT ALL. Until now an alert left almost no trace. A hand-built rule
 * updated `alerts.last_triggered_at` — one column, overwritten by the next firing,
 * so the third dip erased the first two — and the algorithm wrote a thin row in
 * `algo_alert_log` with no price on it. Neither could answer the question this
 * table exists for: *was the alert given, and did the person then act on it?*
 *
 * WHY ONE TABLE FOR BOTH KINDS. The hand-built rules and the algorithm are
 * deliberately different features (see algo-alerts.js), but they are the same
 * event from the reader's side: something arrived in their inbox about a holding
 * on a day. Keeping two logs would mean every evaluation query is a UNION of two
 * shapes, one of which lacks the price the evaluation needs. So `alert_events`
 * records both, and `source` says which produced it.
 *
 * WHAT COUNTS AS AN EVENT. A row is written when an alert is put into somebody's
 * digest — not when a rule's condition is merely true. A hand-built rule sends at
 * most once a day, so a condition that holds for nine days is nine rows: a daily
 * reminder, which is what the user wants (#27). A very strong buy inside the
 * algorithm's cooldown is not an event at all. `delivery` records what became of
 * the send, so a mail that never left is not counted as something the reader
 * ignored.
 *
 * WHAT COUNTS AS AN ALERT. Anything that counts — a follow-through rate, the
 * decision journal — reads *episodes* (alertEpisodes below): consecutive
 * reminders of one rule on one holding, one decision to make. Nine reminders
 * counted as nine alerts would divide by the wrong number.
 *
 * PRIVACY. This lives on the financial side, keyed by the same opaque user key
 * as `transactions`. Nothing here can be turned back into a person without
 * identity.db, which is the whole point of the split.
 */

/**
 * What the alert argued for, which is what a follow-through has to match.
 *
 * The three level rules are 'watch' rather than a guess. "TSLA above 350" is a
 * buy signal for one person and a sell target for the next — the app was never
 * told which, so recording either would be inventing the reader's intent, and
 * the whole table's value is that it does not invent anything. A 'watch' event
 * counts a trade in either direction as having acted.
 */
const DIRECTION_OF = {
  algo: 'buy',                 // the algorithm only ever emails a very strong buy
  dip_from_avg_cost: 'buy',    // below your average cost: the rule for averaging in
  gain_from_avg_cost: 'sell',  // up on what you paid: the rule for taking some off
  drop_from_high: 'sell',      // off its own high: the rule that protects a gain
  price_above: 'watch',
  price_below: 'watch',
  change_pct: 'watch'
};

const INSERT_SQL = `
  INSERT INTO alert_events
    (user_id, ticker, source, alert_type, direction, alert_id, fired_at, signal_date,
     price_native, price_eur, currency, threshold, avg_cost_eur, detail)
  VALUES (@user_id, @ticker, @source, @alert_type, @direction, @alert_id, @fired_at, @signal_date,
          @price_native, @price_eur, @currency, @threshold, @avg_cost_eur, @detail)`;

/**
 * Write one alert down and return its id.
 *
 * The price is stored on the row rather than looked up later from `prices`,
 * because the evaluation asks what the reader was told at the time — and a
 * backfill, a split adjustment or a restated FX rate can all change what that
 * day's price row says afterwards.
 */
function recordAlertEvent(db, e) {
  const alertType = e.alertType || e.source;
  const row = {
    user_id: e.userId,
    ticker: e.ticker,
    source: e.source,
    alert_type: alertType,
    direction: e.direction || DIRECTION_OF[alertType] || 'watch',
    alert_id: e.alertId ?? null,
    fired_at: e.firedAt || new Date().toISOString(),
    signal_date: e.signalDate ?? null,
    price_native: e.priceNative ?? null,
    price_eur: e.priceEur ?? null,
    currency: e.currency ?? null,
    threshold: e.threshold ?? null,
    avg_cost_eur: e.avgCostEur ?? null,
    detail: e.detail == null ? null : JSON.stringify(e.detail)
  };
  return db.prepare(INSERT_SQL).run(row).lastInsertRowid;
}

/**
 * Record what happened to the email these events rode in.
 *
 * 'sent' means the mailer accepted it. 'not_sent' covers the quiet refusals —
 * no SMTP configured, or mailguard's daily ceiling — which are not failures and
 * are not the reader's fault either. 'failed' is a send that threw. Anything
 * still 'pending' afterwards means the process died between firing and sending,
 * and it should be read as "unknown", not as "delivered".
 */
function markDelivery(db, eventIds, status) {
  const ids = (eventIds || []).filter(id => id != null);
  if (!ids.length) return 0;
  const stmt = db.prepare(
    'UPDATE alert_events SET delivery = ?, delivered_at = CURRENT_TIMESTAMP WHERE id = ?'
  );
  const run = db.transaction(list => { for (const id of list) stmt.run(status, id); });
  run(ids);
  return ids.length;
}

/** Everything a user was told, newest first. `ticker` and `since` narrow it. */
function eventsFor(db, userId, { ticker = null, since = null, limit = 500 } = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (ticker) { where.push('ticker = ?'); args.push(ticker); }
  if (since) { where.push('date(fired_at) >= ?'); args.push(since); }
  return db.prepare(
    `SELECT * FROM alert_events WHERE ${where.join(' AND ')} ORDER BY fired_at DESC LIMIT ?`
  ).all(...args, limit).map(withDetail);
}

function withDetail(row) {
  let detail = null;
  try { detail = row.detail ? JSON.parse(row.detail) : null; } catch { detail = null; }
  return { ...row, detail };
}

/** SQLite writes CURRENT_TIMESTAMP as UTC without saying so; ISO strings say so. */
function millisOf(stamp) {
  if (!stamp) return NaN;
  const s = String(stamp);
  return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
}

/**
 * Consecutive reminders of one rule, grouped into the decision they are about.
 *
 * A dip that holds for a week is emailed every morning (#27) — seven rows, one
 * episode. Rows join an episode while each follows the last within `gapDays`
 * (default 3), so a missed run or a day the price bobbed back over the line does
 * not split one dip into two. ORCL's dip in September 2026 skipped the 23rd and
 * carried on; that is one episode.
 *
 * "One rule" is the rule row for a hand-built alert (`alert_id`) and the alert
 * type for the algorithm, which has no row. Two different dip rules on the same
 * holding (15% and 25%) are two episodes: they are two thresholds the reader set.
 *
 * Takes rows oldest first (as read from alert_events, `detail` parsed or not) and
 * returns episodes oldest first. Pure, so it can be argued with in a test.
 */
function alertEpisodes(rows, { gapDays = 3 } = {}) {
  const gapMs = gapDays * 864e5;
  const open = new Map();   // rule key -> episode still accepting reminders
  const out = [];
  for (const r of rows) {
    const key = `${r.user_id}|${r.ticker}|${r.alert_type}|${r.alert_id ?? ''}`;
    const at = millisOf(r.fired_at);
    let ep = open.get(key);
    if (!ep || at - ep.lastMs > gapMs) {
      ep = {
        ...r,                          // the first reminder's row: what the reader was first told
        firstMs: at, lastMs: at,
        firstAt: r.fired_at, lastAt: r.fired_at,
        reminders: 0, eventIds: [],
        lastPriceEur: null, lastPriceNative: null
      };
      open.set(key, ep);
      out.push(ep);
    }
    ep.lastMs = at;
    ep.lastAt = r.fired_at;
    ep.reminders++;
    ep.eventIds.push(r.id);
    ep.lastPriceEur = r.price_eur ?? ep.lastPriceEur;
    ep.lastPriceNative = r.price_native ?? ep.lastPriceNative;
  }
  return out;
}

/**
 * Did each alert get acted on, and how long did that take?
 *
 * Scored per *episode*, not per reminder (see alertEpisodes): a trade counts if
 * it lands after the first reminder and within `windowDays` of the last one, in
 * the direction the alert argued for. Days to act are counted from the first
 * reminder, because that is when the reader first knew.
 *
 * Matched in JavaScript rather than SQL on purpose: the rule is a judgment
 * ("a trade in the same holding, in the direction the alert argued for, within
 * the window") and it will be argued with. It should be readable.
 *
 * Two honest limits, worth stating wherever a number from this is quoted:
 * a transaction's `ts` is the trade date the user typed, so it can predate the
 * alert that appears to have caused it; and a purchase after a buy alert is
 * evidence of correlation, never of cause — the reader may have been buying
 * that week regardless.
 */
function followThrough(db, { userId = null, windowDays = 30, onlyDelivered = true, since = null, gapDays = 3 } = {}) {
  const where = [];
  const args = [];
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  if (onlyDelivered) where.push("delivery = 'sent'");
  if (since) { where.push('date(fired_at) >= ?'); args.push(since); }
  const rows = db.prepare(
    `SELECT * FROM alert_events${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY fired_at ASC, id ASC`
  ).all(...args).map(withDetail);
  if (!rows.length) return [];

  const txOf = new Map();  // "user|ticker" -> transactions, oldest first
  const txStmt = db.prepare(
    'SELECT id, tx_type, ts, quantity, amount_eur FROM transactions WHERE user_id = ? AND ticker = ? ORDER BY ts ASC'
  );
  const windowMs = windowDays * 864e5;

  return alertEpisodes(rows, { gapDays }).map(e => {
    const key = `${e.user_id}|${e.ticker}`;
    if (!txOf.has(key)) txOf.set(key, txStmt.all(e.user_id, e.ticker));
    const hit = matchTrade(txOf.get(key), e, windowMs);
    return {
      ...e,
      followed: Boolean(hit),
      action: hit ? hit.tx_type : null,
      actedAt: hit ? new Date(hit.ts).toISOString() : null,
      transactionId: hit ? hit.id : null,
      daysToAction: hit ? (hit.ts - e.firstMs) / 864e5 : null,
      quantity: hit ? hit.quantity : null,
      amountEur: hit ? hit.amount_eur : null
    };
  });
}

/** The first trade that answers an episode: right direction, after it began, inside the window. */
function matchTrade(transactions, episode, windowMs) {
  const wanted = episode.direction === 'buy' ? 'buy' : episode.direction === 'sell' ? 'sell' : null;
  return transactions.find(t =>
    t.ts > episode.firstMs && t.ts <= episode.lastMs + windowMs
    && (wanted === null || t.tx_type === wanted)) || null;
}

/**
 * Follow-through rate by alert type — the shape the eventual question wants.
 * Deliberately no opinion about what a good rate is: 'watch' rules count any
 * trade, so their rate is not comparable with a dip's, and a type with four
 * events has no rate worth the name.
 */
function summariseFollowThrough(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.alert_type;
    if (!by.has(k)) by.set(k, { alertType: k, direction: r.direction, given: 0, followed: 0, daysSum: 0 });
    const g = by.get(k);
    g.given++;
    if (r.followed) { g.followed++; g.daysSum += r.daysToAction; }
  }
  return [...by.values()]
    .map(g => ({
      alertType: g.alertType,
      direction: g.direction,
      given: g.given,
      followed: g.followed,
      followRatePct: g.given ? (g.followed / g.given) * 100 : null,
      meanDaysToAction: g.followed ? g.daysSum / g.followed : null
    }))
    .sort((a, b) => b.given - a.given);
}

module.exports = {
  recordAlertEvent, markDelivery, eventsFor, followThrough, summariseFollowThrough,
  alertEpisodes, matchTrade, withDetail, millisOf, DIRECTION_OF
};
