/* Pide permiso sobre el dominio del servidor remoto.
 *
 * `chrome.permissions.request` solo funciona desde una pagina de la extension
 * y con un clic del usuario detras, asi que no vale hacerlo ni desde el panel
 * (que es una web normal) ni desde el service worker.
 */
"use strict";

const $ = (id) => document.getElementById(id);

function decir(texto, clase = "") {
  $("estado").textContent = texto;
  $("estado").className = clase;
}

chrome.storage.local.get({ permisoPendiente: "" }).then(async ({ permisoPendiente }) => {
  if (!permisoPendiente) return;

  const dominio = permisoPendiente.replace(/\/\*$/, "");
  if (await chrome.permissions.contains({ origins: [permisoPendiente] })) {
    $("explica").textContent = `Ya tienes permiso para ${dominio}.`;
    return;
  }

  $("explica").textContent =
    `La extension necesita permiso para hablar con ${dominio}. Se pide solo ` +
    `para ese dominio, no para el resto de internet.`;
  $("dar").hidden = false;
  $("dar").addEventListener("click", async () => {
    const ok = await chrome.permissions.request({ origins: [permisoPendiente] });
    if (ok) {
      decir("Concedido. Ya puedes cerrar esta ventana.", "ok");
      $("dar").hidden = true;
      chrome.storage.local.remove("permisoPendiente");
    } else {
      decir("Denegado: sin ese permiso la extension no puede consultarlo.", "bad");
    }
  });
});
