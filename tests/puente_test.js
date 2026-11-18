// Guardar el servidor desde el panel web (puente.js) y pedir el permiso de su
// dominio (background.js).
//
//   node tests/puente_test.js
//
// puente.js es un content script: Chrome no le da chrome.permissions, asi que
// aqui tampoco lo tiene. Antes lo usaba, y una direccion https no se guardaba.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const dir = path.join(__dirname, "..", "extension");
const leer = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pulsa "Guardar en la extension" con esa direccion. `abierta`: lo que
 * contesta el service worker a pedirPermiso. */
async function guardarDesdeElPanel(direccion, abierta) {
  const els = {};
  const el = (id) =>
    (els[id] ||= {
      id, value: "", textContent: "", className: "", disabled: true,
      classList: { add() {} },
      addEventListener(_, f) { this.alPulsar = f; },
    });
  const guardado = [];
  const pedidos = [];
  const ctx = vm.createContext({
    console, URL, setTimeout, setInterval: () => 0, clearInterval() {},
    document: { getElementById: el },
    chrome: {
      storage: {
        sync: { get: async (d) => ({ ...d, modo: "local" }), set: async (o) => guardado.push(o) },
      },
      runtime: { sendMessage: (m, cb) => { pedidos.push(m); cb({ ok: true, abierta }); } },
    },
  });
  vm.runInContext(leer("ajustes.js") + leer("puente.js"), ctx);
  el("panel-extension");
  await espera(30);
  el("ext-server").value = direccion;
  el("ext-token").value = "secreto";
  await el("btn-save-ext").alPulsar();
  return { guardado: guardado.filter((o) => "modo" in o).pop(), pedidos, aviso: el("ext-msg").textContent };
}

async function pedirPermiso(yaConcedido) {
  let oyente = null;
  let abierta = false;
  const ctx = vm.createContext({
    console, AbortSignal, fetch,
    importScripts: (f) => vm.runInContext(leer(f), ctx),
    chrome: {
      runtime: { onMessage: { addListener: (f) => (oyente = f) }, openOptionsPage: () => (abierta = true) },
      permissions: { contains: async () => yaConcedido },
      storage: { local: { set: async () => {} }, sync: { get: async (d) => d, set: async () => {} } },
    },
  });
  vm.runInContext(leer("background.js"), ctx);
  const r = await new Promise((res) => oyente({ type: "pedirPermiso", origen: "https://x.ts.net/*" }, null, res));
  return { abierta: r.abierta, seAbrio: abierta };
}

(async () => {
  let r = await guardarDesdeElPanel("https://vault.ejemplo.ts.net/", false);
  assert.deepStrictEqual(
    [r.guardado.modo, r.guardado.remotoUrl, r.guardado.remotoToken],
    ["remoto", "https://vault.ejemplo.ts.net", "secreto"],
    "no guardo la direccion https"
  );
  assert.strictEqual(r.pedidos[0].origen, "https://vault.ejemplo.ts.net/*");
  assert.strictEqual(r.aviso, "Guardado");

  r = await guardarDesdeElPanel("https://vault.ejemplo.ts.net", true);
  assert.match(r.aviso, /falta dar permiso/, "el aviso del permiso se perdio");

  r = await guardarDesdeElPanel("http://localhost:8710", false);
  assert.strictEqual(r.guardado.modo, "local");
  assert.strictEqual(r.pedidos.length, 0, "pidio permiso para este PC");

  assert.deepStrictEqual(Object.values(await pedirPermiso(true)), [false, false], "abrio la ventana con el permiso ya dado");
  assert.deepStrictEqual(Object.values(await pedirPermiso(false)), [true, true]);
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
