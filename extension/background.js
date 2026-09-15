/* Service worker: hace las llamadas al servidor.
 *
 * Los fetch lanzados desde un content script viajan con el origen de la
 * pagina (twitch.tv), asi que CORS los rechazaria. Desde aqui salen con el
 * origen de la extension, que si esta permitido.
 */
"use strict";

const POR_DEFECTO = { serverUrl: "http://localhost:8710", token: "" };

async function ajustes() {
  return chrome.storage.sync.get(POR_DEFECTO);
}

/** Quita la barra final para poder concatenar rutas sin duplicarla. */
const limpiar = (url) => String(url || "").trim().replace(/\/+$/, "");

async function call(path, options = {}) {
  const { serverUrl, token } = await ajustes();
  const headers = { ...(options.headers || {}) };
  if (token) headers["X-Auth-Token"] = token;

  const res = await fetch(limpiar(serverUrl) + path, { ...options, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Respuesta ilegible del servidor (${res.status})`);
  }
  if (res.status === 401) throw new Error("Contraseña del servidor incorrecta");
  if (!res.ok) throw new Error((data && data.detail) || `Error ${res.status}`);
  return data;
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  (async () => {
    try {
      if (msg.type === "match") {
        const { serverUrl } = await ajustes();
        const data = await call(`/api/match?vod=${encodeURIComponent(msg.vod)}`);
        respond({ ok: true, data, base: limpiar(serverUrl) });
      } else if (msg.type === "pedirPermiso") {
        // El permiso sobre un dominio solo lo puede pedir una pagina de la
        // extension, asi que se apunta cual hace falta y se abre la de
        // opciones, que es donde esta el boton.
        await chrome.storage.local.set({ permisoPendiente: msg.origen });
        chrome.runtime.openOptionsPage();
        respond({ ok: true });
      } else if (msg.type === "canal") {
        const data = await call(
          `/api/canal?login=${encodeURIComponent(msg.login)}`
        );
        respond({ ok: true, data });
      } else if (msg.type === "offset") {
        await call(`/api/recordings/${msg.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offset_override: msg.value }),
        });
        respond({ ok: true });
      } else if (msg.type === "dura") {
        // Duracion REAL del tramo que va a servir el servidor, leida de la
        // cabecera X-Dura-Real. Se pide 1 byte: la cabecera viaja en la
        // respuesta, asi que no hace falta descargar el audio.
        //
        // Tiene que salir de aqui y no del content script: la respuesta lleva
        // Access-Control-Expose-Headers pero NO Access-Control-Allow-Origin,
        // asi que un fetch con el origen de twitch.tv no podria leerla.
        const { token } = await ajustes();
        const cab = { Range: "bytes=0-0" };
        if (token) cab["X-Auth-Token"] = token;
        const r = await fetch(msg.url, { headers: cab });
        const cruda = r.headers.get("X-Dura-Real");
        // La cabecera ya esta. El cuerpo no se usa, y si no se cancela sigue
        // bajando por detras: si el servidor no respeta el Range en algun
        // camino, eso es el tramo ENTERO (~7,8 MB) descargado por segunda vez,
        // peleando por el ancho de banda con el audio que si corre prisa.
        try {
          await r.body?.cancel();
        } catch {
          /* ya cerrado */
        }
        const d = cruda === null ? null : Number(cruda);
        respond({ ok: true, dura: Number.isFinite(d) && d > 0 ? d : null });
      } else if (msg.type === "status") {
        respond({ ok: true, data: await call("/api/status") });
      } else {
        respond({ ok: false, error: "peticion desconocida" });
      }
    } catch (e) {
      respond({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // la respuesta llega de forma asincrona
});
