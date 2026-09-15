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

const POR_DEFECTO = { serverUrl: "http://localhost:8710", token: "" };
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

  const cfg = await chrome.storage.sync.get(POR_DEFECTO);
  $("ext-server").value = cfg.serverUrl;
  $("ext-token").value = cfg.token;
  for (const id of ["ext-server", "ext-token", "btn-save-ext"]) {
    $(id).disabled = false;
  }
  $("ext-chip").textContent = "instalada";
  $("ext-chip").classList.add("ok");

  $("btn-save-ext").addEventListener("click", async () => {
    const serverUrl = $("ext-server").value.trim() || POR_DEFECTO.serverUrl;
    let url;
    try {
      url = new URL(serverUrl);
    } catch {
      aviso("Escribe la direccion entera, con http:// o https:// delante", true);
      return;
    }

    // Para un servidor remoto hace falta permiso sobre ESE dominio, y solo
    // sobre ese. Hay que pedirlo desde una pagina de la extension, asi que se
    // manda al service worker, que abre la de opciones.
    if (url.protocol === "https:") {
      const origen = `${url.origin}/*`;
      const tiene = await chrome.permissions.contains({ origins: [origen] });
      if (!tiene) {
        chrome.runtime.sendMessage({ type: "pedirPermiso", origen });
        aviso("Falta dar permiso para ese dominio: se abre la ventana", true);
      }
    }

    await chrome.storage.sync.set({ serverUrl, token: $("ext-token").value });
    aviso("Guardado");
  });
}

arrancar();
