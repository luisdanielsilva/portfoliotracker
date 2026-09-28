/**
 * A `--require` preload (`NODE_OPTIONS=--require test/fixtures/no-network.js`)
 * that turns any attempt to reach the network, or even to load
 * `yahoo-finance2`, into a thrown error.
 *
 * This backs the spawn test in test/verify-portfolio.test.js that proves the
 * default run of verify-portfolio.js makes no network call at all — not "we
 * didn't observe one," but "every path that could have was replaced with one
 * that throws, and the script still ran to completion."
 */
'use strict';

const Module = require('node:module');
const originalLoad = Module._load;
const YF_RE = /^yahoo-finance2(\/|$)/;   // also catches subpath requires, e.g. 'yahoo-finance2/dist/...'
Module._load = function (request, parent, isMain) {
  if (YF_RE.test(request)) {
    throw new Error('no-network fixture: yahoo-finance2 must not be loaded on the default path');
  }
  return originalLoad.apply(this, arguments);
};

function blocked(name) {
  return function () {
    throw new Error(`no-network fixture: ${name} must not be called on the default path`);
  };
}

globalThis.fetch = blocked('fetch');

const http = require('node:http');
const https = require('node:https');
http.request = blocked('http.request');
http.get = blocked('http.get');
https.request = blocked('https.request');
https.get = blocked('https.get');

const net = require('node:net');
net.connect = blocked('net.connect');
net.createConnection = blocked('net.createConnection');

const tls = require('node:tls');
tls.connect = blocked('tls.connect');

const dns = require('node:dns');
dns.lookup = blocked('dns.lookup');
dns.resolve = blocked('dns.resolve');
