#!/usr/bin/env node
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(__dirname));

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error reading data file:', e);
  }
  return { transactions: [], snapshots: [] };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error writing data file:', e);
  }
}

app.get('/api/transactions', (req, res) => {
  const data = loadData();
  res.json({ transactions: data.transactions });
});

app.post('/api/transactions', (req, res) => {
  const data = loadData();
  const tx = req.body;

  if (!tx.ts || !tx.ticker || !tx.quantity || !tx.amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  tx.id = 'tx' + Date.now();
  data.transactions.push(tx);
  saveData(data);

  res.json({ success: true, transaction: tx });
});

app.delete('/api/transactions/:id', (req, res) => {
  const data = loadData();
  const idx = data.transactions.findIndex(t => t.id === req.params.id);
  if (idx < 0) {
    return res.status(404).json({ error: 'Not found' });
  }
  data.transactions.splice(idx, 1);
  saveData(data);
  res.json({ success: true });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Portfolio tracker server running on http://localhost:${PORT}`);
});
