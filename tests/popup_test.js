// Cambiando de modo deprisa, la respuesta lenta del servidor anterior no debe
// pisar la del actual.
//
//   node tests/popup_test.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const pendientes = []; // respuestas de "status" sin contestar, en orden
const nada = () => {};
const els = {};
const el = (id) =>
  (els[id] ||= {
    id, textContent: "", className: "", title: "", value: "", style: {},
    classList: { add: nada, toggle: nada },
    setAttribute: nada, addEventListener: nada, append: nada,
  });
const ctx = vm.createContext({
  console,
  setInterval: nada,
  document: { getElementById: el, createElement: () => el("enlace" + Math.random()), activeElement: null },
  chrome: {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => (msg.type === "status" ? pendientes.push(cb) : cb({ ok: false })),
      openOptionsPage: nada,
    },
    tabs: { query: nada, sendMessage: nada },
    storage: { sync: { get: async (d) => ({ ...d, modo: "local" }), set: async () => {} } },
  },
});
const dir = path.join(__dirname, "..", "extension");
vm.runInContext(
  fs.readFileSync(path.join(dir, "ajustes.js"), "utf8") +
    fs.readFileSync(path.join(dir, "popup.js"), "utf8"),
  ctx
);

(async () => {
  await new Promise((r) => setTimeout(r, 10));
  // La del arranque (servidor que tarda en caer) y la de un cambio de modo.
  vm.runInContext("comprobarServidor()", ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(pendientes.length, 2);
  pendientes[1]({ ok: true, data: { watching: [], disk_used_bytes: 0 } });
  await new Promise((r) => setTimeout(r, 10));
  pendientes[0]({ ok: false, error: "tiempo agotado" });
  await new Promise((r) => setTimeout(r, 10));

  assert.strictEqual(el("state").textContent, "conectado", "la respuesta vieja piso a la nueva");
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
