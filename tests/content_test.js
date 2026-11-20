// Pruebas de content.js:
// - Cambiar de VOD mientras se espera al servidor no debe enganchar el audio
//   del VOD anterior en la pagina nueva, y el nuevo debe pedirse en el acto.
// - Saltar de un canal en directo a un VOD no espera a que se agote la medida
//   de la duracion del reproductor.
// - Si dos trozos de grabacion se solapan, manda el que empieza despues.
//
//   node tests/content_test.js
//
// content.js espera un navegador; aqui se carga en un contexto con lo minimo
// de `chrome`, `document` y compania para poder llamar a sus funciones.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const fuente = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");
const nada = () => {};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Elemento multimedia de mentira: lo justo para que una carga, si no se frena,
// llegue hasta el final y enganche.
const medio = (duration = NaN) => ({
  oyentes: [],
  addEventListener(n, f) { this.oyentes.push([n, f]); },
  removeEventListener(n, f) { this.oyentes = this.oyentes.filter(([a, b]) => a !== n || b !== f); },
  disparar(n) { this.oyentes.filter(([a]) => a === n).forEach(([, f]) => f()); },
  removeAttribute: nada,
  pause: nada, load: nada, remove: nada, play: () => Promise.resolve(),
  getBoundingClientRect: () => ({ width: 1, height: 1 }),
  style: {}, paused: true, muted: false, volume: 1, currentTime: 0,
  duration, playbackRate: 1, readyState: 0, isConnected: true,
});

/** Carga content.js en `ruta`. `video` es el reproductor que ve la pagina. */
function cargar(ruta, { video = medio(), canal = { videos: [] } } = {}) {
  const pedidos = []; // peticiones "match" al servidor: VOD pedido
  const pendientes = []; // sus respuestas, sin contestar
  const oyente = {}; // quien atiende los mensajes del popup
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval: nada, performance,
    location: { href: "https://www.twitch.tv" + ruta, pathname: ruta },
    navigator: {},
    window: { addEventListener: nada },
    document: {
      hidden: false,
      addEventListener: nada,
      querySelectorAll: () => [video],
      createElement: () => medio(),
      body: { appendChild: nada },
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (f) => (oyente.f = f) },
        sendMessage: (msg, cb) => {
          if (msg.type === "match") {
            pedidos.push(msg.vod);
            pendientes.push(cb);
          } else if (msg.type === "canal") {
            cb({ ok: true, data: canal });
          } else cb({ ok: false });
        },
      },
      storage: {
        onChanged: { addListener: nada },
        sync: { get: (_d, cb) => cb({ volumen: 1 }), set: nada },
      },
    },
  });
  vm.runInContext(fuente, ctx, { filename: "content.js" });
  const ir = (nueva) => {
    Object.assign(ctx.location, { href: "https://www.twitch.tv" + nueva, pathname: nueva });
    vm.runInContext("onRouteChange()", ctx);
  };
  return { ctx, pedidos, pendientes, oyente, ir, val: (expr) => vm.runInContext(expr, ctx) };
}

const encontrado = {
  ok: true,
  base: "http://localhost:8710",
  data: { found: true, segments: [{ id: 1, inicio: 0, fin: null, audio_url: "/audio/1" }] },
};

async function cambioDeVod() {
  // Al cargarse, content.js ya ha entrado en el VOD 111 y espera al servidor.
  const p = cargar("/videos/111");
  assert.deepStrictEqual(p.pedidos, ["111"]);
  // El usuario se va al 222 antes de que conteste.
  p.ir("/videos/222");
  p.pendientes[0](encontrado);
  await espera(50);

  assert.strictEqual(p.val("track"), null, "engancho el audio del VOD anterior");
  assert.strictEqual(p.val("audio"), null, "creo un <audio> para el VOD anterior");
  assert.deepStrictEqual(p.pedidos, ["111", "222"], "el VOD nuevo no se pidio en el acto");
}

async function deCanalEnDirectoAVod() {
  // Portada de un canal en directo: la duracion es infinita, asi que la medida
  // no la da nunca por buena y agotaria sus 15 s.
  const p = cargar("/canal", {
    video: medio(Infinity),
    canal: { videos: [{ vod: "999", duracion: 3600 }] },
  });
  await espera(100);
  p.ir("/videos/222");
  await espera(400);
  assert.deepStrictEqual(p.pedidos, ["222"], "el VOD espero a que acabara la medida del canal");
}

function solapeDeTrozos() {
  // Trozo 1 cerrado "a las 1060 s" (hora de cierre, pasada del audio real) y
  // trozo 2 que empieza en el 1000: en el solape tiene que sonar el 2.
  const p = cargar("/");
  p.val(`trozos = [{ id: 1, inicio: 0, fin: 1060 }, { id: 2, inicio: 1000, fin: null }]`);
  const cual = (t) => p.val(`(trozoPara(${t}) || {}).id`);
  assert.deepStrictEqual([cual(500), cual(1030), cual(5000)], [1, 2, 2], "solape: eligio el trozo viejo");
}

/** Un VOD sonando con la ventana 1000-1300 s del trozo ya cargada. */
function sonando() {
  const video = { ...medio(3600), paused: false, readyState: 4, currentTime: 1020 };
  const p = cargar("/", { video });
  const pausas = [];
  const audio = { ...medio(310), paused: false, readyState: 4, currentTime: 20, pause: () => pausas.push(1) };
  const esperas = [];
  Object.assign(p.ctx, { videoFalso: video, audioFalso: audio, setTimeout: (_f, ms) => (esperas.push(ms), 0) });
  p.val(`enabled = true; video = videoFalso; audio = audioFalso; track = { duration: 3600 };
    trozos = [{ id: 1, inicio: 0, fin: null, granularidad: 10, ventana: true }];
    trozoActual = trozos[0]; origen = -1000; inicioFichero = 0; recorte = 1000;
    ventanaFin = 300; baseOffset = 0; programarRelevo()`);
  return { p, video, audio, esperas, pausas };
}

function saltoDentroDeLaVentana() {
  // Cambio en el 290 del fichero: con la aguja en 20 el relevo se pide dentro
  // de 225 s. Tras saltar al 250 tiene que pedirse ya, o llega tarde.
  const { p, video, esperas } = sonando();
  assert.strictEqual(esperas.pop(), 225000);
  video.currentTime = 1250;
  p.val("trasSaltar()");
  assert.ok(esperas.length && esperas.pop() <= 2000, "el relevo siguio programado con la aguja de antes del salto");
}

function relevoTardio() {
  // La reserva espera aparcada en el corte 1290 (su segundo 0) y el relevo
  // entra 160 ms despues: tiene que seguir donde va el audio que suena (no el
  // video, 50 ms por detras), sin repetir nada.
  const { p, video, audio } = sonando();
  audio.currentTime = 290.16;
  video.currentTime = 1290.11;
  const reserva = {
    ...medio(300), readyState: 4, currentTime: 0,
    buffered: { length: 1, start: () => 0, end: () => 300 },
  };
  Object.assign(p.ctx, { reservaFalsa: reserva });
  p.val(`reserva = reservaFalsa; relevoListo = true; reservaBuscada = 0;
    reservaParams = { origen: -1290, inicioFichero: 0, recorte: 1290, ventanaFin: 300 }`);
  assert.strictEqual(p.val("hacerRelevo()"), true);
  assert.ok(Math.abs(reserva.currentTime - 0.16) < 0.001, `la reserva arranco en ${reserva.currentTime}, repitiendo lo ya oido`);
}

function audioAtrasado() {
  // 0,3 s por detras del video: se salta a su sitio, no se acelera al 2 %.
  const { p, video, audio } = sonando();
  p.val("vigilarElemento = () => true; sigueSiendoElVod = () => true");
  video.currentTime = 1020.3; // el audio sigue en su 20 (= 1020 del VOD)
  p.val("tick()");
  assert.ok(Math.abs(audio.currentTime - 20.3) < 0.001, `el audio siguio ${Math.round((20.3 - audio.currentTime) * 1000)} ms atras`);
  // Con la CPU ocupada vuelve a quedarse atras al momento: no se salta otra
  // vez en la vuelta siguiente (eso era el petardeo), se acelera.
  audio.currentTime = 20.3;
  video.currentTime = 1020.6;
  p.val("tick()");
  assert.strictEqual(audio.currentTime, 20.3, "volvio a saltar en la vuelta siguiente");
  assert.ok(audio.playbackRate > 1, "no acelero para alcanzar al video");
}

function vueltaConVideoAtrasado() {
  // Vuelta a la pestaña con el video 1 s detras del audio (Chrome lo frena
  // oculto): se coloca en el audio, no se deja un minuto descuadrado.
  const { p, video } = sonando();
  video.currentTime = 1019;
  p.val("audioMaster = true; devolverReloj('prueba')");
  assert.strictEqual(video.currentTime, 1020, "el video se quedo 1 s detras al volver");
}

function sinCambiosDeVelocidadEnElUmbral() {
  // Desfase que ronda los 60 ms: empieza a corregir y no suelta hasta bajar de
  // 20 ms, en vez de alternar x1/x1,02 en cada vuelta (el petardeo).
  const { p, video, audio } = sonando();
  p.val("vigilarElemento = () => true; sigueSiendoElVod = () => true");
  const rates = [];
  for (const atras of [0.07, 0.05, 0.07, 0.04, 0.015]) {
    video.currentTime = 1020 + atras;
    audio.currentTime = 20;
    p.val("tick()");
    rates.push(audio.playbackRate);
  }
  assert.deepStrictEqual(rates, [1.02, 1.02, 1.02, 1.02, 1], `cambio de velocidad en el umbral: ${rates}`);
}

function videoAtascado() {
  const { p, video, pausas } = sonando();
  p.val("vigilarElemento = () => true; sigueSiendoElVod = () => true");
  video.readyState = 2; // cargando, sin pausa
  p.val("tick()");
  assert.strictEqual(pausas.length, 1, "el audio siguio sonando con el video atascado");
}

function volumenDeTwitch() {
  // Con Web Audio manda el deslizador de Twitch (aqui al 20 %), no el del popup.
  const { p, video, audio } = sonando();
  p.val("webaudio = true");
  video.volume = 0.2;
  p.oyente.f({ type: "setVolume", value: 1 }, null, nada);
  assert.strictEqual(audio.volume, 0.2, "sono con el volumen del popup en vez del de Twitch");
}

async function falloEnLaPrimeraVentana() {
  // El servidor se cae con la primera ventana ya sonando: el VOD tiene que
  // recuperar su sonido, no quedarse callado.
  const video = { ...medio(3600), paused: false, readyState: 4, currentTime: 0 };
  const p = cargar("/videos/111", { video });
  p.pendientes[0](encontrado);
  await espera(50);
  const audio = p.val("audio");
  audio.disparar("loadedmetadata");
  assert.strictEqual(video.muted, true, "no se callo el VOD al cargar");
  audio.disparar("error");
  assert.strictEqual(video.muted, false, "el VOD se quedo callado tras el fallo");
}

(async () => {
  await falloEnLaPrimeraVentana();
  await cambioDeVod();
  await deCanalEnDirectoAVod();
  solapeDeTrozos();
  saltoDentroDeLaVentana();
  videoAtascado();
  sinCambiosDeVelocidadEnElUmbral();
  vueltaConVideoAtrasado();
  audioAtrasado();
  relevoTardio();
  volumenDeTwitch();
  console.log("ok");
  process.exit(0); // las esperas de mentira que queden no deben retener el proceso
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
