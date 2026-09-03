#!/usr/bin/env node
/**
 * migrate.js — migrate transactions from data.json to SQLite
 * Usage: node migrate.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_FILE = path.join(__dirname, 'data.json');
const DB_FILE = path.join(__dirname, 'data.db');
const BACKUP_FILE = path.join(__dirname, 'data.json.backup');

async function migrate() {
  console.log('📦 Starting migration: data.json → SQLite\n');

  // Step 1: Read data.json
  console.log('Step 1: Reading data.json...');
  if (!fs.existsSync(DATA_FILE)) {
    console.error('❌ data.json not found!');
    process.exit(1);
  }

  let data;
  try {
    const rawData = fs.readFileSync(DATA_FILE, 'utf-8');
    data = JSON.parse(rawData);
  } catch (err) {
    console.error('❌ Failed to parse data.json:', err.message);
    process.exit(1);
  }

  const transactions = data.transactions || [];
  console.log(`✓ Found ${transactions.length} transactions in data.json\n`);

  // Step 2: Backup data.json
  console.log('Step 2: Creating backup...');
  if (!fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    console.log(`✓ Backup created: ${BACKUP_FILE}\n`);
  } else {
    console.log('ℹ Backup already exists, skipping\n');
  }

  // Step 3: Connect to SQLite
  console.log('Step 3: Initializing SQLite database...');
  let db;
  try {
    db = new Database(DB_FILE);
    db.pragma('foreign_keys = ON');

    // Initialize schema
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sqlite.sql'), 'utf-8');
    db.exec(schema);

    console.log('✓ SQLite database ready\n');
  } catch (err) {
    console.error('❌ Failed to initialize SQLite:', err.message);
    process.exit(1);
  }

  // Step 4: Insert default user if not exists
  console.log('Step 4: Ensuring default user exists...');
  const userStmt = db.prepare('SELECT id FROM users WHERE id = 1');
  if (!userStmt.get()) {
    const insertUser = db.prepare(
      'INSERT INTO users (id, email, api_key) VALUES (?, ?, ?)'
    );
    insertUser.run(1, 'default@portfoliotracker.local', 'sk_default_phase1_test');
    console.log('✓ Default user created\n');
  } else {
    console.log('✓ Default user already exists\n');
  }

  // Step 5: Insert transactions
  console.log('Step 5: Inserting transactions...');
  const insertStmt = db.prepare(`
    INSERT INTO transactions
    (user_id, ticker, quantity, amount_eur, currency, exchange_rate, tx_type, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let errors = 0;

  for (const tx of transactions) {
    try {
      insertStmt.run(
        1, // user_id = default user
        tx.ticker || 'UNKNOWN',
        tx.quantity || 0,
        tx.amountEUR || tx.amount || 0,
        tx.currency || 'EUR',
        tx.exchangeRate || 1.0,
        tx.type || 'buy',
        tx.ts || Date.now()
      );
      inserted++;
    } catch (err) {
      console.error(`  ⚠ Failed to insert transaction (${tx.ticker}):`, err.message);
      errors++;
    }
  }

  console.log(`✓ Inserted ${inserted} transactions`);
  if (errors > 0) {
    console.log(`⚠ ${errors} transactions failed\n`);
  } else {
    console.log();
  }

  // Step 6: Verify
  console.log('Step 6: Verifying migration...');
  try {
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE user_id = 1');
    const result = countStmt.get();
    const dbCount = result.count;

    console.log(`  SQLite count: ${dbCount}`);
    console.log(`  data.json count: ${transactions.length}`);

    if (dbCount === transactions.length) {
      console.log('  ✓ Counts match!\n');
    } else {
      console.log(`  ⚠ Count mismatch! ${dbCount} in DB vs ${transactions.length} in file\n`);
    }

    // Show sample
    const sampleStmt = db.prepare(
      'SELECT id, ticker, quantity, amount_eur, tx_type, created_at FROM transactions WHERE user_id = 1 LIMIT 3'
    );
    const sample = sampleStmt.all();

    if (sample.length > 0) {
      console.log('Sample transactions:');
      sample.forEach((tx, i) => {
        console.log(
          `  ${i + 1}. ${tx.ticker} x${tx.quantity} @ €${tx.amount_eur} (${tx.tx_type}) - ID:${tx.id}`
        );
      });
      console.log();
    }
  } catch (err) {
    console.error('❌ Verification failed:', err.message);
  }

  // Done
  db.close();

  console.log('═══════════════════════════════════════════');
  console.log('✅ Migration complete!');
  console.log('═══════════════════════════════════════════\n');
  console.log('Next steps:');
  console.log('1. Update package.json with sqlite3 dependency (done)');
  console.log('2. npm install');
  console.log('3. Update .env with DB_PATH setting');
  console.log('4. Restart server: npm start\n');

  process.exit(0);
}

migrate().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
