// Un servidor que acepta la conexion y no contesta no debe dejar la peticion
// colgada para siempre.
//
//   node tests/background_test.js
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const dir = path.join(__dirname, "..", "extension");
const mudo = net.createServer(() => {}).listen(0, "127.0.0.1", () => {
  const puerto = mudo.address().port;
  let oyente = null;
  const ctx = vm.createContext({
    console, fetch, AbortSignal, setTimeout,
    importScripts: (f) => vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx),
    chrome: {
      runtime: { onMessage: { addListener: (f) => (oyente = f) } },
      storage: {
        sync: {
          get: async (d) => ({ ...d, modo: "remoto", remotoUrl: `http://127.0.0.1:${puerto}` }),
          set: async () => {},
        },
      },
    },
  });
  // La espera real es de 20 s; para la prueba basta con poca.
  const fuente = fs
    .readFileSync(path.join(dir, "background.js"), "utf8")
    .replace(/const ESPERA_SERVIDOR = \d+;/, "const ESPERA_SERVIDOR = 300;");
  vm.runInContext(fuente, ctx);

  const limite = setTimeout(() => {
    console.error("AssertionError: la peticion se quedo colgada");
    process.exit(1);
  }, 5000);
  oyente({ type: "match", vod: "1" }, null, (r) => {
    clearTimeout(limite);
    assert.deepStrictEqual([r.ok, r.error], [false, "El servidor no contesta"]);
    console.log("ok");
    mudo.close();
    process.exit(0);
  });
});
