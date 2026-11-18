/* Opciones: la direccion del servidor remoto y el permiso sobre su dominio.
 *
 * `chrome.permissions.request` solo funciona desde una pagina de la extension
 * y con un clic del usuario detras, asi que no vale hacerlo ni desde el panel
 * (que es una web normal) ni desde el service worker.
 */
"use strict";

const $ = (id) => document.getElementById(id);

function decir(id, texto, clase = "") {
  $(id).textContent = texto;
  $(id).className = "estado " + clase;
}

// ------------------------------------------------------------ servidor remoto

leerAjustes().then((a) => {
  $("url").value = a.remotoUrl;
  $("token").value = a.remotoToken;
});

$("guardar").addEventListener("click", async () => {
  const texto = $("url").value.trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(texto);
  } catch {
    decir("estado-remoto", "Escribe la direccion entera, con http:// o https:// delante", "bad");
    return;
  }
  if (esLocal(texto)) {
    decir("estado-remoto", "Esa es la de este PC: para usarla elige «Este PC» en el popup", "bad");
    return;
  }

  // Hace falta permiso sobre ESE dominio, y solo sobre ese. Este clic es el
  // gesto del usuario que Chrome exige para poder pedirlo.
  const origen = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [origen] }))) {
    const ok = await chrome.permissions.request({ origins: [origen] });
    if (!ok) {
      decir("estado-remoto", "Sin permiso para ese dominio la extension no puede hablar con el", "bad");
      return;
    }
  }

  await chrome.storage.sync.set({ remotoUrl: texto, remotoToken: $("token").value, modo: "remoto" });
  decir("estado-remoto", "Guardado. Ahora se usa el servidor remoto.", "ok");
});

// ---------------------------------------- permiso pedido desde el panel web

chrome.storage.local.get({ permisoPendiente: "" }).then(async ({ permisoPendiente }) => {
  if (!permisoPendiente) return;
  if (await chrome.permissions.contains({ origins: [permisoPendiente] })) return;

  const dominio = permisoPendiente.replace(/\/\*$/, "");
  $("permiso").hidden = false;
  $("explica").textContent =
    `La extension necesita permiso para hablar con ${dominio}. Se pide solo ` +
    `para ese dominio, no para el resto de internet.`;
  $("dar").addEventListener("click", async () => {
    const ok = await chrome.permissions.request({ origins: [permisoPendiente] });
    if (ok) {
      decir("estado", "Concedido. Ya puedes cerrar esta ventana.", "ok");
      $("dar").hidden = true;
      chrome.storage.local.remove("permisoPendiente");
    } else {
      decir("estado", "Denegado: sin ese permiso la extension no puede consultarlo.", "bad");
    }
  });
});
