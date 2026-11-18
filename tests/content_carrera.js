// Cambiar de VOD mientras se espera al servidor no debe enganchar el audio del
// VOD anterior en la pagina nueva, y el nuevo debe pedirse en el acto.
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
const pedidos = []; // VODs por los que se ha preguntado al servidor
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
  location: { href: "https://www.twitch.tv/videos/111", pathname: "/videos/111" },
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
        if (msg.type === "match") {
          pedidos.push(msg.vod);
          responder = cb;
        } else cb({ ok: false });
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
  // Al cargarse, content.js ya ha entrado en el VOD 111 y espera al servidor.
  assert.deepStrictEqual(pedidos, ["111"]);
  // El usuario se va al 222 antes de que conteste.
  Object.assign(ctx.location, { href: "https://www.twitch.tv/videos/222", pathname: "/videos/222" });
  vm.runInContext("onRouteChange()", ctx);
  responder({
    ok: true,
    base: "http://localhost:8710",
    data: { found: true, segments: [{ id: 1, inicio: 0, fin: null, audio_url: "/audio/1" }] },
  });
  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(vm.runInContext("track", ctx), null, "engancho el audio del VOD anterior");
  assert.strictEqual(vm.runInContext("audio", ctx), null, "creo un <audio> para el VOD anterior");
  assert.deepStrictEqual(pedidos, ["111", "222"], "el VOD nuevo no se pidio en el acto");
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
