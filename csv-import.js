/**
 * Reading a broker's CSV into candidate transactions.
 *
 * Everything in here is pure text handling: a file goes in, candidate rows and
 * a list of what was skipped come out. Nothing touches the database, nothing
 * reaches the network, and no arithmetic depends on the machine it runs on.
 * That is deliberate — this file is loaded twice, by the browser (which is
 * where the file is actually parsed, so a statement full of your trades never
 * reaches the server) and by node (which is where the tests are).
 *
 * The one thing it will not do is decide anything quietly. A column it cannot
 * place, a row it cannot classify and a number it cannot read all come back
 * named, because the screen that follows this is a confirmation screen and it
 * can only confirm what it is shown.
 */

/* ---------------------------------------------------------------- parsing */

/**
 * Which character separates the fields.
 *
 * Counting delimiters across the whole file beats trusting the header line:
 * a bank that writes "Amount, EUR" as a single quoted heading has a comma in
 * its header and semicolons everywhere else. The winner is the character whose
 * count per line is both highest and most consistent, which is what a real
 * delimiter looks like and what a comma inside prose does not.
 */
function sniffDelimiter(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 20);
  if (!lines.length) return ',';
  let best = ',', bestScore = -1;
  for (const candidate of [';', ',', '\t', '|']) {
    const counts = lines.map(line => countOutsideQuotes(line, candidate));
    const first = counts[0];
    if (!first) continue;
    const consistent = counts.filter(c => c === first).length / counts.length;
    const score = first * consistent;
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}

function countOutsideQuotes(line, ch) {
  let n = 0, inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ch && !inQuotes) n++;
  }
  return n;
}

/**
 * RFC 4180 with the escapes brokers actually produce: quoted fields, doubled
 * quotes inside them, and newlines inside a quoted field — which is how a
 * security called `NVIDIA CORP\nCOMMON STOCK` arrives and why splitting the
 * file on newlines first would lose rows.
 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;   // strip the BOM Excel adds

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  row.push(field);
  rows.push(row);

  return rows
    .map(r => r.map(f => f.trim()))
    .filter(r => r.some(f => f !== ''));
}

/* -------------------------------------------------- numbers and dates */

/**
 * Whether this file writes 1.234,56 or 1,234.56.
 *
 * Decided over the whole column rather than per value, because a single "1,25"
 * is genuinely ambiguous and a hundred of them are not. The rule that settles
 * it: in a comma-decimal file the comma is always last and always has one or
 * two digits after it; in a point-decimal file the comma groups thousands and
 * is therefore followed by exactly three digits.
 */
function detectDecimal(values) {
  let comma = 0, point = 0;
  for (const raw of values) {
    const v = String(raw || '').trim();
    if (!/[\d]/.test(v)) continue;
    if (/,\d{1,2}(?!\d)/.test(v) && !/\.\d/.test(v.slice(v.indexOf(',')))) comma++;
    if (/\.\d{1,2}(?!\d)/.test(v) && !/,\d/.test(v.slice(v.indexOf('.')))) point++;
    if (/\d,\d{3}(?!\d)/.test(v)) point++;
    if (/\d\.\d{3}(?!\d)/.test(v)) comma++;
  }
  return comma > point ? ',' : '.';
}

/**
 * A number, or null — never NaN and never a silent zero. A field this cannot
 * read is a field the reader has to look at, and zero would pass validation.
 */
function parseNumber(raw, decimal) {
  if (raw === null || raw === undefined) return null;
  let v = String(raw).trim();
  if (!v) return null;
  let negative = false;
  if (/^\(.*\)$/.test(v)) { negative = true; v = v.slice(1, -1); }        // (1.234,56) is a minus sign
  v = v.replace(/[^\d,.\-+]/g, '');                                       // currency symbols, spaces, NBSP
  if (!v || !/\d/.test(v)) return null;
  if (v.startsWith('-')) { negative = true; v = v.slice(1); }
  v = v.replace(/^\+/, '');
  v = decimal === ','
    ? v.replace(/\./g, '').replace(',', '.')
    : v.replace(/,/g, '');
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  return negative ? -n : n;
}

const DATE_SEP = /[\/.\-\s]/;

/**
 * Which of day and month comes first.
 *
 * Only the file can answer this and only sometimes: 03/04/2021 is two different
 * days depending on the bank's country. Any value with a component above 12 in
 * the first or second position settles it for the whole file; if nothing does,
 * the answer is 'ambiguous' and the caller is expected to ask rather than
 * assume. Guessing here would misdate up to a third of a year's trades and the
 * result would look perfectly reasonable.
 */
function detectDateOrder(values) {
  let dmy = 0, mdy = 0, ymd = 0, seen = 0;
  for (const raw of values) {
    const v = String(raw || '').trim();
    if (!v) continue;
    const parts = v.split(/[T ]/)[0].split(DATE_SEP).filter(Boolean);
    if (parts.length < 3) continue;
    const [a, b] = [parseInt(parts[0], 10), parseInt(parts[1], 10)];
    if (!isFinite(a) || !isFinite(b)) continue;
    seen++;
    if (parts[0].length === 4) { ymd++; continue; }
    if (a > 12) dmy++;
    else if (b > 12) mdy++;
  }
  if (!seen) return 'unknown';
  if (ymd > dmy && ymd > mdy) return 'ymd';
  if (dmy && !mdy) return 'dmy';
  if (mdy && !dmy) return 'mdy';
  if (dmy || mdy) return dmy >= mdy ? 'dmy' : 'mdy';
  return 'ambiguous';
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  mrz: 3, mai: 5, okt: 10, dez: 12, ene: 1, abr: 4, ago: 8, dic: 12, fev: 2, out: 10, set: 9
};

/** An ISO date string, or null. Time of day is dropped: the app stores 12:00. */
function parseDate(raw, order) {
  const v = String(raw || '').trim();
  if (!v) return null;
  // Drop a time of day, and only a time of day: splitting on the first space
  // instead would turn "24 Jun 2015" into "24".
  const datePart = v.replace(/T/g, ' ')
    .replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AaPp][Mm])?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/, '')
    .trim();
  const parts = datePart.split(DATE_SEP).filter(Boolean);
  if (parts.length < 3) return null;

  let y, m, d;
  const monthName = MONTHS[String(parts[1]).slice(0, 3).toLowerCase()];
  if (monthName) {
    m = monthName;
    d = parseInt(parts[0], 10);
    y = parseInt(parts[2], 10);
  } else if (parts[0].length === 4 || order === 'ymd') {
    [y, m, d] = parts.map(p => parseInt(p, 10));
  } else if (order === 'mdy') {
    [m, d, y] = parts.map(p => parseInt(p, 10));
  } else {
    [d, m, y] = parts.map(p => parseInt(p, 10));
  }
  if (![y, m, d].every(n => isFinite(n))) return null;
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // 31 February parses arithmetically and is still not a day
  const check = new Date(iso + 'T12:00:00Z');
  if (isNaN(check.getTime()) || check.getUTCDate() !== d) return null;
  return iso;
}

/* ------------------------------------------------------------- columns */

/**
 * What each column probably is.
 *
 * The synonyms cover the languages a European broker statement actually
 * arrives in — a Portuguese, German, Dutch or French export is not an edge
 * case here, it is the common case. Nothing is auto-accepted: this only
 * pre-fills the mapping UI, and every guess is shown next to real values from
 * the file so a wrong one is visible before it matters.
 */
const FIELD_SYNONYMS = {
  date: ['date', 'trade date', 'transaction date', 'value date', 'datum', 'data', 'fecha', 'dato', 'settlement date', 'execution date', 'date de', 'handelsdatum', 'buchungstag'],
  isin: ['isin', 'isin code', 'security id', 'symbol isin'],
  ticker: ['ticker', 'symbol', 'symbool', 'simbolo', 'código', 'codigo', 'kürzel', 'wkn'],
  name: ['name', 'product', 'security', 'description', 'omschrijving', 'produto', 'produkt', 'bezeichnung', 'designação', 'designacao', 'instrument', 'libellé', 'libelle'],
  quantity: ['quantity', 'qty', 'shares', 'aantal', 'quantidade', 'anzahl', 'stück', 'stuck', 'nominal', 'units', 'menge', 'quantité', 'quantite'],
  price: ['price', 'unit price', 'share price', 'koers', 'preço', 'preco', 'preis', 'kurs', 'cotação', 'cotacao', 'prix', 'price per share', 'executed price'],
  amount: ['amount', 'total', 'value', 'gross amount', 'net amount', 'waarde', 'totaal', 'montante', 'valor', 'betrag', 'gesamt', 'umsatz', 'montant'],
  currency: ['currency', 'ccy', 'valuta', 'moeda', 'währung', 'wahrung', 'divisa', 'devise'],
  type: ['type', 'typ', 'transaction type', 'action', 'side', 'buy/sell', 'soort', 'tipo', 'art', 'operação', 'operacao', 'sens', 'order type', 'description'],
  fee: ['fee', 'fees', 'commission', 'costs', 'kosten', 'comissão', 'comissao', 'gebühr', 'gebuhr', 'taxa', 'brokerage', 'frais'],
  orderRef: ['order id', 'orderid', 'order', 'reference', 'ref', 'transaction id', 'id', 'referentie', 'referência', 'referencia', 'auftragsnummer', 'trade id']
};

function normaliseHeader(h) {
  return String(h || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // fold accents, so "Preço" matches "preco"
    .replace(/[^a-z0-9 /]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-guess column indices, by exact header match first and containment
 * second. Exact wins because a file with both "Price" and "Price currency"
 * should not have the second one claim `price` on a coin toss.
 */
function guessMapping(headers) {
  const norm = headers.map(normaliseHeader);
  const mapping = {};
  const taken = new Set();

  for (const pass of ['exact', 'contains']) {
    for (const [field, words] of Object.entries(FIELD_SYNONYMS)) {
      if (mapping[field] != null) continue;
      for (let i = 0; i < norm.length; i++) {
        if (taken.has(i) || !norm[i]) continue;
        const hit = pass === 'exact'
          ? words.some(w => norm[i] === normaliseHeader(w))
          : words.some(w => norm[i].includes(normaliseHeader(w)));
        if (hit) { mapping[field] = i; taken.add(i); break; }
      }
    }
  }
  return mapping;
}

/* ------------------------------------------------------ classification */

const BUY_WORDS = ['buy', 'bought', 'purchase', 'koop', 'aankoop', 'compra', 'kauf', 'achat', 'acquisto', 'b'];
const SELL_WORDS = ['sell', 'sold', 'sale', 'verkoop', 'venda', 'verkauf', 'vente', 'vendita', 's'];

/**
 * Rows that are not a buy or a sell.
 *
 * These are listed and skipped, never imported and never dropped in silence.
 * The app stores buys and sells and has nowhere to put a dividend or a deposit;
 * importing one as a purchase is exactly the shape of the split-as-purchase bug
 * that took a day to find, so the safe failure here is to refuse and say so.
 */
const NON_TRADE_WORDS = [
  ['dividend', 'dividendo', 'dividende', 'dividenden'],
  ['interest', 'juros', 'zinsen', 'rente', 'interet'],
  ['deposit', 'depósito', 'deposito', 'einzahlung', 'storting', 'versement'],
  ['withdrawal', 'levantamento', 'auszahlung', 'opname', 'retrait'],
  ['fee', 'comissão', 'comissao', 'gebühr', 'gebuhr', 'kosten', 'taxa', 'frais', 'commission'],
  ['tax', 'imposto', 'steuer', 'belasting', 'impot', 'withholding'],
  ['transfer', 'transferência', 'transferencia', 'übertrag', 'ubertrag', 'overboeking'],
  ['split', 'desdobramento', 'aktiensplit', 'reverse split'],
  ['conversion', 'fx', 'câmbio', 'cambio', 'währungswechsel', 'valuta'],
  ['subscription', 'rights', 'direitos', 'bezugsrecht'],
  ['merger', 'spin', 'fusão', 'fusao', 'fusion']
];

function classifyType(text, quantity) {
  const v = normaliseHeader(text);
  if (v) {
    for (const group of NON_TRADE_WORDS) {
      if (group.some(w => v.includes(normaliseHeader(w)))) {
        // "Buy NVDA — commission included" is a buy that happens to say fee
        const buyish = BUY_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(v));
        const sellish = SELL_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(v));
        if (!buyish && !sellish) return { type: null, reason: group[0] };
      }
    }
    if (SELL_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(v))) return { type: 'sell' };
    if (BUY_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(v))) return { type: 'buy' };
  }
  // No type column at all: a signed quantity is the other convention brokers use
  if (quantity !== null && quantity < 0) return { type: 'sell' };
  if (quantity !== null && quantity > 0) return { type: 'buy' };
  return { type: null, reason: 'no buy or sell' };
}

/* ---------------------------------------------------------- normalising */

const SUPPORTED_CURRENCIES = new Set(['EUR', 'USD']);

/**
 * Candidate transactions from mapped rows.
 *
 * `amount` is deliberately price × quantity and nothing else — the decision
 * taken when this was designed. Where the file has no price column the price is
 * derived from the total, and that row is flagged `priceDerived` so the preview
 * can say the fees are still inside it.
 *
 * Nothing here is written anywhere. Both lists are for the confirmation screen:
 * `candidates` is what would be imported, `skipped` is everything else with the
 * reason it did not make it, because a row that vanishes without explanation is
 * how an import quietly loses a holding.
 */
function normaliseRows(rows, mapping, opts) {
  const options = opts || {};
  const dataRows = rows.slice(options.headerRow == null ? 1 : options.headerRow + 1);
  const at = (row, field) => (mapping[field] == null ? '' : (row[mapping[field]] || ''));

  const numericSamples = [];
  const dateSamples = [];
  for (const row of dataRows.slice(0, 200)) {
    for (const f of ['quantity', 'price', 'amount', 'fee']) if (mapping[f] != null) numericSamples.push(at(row, f));
    if (mapping.date != null) dateSamples.push(at(row, 'date'));
  }
  const decimal = options.decimal || detectDecimal(numericSamples);
  const dateOrder = options.dateOrder || detectDateOrder(dateSamples);

  const candidates = [], skipped = [];
  dataRows.forEach((row, i) => {
    const line = (options.headerRow == null ? 2 : options.headerRow + 2) + i;
    const add = reason => skipped.push({ line, reason, raw: row.join(' | ').slice(0, 120) });

    const date = parseDate(at(row, 'date'), dateOrder);
    const rawQty = parseNumber(at(row, 'quantity'), decimal);
    const rawPrice = parseNumber(at(row, 'price'), decimal);
    const rawAmount = parseNumber(at(row, 'amount'), decimal);
    const typeText = [at(row, 'type'), at(row, 'name')].filter(Boolean).join(' ');
    const { type, reason } = classifyType(typeText, rawQty);

    if (!type) { add(reason === 'no buy or sell' ? 'not a buy or sell' : `${reason} row`); return; }
    if (!date) { add(at(row, 'date') ? `unreadable date "${at(row, 'date')}"` : 'no date'); return; }
    if (rawQty === null || rawQty === 0) { add('no quantity'); return; }

    const quantity = Math.abs(rawQty);
    let price = rawPrice === null ? null : Math.abs(rawPrice);
    let priceDerived = false;
    if (price === null || price === 0) {
      if (rawAmount === null || rawAmount === 0) { add('no price and no total'); return; }
      price = Math.abs(rawAmount) / quantity;
      priceDerived = true;
    }

    const currency = String(at(row, 'currency') || options.defaultCurrency || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    if (!currency) { add('no currency'); return; }
    if (!SUPPORTED_CURRENCIES.has(currency)) { add(`${currency} is not supported — only EUR and USD have stored rates`); return; }

    candidates.push({
      line,
      date,
      type,
      quantity,
      price: round(price, 6),
      amountNative: round(price * quantity, 2),
      currency,
      priceDerived,
      isin: (at(row, 'isin') || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null,
      rawTicker: (at(row, 'ticker') || '').toUpperCase().trim() || null,
      name: at(row, 'name') || null,
      orderRef: at(row, 'orderRef') || null
    });
  });

  return { candidates, skipped, decimal, dateOrder };
}

function round(n, places) {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

/**
 * Everything the preview needs, from raw file text.
 *
 * Kept as one call because the browser has no reason to drive the steps
 * separately, and the tests want the whole pipeline pinned rather than four
 * pieces that each pass alone.
 */
function readFile(text, opts) {
  const options = opts || {};
  const delimiter = options.delimiter || sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) return { error: 'The file has no rows.' };

  const headerRow = options.headerRow == null ? findHeaderRow(rows) : options.headerRow;
  const headers = rows[headerRow] || [];
  const mapping = options.mapping || guessMapping(headers);
  const result = normaliseRows(rows, mapping, { ...options, headerRow });

  return { delimiter, headers, headerRow, mapping, rows, ...result };
}

/**
 * Which line the headers are on.
 *
 * Brokers put a title, an account number and a blank line above the table often
 * enough that assuming line 1 would fail on a real export. The header is the
 * first row whose cells are mostly non-numeric and that names at least two
 * fields we recognise.
 */
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i];
    if (row.length < 3) continue;
    const named = Object.keys(guessMapping(row)).length;
    const numeric = row.filter(c => /^\s*[\d.,\-+()]+\s*$/.test(c) && /\d/.test(c)).length;
    if (named >= 2 && numeric <= row.length / 3) return i;
  }
  return 0;
}

const api = {
  sniffDelimiter, parseDelimited, detectDecimal, parseNumber, detectDateOrder, parseDate,
  guessMapping, normaliseHeader, classifyType, normaliseRows, findHeaderRow, readFile,
  FIELD_SYNONYMS, SUPPORTED_CURRENCIES
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.CsvImport = api;
