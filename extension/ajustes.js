/* Donde esta el servidor: en este equipo o en uno remoto.
 *
 * Se guardan los dos a la vez y `modo` dice cual se usa, para poder cambiar de
 * uno a otro sin volver a escribir la direccion ni el token del remoto.
 *
 * Lo cargan el service worker (importScripts), el popup, las opciones y el
 * puente del panel, asi que todos leen lo mismo.
 */
"use strict";

const LOCAL_URL = "http://localhost:8710";

const AJUSTES_POR_DEFECTO = {
  modo: "",
  remotoUrl: "",
  remotoToken: "",
  // Formato antiguo: una sola direccion. Solo se lee para migrarlo.
  serverUrl: "",
  token: "",
};

const esLocal = (url) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(String(url).trim());

/** Ajustes guardados, con el formato antiguo ya convertido. */
async function leerAjustes() {
  const a = await chrome.storage.sync.get(AJUSTES_POR_DEFECTO);
  if (!a.modo) {
    // Antes solo habia una direccion: si no era la local, era el remoto.
    if (a.serverUrl && !esLocal(a.serverUrl)) {
      a.modo = "remoto";
      a.remotoUrl = a.serverUrl;
      a.remotoToken = a.token;
    } else {
      a.modo = "local";
    }
    await chrome.storage.sync.set({ modo: a.modo, remotoUrl: a.remotoUrl, remotoToken: a.remotoToken });
  }
  return a;
}

/** El servidor que toca usar ahora: { modo, serverUrl, token }. */
async function servidorActivo() {
  const a = await leerAjustes();
  if (a.modo === "remoto" && a.remotoUrl) {
    return { modo: "remoto", serverUrl: a.remotoUrl, token: a.remotoToken };
  }
  // El servidor local escucha solo en 127.0.0.1 y no lleva contraseña.
  return { modo: "local", serverUrl: LOCAL_URL, token: "" };
}
