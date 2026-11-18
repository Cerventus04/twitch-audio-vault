// Cambiar de VOD mientras se espera al servidor no debe enganchar el audio del
// VOD anterior en la pagina nueva.
//
//   node tests/content_carrera.js
//
// content.js espera un navegador; aqui se carga en un contexto con lo minimo
// de `chrome`, `document` y compania para poder llamar a sus funciones.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

let responder = null; // respuesta pendiente de la peticion "match"
const nada = () => {};
// Elemento multimedia de mentira: lo justo para que la carga vieja, si no se
// frena, llegue hasta el final y enganche.
const medio = () => ({
  addEventListener: nada, removeEventListener: nada, removeAttribute: nada,
  pause: nada, load: nada, remove: nada, play: () => Promise.resolve(),
  getBoundingClientRect: () => ({ width: 1, height: 1 }),
  style: {}, paused: true, muted: false, volume: 1, currentTime: 0,
  duration: NaN, playbackRate: 1, readyState: 0, isConnected: true,
});
const video = medio();
const ctx = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  setInterval: nada,
  performance,
  location: { href: "https://www.twitch.tv/", pathname: "/" },
  navigator: {},
  window: { addEventListener: nada },
  document: {
    hidden: false,
    addEventListener: nada,
    querySelectorAll: () => [video],
    createElement: medio,
    body: { appendChild: nada },
  },
  chrome: {
    runtime: {
      onMessage: { addListener: nada },
      sendMessage: (msg, cb) => {
        if (msg.type === "match") responder = cb;
        else cb({ ok: false });
      },
    },
    storage: {
      onChanged: { addListener: nada },
      sync: { get: (_d, cb) => cb({ volumen: 1 }), set: nada },
    },
  },
});

const fuente = path.join(__dirname, "..", "extension", "content.js");
vm.runInContext(fs.readFileSync(fuente, "utf8"), ctx, { filename: "content.js" });

(async () => {
  const carga = vm.runInContext('enterVod("111")', ctx);
  // El usuario se va a otro VOD antes de que conteste el servidor.
  vm.runInContext("teardown()", ctx);
  responder({
    ok: true,
    base: "http://localhost:8710",
    data: { found: true, segments: [{ id: 1, inicio: 0, fin: null, audio_url: "/audio/1" }] },
  });
  await carga;

  assert.strictEqual(vm.runInContext("track", ctx), null, "engancho el audio del VOD anterior");
  assert.strictEqual(vm.runInContext("audio", ctx), null, "creo un <audio> para el VOD anterior");
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
