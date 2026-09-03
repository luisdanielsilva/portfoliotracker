#!/usr/bin/env node
/**
 * migrate.js — migrate transactions from data.json to MySQL
 * Usage: node migrate.js
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DATA_FILE = path.join(__dirname, 'data.json');
const BACKUP_FILE = path.join(__dirname, 'data.json.backup');

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'portfoliotracker',
  password: process.env.DB_PASSWORD || 'portfolio_secure_pwd_2026',
  database: process.env.DB_NAME || 'portfoliotracker_db',
};

async function migrate() {
  console.log('📦 Starting migration: data.json → MySQL\n');

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

  // Step 3: Connect to MySQL
  console.log('Step 3: Connecting to MySQL...');
  let conn;
  try {
    const pool = mysql.createPool(DB_CONFIG);
    conn = await pool.getConnection();
    console.log('✓ Connected to MySQL\n');
  } catch (err) {
    console.error('❌ Failed to connect to MySQL:', err.message);
    console.error('   Check your .env file and MySQL credentials');
    process.exit(1);
  }

  // Step 4: Insert transactions
  console.log('Step 4: Inserting transactions...');
  let inserted = 0;
  let errors = 0;

  for (const tx of transactions) {
    try {
      // Map old format to new schema
      const result = await conn.execute(
        `INSERT INTO transactions
         (user_id, ticker, quantity, amount_eur, currency, exchange_rate, tx_type, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000))`,
        [
          1, // user_id = default user
          tx.ticker || 'UNKNOWN',
          tx.quantity || 0,
          tx.amountEUR || tx.amount || 0,
          tx.currency || 'EUR',
          tx.exchangeRate || 1.0,
          tx.type || 'buy',
          tx.ts || Date.now(),
          tx.ts || Date.now(),
        ]
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

  // Step 5: Verify
  console.log('Step 5: Verifying migration...');
  try {
    const [rows] = await conn.execute('SELECT COUNT(*) as count FROM transactions WHERE user_id = 1');
    const dbCount = rows[0].count;
    console.log(`  MySQL count: ${dbCount}`);
    console.log(`  data.json count: ${transactions.length}`);

    if (dbCount === transactions.length) {
      console.log('  ✓ Counts match!\n');
    } else {
      console.log(`  ⚠ Count mismatch! ${dbCount} in DB vs ${transactions.length} in file\n`);
    }

    // Show sample
    const [sample] = await conn.execute(
      'SELECT id, ticker, quantity, amount_eur, tx_type, created_at FROM transactions WHERE user_id = 1 LIMIT 3'
    );
    console.log('Sample transactions:');
    sample.forEach((tx, i) => {
      console.log(
        `  ${i + 1}. ${tx.ticker} x${tx.quantity} @ €${tx.amount_eur} (${tx.tx_type}) - ${tx.id}`
      );
    });
    console.log();
  } catch (err) {
    console.error('❌ Verification failed:', err.message);
  }

  // Done
  console.log('═══════════════════════════════════════════');
  console.log('✅ Migration complete!');
  console.log('═══════════════════════════════════════════\n');
  console.log('Next steps:');
  console.log('1. Update server.js to use MySQL (already done)');
  console.log('2. npm install mysql2');
  console.log('3. Create .env with DB credentials');
  console.log('4. Restart server: npm start\n');

  conn.release();
  process.exit(0);
}

migrate().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
