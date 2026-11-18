"use strict";

const $ = (id) => document.getElementById(id);

let tabId = null;

function humanBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Pregunta al service worker, que es quien puede hablar con el servidor. */
const alFondo = (msg) =>
  new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (r) => {
      void chrome.runtime.lastError;
      resolve(r || { ok: false, error: "sin respuesta" });
    })
  );

// El content script puede no estar (pestaña que no es de Twitch, o recien
// instalada la extension sin recargar).
const alaPestana = (msg) =>
  new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    chrome.tabs.sendMessage(tabId, msg, (r) => {
      void chrome.runtime.lastError;
      resolve(r || null);
    });
  });

// ------------------------------------------------------- estado del servidor

async function pintarModo() {
  const { modo } = await servidorActivo();
  $("modo-local").setAttribute("aria-pressed", String(modo === "local"));
  $("modo-remoto").setAttribute("aria-pressed", String(modo === "remoto"));
}

async function elegirModo(modo) {
  const { remotoUrl } = await leerAjustes();
  // Sin direccion del remoto no hay a donde cambiar: se pide en las opciones.
  if (modo === "remoto" && !remotoUrl) {
    chrome.runtime.openOptionsPage();
    return;
  }
  await chrome.storage.sync.set({ modo });
  await pintarModo();
  $("dot").className = "dot";
  $("state").textContent = "comprobando…";
  $("detail").textContent = "";
  comprobarServidor();
}

$("modo-local").addEventListener("click", () => elegirModo("local"));
$("modo-remoto").addEventListener("click", () => elegirModo("remoto"));

async function comprobarServidor() {
  const r = await alFondo({ type: "status" });
  if (r.ok) {
    const s = r.data;
    $("dot").className = "dot ok";
    // El popup mide 258 px: enumerar los canales lo desborda. Se resume y
    // los nombres van en el titulo emergente.
    const n = s.watching.length;
    $("state").textContent = !n
      ? "conectado"
      : n === 1
      ? `grabando: ${s.watching[0]}`
      : `grabando ${n} canales`;
    $("state").title = n > 1 ? s.watching.join(", ") : "";
    const { serverUrl } = await servidorActivo();
    $("detail").textContent = `${humanBytes(s.disk_used_bytes)} guardados · `;
    const a = document.createElement("a");
    a.href = serverUrl;
    a.target = "_blank";
    a.textContent = "abrir panel";
    $("detail").append(a);
  } else {
    const { modo } = await servidorActivo();
    $("dot").className = "dot bad";
    $("state").textContent = "sin conexion";
    $("detail").textContent = modo === "local"
      ? "El grabador de este PC no esta en marcha. Abrelo con Iniciar.vbs en la carpeta servidor."
      : (r.error || "No se puede contactar con el servidor.");
    if (modo === "remoto") {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = " Cambiar direccion";
      a.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
      $("detail").append(a);
    }
  }
}

// ------------------------------------------------------------ estado del VOD

async function refrescarVod() {
  const st = await alaPestana({ type: "state" });
  const label = $("vod-status");
  const controles = $("controls");

  if (!st) {
    label.textContent = "Abre un VOD de Twitch para usar esto";
    label.className = "";
    $("vod-tramo").textContent = "";
    controles.classList.add("disabled");
    return;
  }

  label.textContent = st.status.text;
  label.className = st.status.state || "";
  $("vod-tramo").textContent = st.status.detalle || "";
  controles.classList.toggle("disabled", !st.hasAudio);

  $("use-vault").checked = st.enabled;
  // Si el audio del video se pudo enrutar por Web Audio, los controles de
  // Twitch gobiernan el audio grabado y el deslizador propio sobra.
  $("vol-row").style.display = st.volumenDeTwitch ? "none" : "";
  $("vol-nota").style.display = st.volumenDeTwitch ? "block" : "none";
  if (document.activeElement !== $("vol")) {
    $("vol").value = st.volumen;
    $("vol-out").textContent = `${Math.round(st.volumen * 100)}%`;
  }
}

// -------------------------------------------------------------- interaccion

$("use-vault").addEventListener("change", async (e) => {
  await alaPestana({ type: "setEnabled", value: e.target.checked });
  refrescarVod();
});

$("vol").addEventListener("input", (e) => {
  $("vol-out").textContent = `${Math.round(e.target.value * 100)}%`;
  alaPestana({ type: "setVolume", value: Number(e.target.value) });
});

// ----------------------------------------------------------------- arranque

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  tabId = tabs.length ? tabs[0].id : null;
  refrescarVod();
  setInterval(refrescarVod, 1000);
});

pintarModo();
comprobarServidor();
