/* Puente entre el panel web y los ajustes de la extension.
 *
 * El panel lo sirve el propio programa, asi que es una pagina normal y no
 * puede leer ni escribir `chrome.storage`. Este script si, porque se inyecta
 * como content script: rellena los campos de la seccion «Extension» de la
 * pestaña Ajustes y guarda lo que se escriba.
 *
 * Si la extension no esta instalada, esos campos se quedan desactivados con su
 * explicacion, que es justo lo que hay que ver en ese caso.
 */
"use strict";

const $ = (id) => document.getElementById(id);

/** Espera a que el panel haya pintado la seccion (la carga es asincrona). */
function cuandoExista(id, ms = 10000) {
  return new Promise((resolve) => {
    const ya = $(id);
    if (ya) return resolve(ya);
    const limite = Date.now() + ms;
    const reloj = setInterval(() => {
      const el = $(id);
      if (el || Date.now() > limite) {
        clearInterval(reloj);
        resolve(el);
      }
    }, 200);
  });
}

function aviso(texto, malo = false) {
  const msg = $("ext-msg");
  if (!msg) return;
  msg.textContent = texto;
  msg.className = malo ? "msg bad" : "msg good";
  setTimeout(() => {
    msg.textContent = "";
  }, 3000);
}

async function arrancar() {
  if (!(await cuandoExista("panel-extension"))) return;

  // Muestra el servidor que se esta usando ahora (local o remoto).
  const cfg = await servidorActivo();
  $("ext-server").value = cfg.serverUrl;
  $("ext-token").value = cfg.token;
  for (const id of ["ext-server", "ext-token", "btn-save-ext"]) {
    $(id).disabled = false;
  }
  $("ext-chip").textContent = "instalada";
  $("ext-chip").classList.add("ok");

  $("btn-save-ext").addEventListener("click", async () => {
    const serverUrl = $("ext-server").value.trim().replace(/\/+$/, "") || LOCAL_URL;
    let url;
    try {
      url = new URL(serverUrl);
    } catch {
      url = null;
    }
    // "localhost:8710" sin http:// tambien es una URL (protocolo "localhost:"):
    // se guardaba como remoto y la extension dejaba de encontrar el servidor.
    if (!url || !/^https?:$/.test(url.protocol)) {
      aviso("Escribe la direccion entera, con http:// o https:// delante", true);
      return;
    }

    // Para un servidor remoto hace falta permiso sobre ESE dominio, y solo
    // sobre ese. Hay que pedirlo desde una pagina de la extension, asi que se
    // manda al service worker, que abre la de opciones.
    // Lo mira el service worker: un content script no tiene chrome.permissions
    // (aqui revento siempre, y una direccion https no llegaba a guardarse).
    let falta = false;
    if (url.protocol === "https:") {
      const r = await new Promise((res) =>
        chrome.runtime.sendMessage({ type: "pedirPermiso", origen: `${url.origin}/*` }, res)
      );
      falta = Boolean(r && r.abierta);
    }

    // La de este PC no se guarda como remoto: solo se elige ese modo, y la
    // direccion del remoto se conserva para volver a ella con un clic.
    if (esLocal(serverUrl)) {
      await chrome.storage.sync.set({ modo: "local" });
    } else {
      await chrome.storage.sync.set({
        modo: "remoto", remotoUrl: serverUrl, remotoToken: $("ext-token").value,
      });
    }
    // Un solo aviso: antes el de "falta permiso" se pisaba al instante con este.
    if (falta) aviso("Guardado, pero falta dar permiso para ese dominio: se abre la ventana", true);
    else aviso("Guardado");
  });
}

arrancar();
