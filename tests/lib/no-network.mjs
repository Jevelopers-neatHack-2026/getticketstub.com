// Imported first by tests/prodigi-callbacks.test.mjs, before any app or vendored module loads: every outbound path
// Node offers (global fetch, http/https request/get, net/tls connect and the Socket.prototype.connect they reach)
// throws and is counted, the same guard fulfillment-connectors preloads for its Prodigi suites. The suite asserts
// zero attempts at the end, so a swallowed attempt still fails it. Prodigi is never contacted.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

export const networkAttempts = { count: 0, channels: [] };

function refuse(channel) {
  return function guarded() {
    networkAttempts.count += 1;
    networkAttempts.channels.push(channel);
    const error = new Error(`network is forbidden in this suite (${channel})`);
    error.code = "ERR_NETWORK_FORBIDDEN_BY_SUITE";
    throw error;
  };
}

const fetchGuard = refuse("fetch");
globalThis.fetch = async (...args) => fetchGuard(...args);
http.request = refuse("http.request");
http.get = refuse("http.get");
https.request = refuse("https.request");
https.get = refuse("https.get");
net.connect = refuse("net.connect");
net.createConnection = refuse("net.createConnection");
net.Socket.prototype.connect = refuse("net.Socket.connect");
tls.connect = refuse("tls.connect");
syncBuiltinESMExports();
