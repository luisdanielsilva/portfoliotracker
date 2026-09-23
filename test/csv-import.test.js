/**
 * Reading a broker file, pinned against the shapes real exports arrive in.
 *
 * The fixtures below are not invented CSV: they are the conventions that
 * actually differ between banks — semicolons, a decimal comma, a title above
 * the header, dd-mm-yyyy against mm-dd-yyyy, a signed quantity instead of a
 * type column, and a statement that mixes dividends and deposits in with the
 * trades. Every one of them has a way of failing silently, which is why they
 * are here rather than in a comment.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  sniffDelimiter, parseDelimited, detectDecimal, parseNumber, detectDateOrder,
  parseDate, guessMapping, classifyType, normaliseRows, findHeaderRow, readFile
} = require('../csv-import');

/* A European broker: semicolons, decimal comma, dd-mm-yyyy, prices per share. */
const EURO_CSV = [
  'Datum;Produkt;ISIN;Anzahl;Kurs;Währung;Typ',
  '24-06-2015;Tesla Motors Inc;US88160R1014;4;265,92;USD;Kauf',
  '12-10-2021;Deutsche Lufthansa AG;DE0008232125;120;3,58;EUR;Kauf',
  '18-04-2016;Tesla Motors Inc;US88160R1014;8;253,23;USD;Verkauf'
].join('\n');

/* A US broker: commas, decimal point, mm/dd/yyyy, a total instead of a price. */
const US_CSV = [
  'Trade Date,Symbol,Description,Action,Quantity,Amount,Currency',
  '01/30/2025,NVDA,NVIDIA CORP,Buy,10,"1,271.10",USD',
  '02/05/2026,AMD,ADVANCED MICRO DEVICES,Sell,5,"1,027.00",USD'
].join('\n');

test('a semicolon file is not read as one column', () => {
  assert.strictEqual(sniffDelimiter(EURO_CSV), ';');
  assert.strictEqual(sniffDelimiter(US_CSV), ',');
});

test('a quoted field keeps its delimiter and its newline', () => {
  const rows = parseDelimited('a,b\n"1,000","two\nlines"', ',');
  assert.deepStrictEqual(rows[1], ['1,000', 'two\nlines']);
});

test('the BOM Excel writes does not become part of the first header', () => {
  const rows = parseDelimited('﻿Date,Qty\n2021-01-01,3', ',');
  assert.strictEqual(rows[0][0], 'Date');
});

test('1.234,56 and 1,234.56 are both read as the same number', () => {
  assert.strictEqual(detectDecimal(['1.234,56', '99,80', '3,10']), ',');
  assert.strictEqual(detectDecimal(['1,234.56', '99.80', '3.10']), '.');
  assert.strictEqual(parseNumber('1.234,56', ','), 1234.56);
  assert.strictEqual(parseNumber('1,234.56', '.'), 1234.56);
  assert.strictEqual(parseNumber('€ 1.234,56', ','), 1234.56);
  assert.strictEqual(parseNumber('(1.234,56)', ','), -1234.56);
});

test('an unreadable number is null, never zero', () => {
  // A zero would pass every validation the server has and quietly restate a cost basis.
  assert.strictEqual(parseNumber('', '.'), null);
  assert.strictEqual(parseNumber('n/a', '.'), null);
  assert.strictEqual(parseNumber('--', '.'), null);
});

test('day-first and month-first are told apart by the file itself', () => {
  assert.strictEqual(detectDateOrder(['24-06-2015', '18-04-2016']), 'dmy');
  assert.strictEqual(detectDateOrder(['01/30/2025', '02/05/2026']), 'mdy');
  assert.strictEqual(detectDateOrder(['2015-06-24', '2016-04-18']), 'ymd');
});

test('a file where every date is ambiguous says so instead of guessing', () => {
  // 03/04/2021 is two different days and neither is more likely. Picking one
  // would misdate the row and look entirely reasonable on the screen after.
  assert.strictEqual(detectDateOrder(['03/04/2021', '05/06/2021']), 'ambiguous');
});

test('a date that does not exist is refused', () => {
  assert.strictEqual(parseDate('31-02-2021', 'dmy'), null);
  assert.strictEqual(parseDate('24-06-2015', 'dmy'), '2015-06-24');
  assert.strictEqual(parseDate('01/30/2025', 'mdy'), '2025-01-30');
  assert.strictEqual(parseDate('24 Jun 2015', 'dmy'), '2015-06-24');
  assert.strictEqual(parseDate('2015-06-24T09:31:00Z', 'ymd'), '2015-06-24');
});

test('German, Portuguese and Dutch headers are recognised', () => {
  const m = guessMapping(['Datum', 'Produkt', 'ISIN', 'Anzahl', 'Kurs', 'Währung', 'Typ']);
  assert.strictEqual(m.date, 0);
  assert.strictEqual(m.name, 1);
  assert.strictEqual(m.isin, 2);
  assert.strictEqual(m.quantity, 3);
  assert.strictEqual(m.price, 4);
  assert.strictEqual(m.currency, 5);
  assert.strictEqual(m.type, 6);
});

test('"Price" wins price over "Price currency"', () => {
  const m = guessMapping(['Trade Date', 'Price currency', 'Price', 'Quantity']);
  assert.strictEqual(m.price, 2);
});

test('a dividend is not a buy, and a buy that mentions commission still is', () => {
  assert.strictEqual(classifyType('Dividend', 10).type, null);
  assert.strictEqual(classifyType('Deposit', 100).type, null);
  assert.strictEqual(classifyType('Aktiensplit 5:1', 40).type, null);
  assert.strictEqual(classifyType('Buy NVDA, commission included', 10).type, 'buy');
  assert.strictEqual(classifyType('Verkauf', 8).type, 'sell');
});

test('a signed quantity stands in for a missing type column', () => {
  assert.strictEqual(classifyType('', -8).type, 'sell');
  assert.strictEqual(classifyType('', 8).type, 'buy');
});

test('a European export reads end to end', () => {
  const out = readFile(EURO_CSV);
  assert.strictEqual(out.decimal, ',');
  assert.strictEqual(out.dateOrder, 'dmy');
  assert.strictEqual(out.candidates.length, 3);

  const [tsla, lha, sold] = out.candidates;
  assert.strictEqual(tsla.date, '2015-06-24');
  assert.strictEqual(tsla.type, 'buy');
  assert.strictEqual(tsla.quantity, 4);
  assert.strictEqual(tsla.price, 265.92);
  assert.strictEqual(tsla.amountNative, 1063.68);        // price x quantity, fees excluded
  assert.strictEqual(tsla.currency, 'USD');
  assert.strictEqual(tsla.isin, 'US88160R1014');
  assert.strictEqual(tsla.priceDerived, false);
  assert.strictEqual(lha.currency, 'EUR');
  assert.strictEqual(sold.type, 'sell');
});

test('a US export reads end to end, and a derived price says so', () => {
  const out = readFile(US_CSV);
  assert.strictEqual(out.dateOrder, 'mdy');
  const [nvda, amd] = out.candidates;
  assert.strictEqual(nvda.date, '2025-01-30');
  assert.strictEqual(nvda.rawTicker, 'NVDA');
  assert.strictEqual(nvda.price, 127.11);                 // 1,271.10 / 10
  assert.strictEqual(nvda.priceDerived, true);            // so the preview can say fees are still in it
  assert.strictEqual(amd.type, 'sell');
});

test('the rows that are not trades come back named, not dropped', () => {
  const csv = [
    'Date,Description,Quantity,Price,Currency',
    '2025-01-30,Buy NVDA,10,127.11,USD',
    '2025-02-03,Dividend NVDA,0,4.10,USD',
    '2025-02-04,Deposit,0,500,EUR',
    '2025-02-05,Buy VOW.DE,,,EUR'
  ].join('\n');
  const out = readFile(csv);

  assert.strictEqual(out.candidates.length, 1);
  assert.strictEqual(out.skipped.length, 3);
  assert.match(out.skipped[0].reason, /dividend/i);
  assert.match(out.skipped[1].reason, /deposit/i);
  assert.match(out.skipped[2].reason, /quantity/i);
  // every skipped row can be pointed at in the original file
  assert.deepStrictEqual(out.skipped.map(s => s.line), [3, 4, 5]);
});

test('a currency with no stored rate is refused by name', () => {
  const csv = [
    'Date,Symbol,Action,Quantity,Price,Currency',
    '2019-03-14,BP.L,Buy,100,5.42,GBP'
  ].join('\n');
  const out = readFile(csv);
  assert.strictEqual(out.candidates.length, 0);
  assert.match(out.skipped[0].reason, /GBP/);
});

test('a title above the table does not become the header', () => {
  const csv = [
    'Portfolio statement',
    'Account 1234567',
    '',
    'Date,Symbol,Action,Quantity,Price,Currency',
    '2025-01-30,NVDA,Buy,10,127.11,USD'
  ].join('\n');
  const rows = parseDelimited(csv, ',');
  assert.strictEqual(findHeaderRow(rows), 2);            // blank lines are dropped before this
  const out = readFile(csv);
  assert.strictEqual(out.candidates.length, 1);
  assert.strictEqual(out.candidates[0].rawTicker, 'NVDA');
});

test('quantity and price are made positive, whatever sign the file uses', () => {
  // Some brokers write a sell as a negative quantity, some as a negative total,
  // some as both. The app stores a positive quantity and a type.
  const csv = [
    'Date,Symbol,Quantity,Price,Currency',
    '2025-01-30,NVDA,-10,-127.11,USD'
  ].join('\n');
  const [row] = readFile(csv).candidates;
  assert.strictEqual(row.type, 'sell');
  assert.strictEqual(row.quantity, 10);
  assert.strictEqual(row.price, 127.11);
});

test('an explicit mapping overrides the guess', () => {
  // The mapping UI exists for files this cannot read, so the override has to win.
  const csv = 'A,B,C,D,E\n2025-01-30,NVDA,Buy,10,127.11';
  const out = readFile(csv, {
    mapping: { date: 0, ticker: 1, type: 2, quantity: 3, price: 4 },
    defaultCurrency: 'USD',
    dateOrder: 'ymd'
  });
  assert.strictEqual(out.candidates.length, 1);
  assert.strictEqual(out.candidates[0].amountNative, 1271.1);
});

test('formats are detected from the columns that are mapped, not from the file at large', () => {
  // The contract the import screen leans on. A file whose headers mean nothing
  // to the guesser is first read with no columns placed, so there are no values
  // to detect a format from and it falls back to a decimal point. The moment a
  // price column is mapped by hand, reading it again must detect the comma —
  // the client bug this pins turned 127,11 into 12711 and stored a position at
  // a hundred times its cost.
  const csv = 'Col A;Col B;Col C;Col D;Col E\n30-01-2025;NVDA;10;127,11;B';

  const blind = readFile(csv);
  assert.strictEqual(blind.candidates.length, 0, 'nothing is readable before the columns are placed');

  const mapped = readFile(csv, {
    mapping: { date: 0, ticker: 1, quantity: 2, price: 3, type: 4 },
    defaultCurrency: 'USD'
  });
  assert.strictEqual(mapped.decimal, ',');
  assert.strictEqual(mapped.candidates[0].price, 127.11);
  assert.strictEqual(mapped.candidates[0].amountNative, 1271.1);
  assert.strictEqual(mapped.candidates[0].date, '2025-01-30');
});
