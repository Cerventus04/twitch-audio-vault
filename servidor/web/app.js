/* Twitch Audio Vault — panel de control.
 *
 * La reproduccion la hace la extension sobre el propio Twitch; aqui solo se
 * gestionan los canales vigilados, las grabaciones y los ajustes.
 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const ICON = {
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 5v14M15 5v14"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v11l-4 4h-3l-3 3H8v-3H4z"/></svg>',
};

// -------------------------------------------------------------- utilidades

// Contraseña del servidor (solo en despliegue remoto). Se guarda en el
// navegador para no tener que escribirla en cada visita.
const CLAVE = "tav-token";
let token = localStorage.getItem(CLAVE) || "";

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers["X-Auth-Token"] = token;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    // La contraseña ya no vale: se pide otra vez.
    localStorage.removeItem(CLAVE);
    token = "";
    mostrarAcceso();
    throw new Error("Sesion caducada");
  }
  const text = await res.text();
  // Un error del servidor puede llegar en texto plano; no se asume JSON.
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) throw new Error(text.slice(0, 200) || `Error ${res.status}`);
    throw new Error("El servidor devolvio una respuesta ilegible");
  }
  if (!res.ok) throw new Error((data && data.detail) || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, bad = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("bad", bad);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3400);
}

function humanBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function humanDuration(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${String(m).padStart(2, "0")} min`;
  return m ? `${m} min` : `${s} s`;
}

function humanDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hora = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `hoy, ${hora}`;
  return `${d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" })}, ${hora}`;
}

/** "hace 5 min", "hace 3 dias"… mas facil de situar que una fecha absoluta. */
function haceCuanto(iso) {
  if (!iso) return "";
  const segundos = (Date.now() - new Date(iso).getTime()) / 1000;
  if (segundos < 90) return "hace un momento";
  const escala = [
    [60, "minuto", "minutos"],
    [3600, "hora", "horas"],
    [86400, "dia", "dias"],
  ];
  let unidad = escala[0];
  for (const e of escala) if (segundos >= e[0]) unidad = e;
  const n = Math.floor(segundos / unidad[0]);
  return `hace ${n} ${n === 1 ? unidad[1] : unidad[2]}`;
}

/** Como haceCuanto pero abreviado, para sitios estrechos: "hace 9 h". */
function haceCuantoCorto(iso) {
  if (!iso) return "";
  const segundos = (Date.now() - new Date(iso).getTime()) / 1000;
  if (segundos < 90) return "ahora mismo";
  const escala = [
    [60, "min"],
    [3600, "h"],
    [86400, "d"],
  ];
  let unidad = escala[0];
  for (const e of escala) if (segundos >= e[0]) unidad = e;
  return `hace ${Math.floor(segundos / unidad[0])} ${unidad[1]}`;
}

// ------------------------------------------------------------ confirmacion

/** Sustituto de confirm(): mismo uso (await) pero con el estilo de la app. */
function confirmar(titulo, texto, textoBoton = "Confirmar") {
  const fondo = $("#modal");
  $("#modal-title").textContent = titulo;
  $("#modal-text").textContent = texto;
  $("#modal-ok").textContent = textoBoton;
  fondo.classList.add("open");
  $("#modal-ok").focus();

  return new Promise((resolve) => {
    const cerrar = (valor) => {
      fondo.classList.remove("open");
      $("#modal-ok").removeEventListener("click", si);
      $("#modal-cancel").removeEventListener("click", no);
      fondo.removeEventListener("click", fuera);
      document.removeEventListener("keydown", tecla);
      resolve(valor);
    };
    const si = () => cerrar(true);
    const no = () => cerrar(false);
    const fuera = (e) => e.target === fondo && cerrar(false);
    const tecla = (e) => {
      if (e.key === "Escape") cerrar(false);
      if (e.key === "Enter") cerrar(true);
    };
    $("#modal-ok").addEventListener("click", si);
    $("#modal-cancel").addEventListener("click", no);
    fondo.addEventListener("click", fuera);
    document.addEventListener("keydown", tecla);
  });
}

const skeletons = (n) => Array.from({ length: n }, () => '<div class="skeleton"></div>').join("");

const escape = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function emptyState(title, text) {
  return `<div class="empty">${ICON.empty}<h4>${title}</h4><p>${text}</p></div>`;
}

// ---------------------------------------------------------------- pestañas

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  $$(".view").forEach((v) =>
    v.classList.toggle("active", v.id === `view-${tab.dataset.view}`)
  );
  // En Ajustes el resumen no pinta nada: solo resta espacio.
  $("#stats").classList.toggle("hidden", tab.dataset.view === "settings");
  if (tab.dataset.view === "channels") loadChannels();
  if (tab.dataset.view === "library") loadRecordings();
  if (tab.dataset.view === "settings") loadConfig();
});

// ------------------------------------------------------------------ estado

let lastStatus = null;

async function refreshStatus() {
  const pill = $("#status-pill");
  const text = $("#status-text");
  try {
    const s = await api("/api/status");
    lastStatus = s;
    pill.className = "status";
    pill.title = "";
    if (!s.credentials_set) {
      pill.classList.add("err");
      text.textContent = "faltan credenciales";
    } else if (s.watching.length) {
      pill.classList.add("rec");
      // Con varios canales, enumerarlos ensancha la barra y descentra las
      // pestañas. Se resume y los nombres van en el titulo emergente.
      const n = s.watching.length;
      text.textContent =
        n === 1 ? `grabando ${s.watching[0]}` : `grabando ${n} canales`;
      pill.title =
        (n > 1 ? s.watching.join(", ") + " · " : "") +
        `Ultima comprobacion ${haceCuanto(s.last_poll)}`;
    } else if (s.last_error) {
      pill.classList.add("err");
      text.textContent = "error de conexion";
      pill.title = s.last_error;
    } else {
      pill.classList.add("ok");
      text.textContent = "vigilando";
    }
    $("#stat-live").textContent = s.watching.length;
    $("#stats").querySelectorAll(".stat")[1].classList.toggle("hot", s.watching.length > 0);
    $("#stat-disk").textContent = humanBytes(s.disk_used_bytes);

    // Con la pestaña de fondo, el titulo avisa de que hay algo grabandose.
    document.title = s.watching.length
      ? `● Grabando — Audio Vault`
      : "Twitch Audio Vault";
  } catch {
    pill.className = "status err";
    text.textContent = "sin servidor";
    document.title = "Twitch Audio Vault";
  }
}

// ----------------------------------------------------------------- canales

let channelsCache = [];
// Huella del ultimo HTML pintado. Si los datos no han cambiado no se toca el
// DOM: recrear los <img> hace que los avatares parpadeen en cada refresco.
let ultimoCanales = "";
let ultimoGrabaciones = "";

async function loadChannels() {
  const box = $("#channel-list");
  if (!channelsCache.length) {
    box.innerHTML = skeletons(2);
    ultimoCanales = "";
  }
  try {
    channelsCache = await api("/api/channels");
  } catch (e) {
    box.innerHTML = "";
    return toast(e.message, true);
  }
  $("#stat-channels").textContent = channelsCache.length;

  // Ultima grabacion de cada canal, para saber si de verdad esta capturando.
  const ultima = {};
  for (const r of recordingsCache) {
    if (!ultima[r.login] || r.capture_start > ultima[r.login]) {
      ultima[r.login] = r.capture_start;
    }
  }

  if (!channelsCache.length) {
    box.innerHTML = emptyState(
      "Todavia no vigilas ningun canal",
      "Escribe arriba el nombre de un canal. Mientras Audio Vault este abierto, " +
        "grabara su audio en cuanto empiece a emitir."
    );
    return;
  }

  const html = channelsCache
    .map(
      (c) => `
    <div class="card ${c.recording ? "live" : ""} ${c.enabled ? "" : "paused"}">
      <img class="avatar" src="${escape(c.avatar_url || "")}" alt="">
      <div class="info">
        <div class="name">${escape(c.display_name || c.login)}</div>
        <div class="meta">${
          c.recording
            ? '<span class="live-tag"><i></i>grabando</span>'
            : !c.enabled
            ? "<span>pausado</span>"
            : ultima[c.login]
            ? `<span title="Ultima grabacion ${haceCuanto(ultima[c.login])}">` +
              `grabado ${haceCuantoCorto(ultima[c.login])}</span>`
            : "<span>en espera</span>"
        }</div>
      </div>
      <div class="actions">
        <button class="icon-btn" data-toggle="${escape(c.login)}" data-enabled="${c.enabled}"
                title="${c.enabled ? "Pausar la vigilancia" : "Reanudar la vigilancia"}">
          ${c.enabled ? ICON.pause : ICON.play}
        </button>
        <button class="icon-btn warn" data-remove="${escape(c.login)}" title="Dejar de vigilar">
          ${ICON.trash}
        </button>
      </div>
    </div>`
    )
    .join("");
  if (html !== ultimoCanales) {
    box.innerHTML = html;
    ultimoCanales = html;
  }
}

$("#channel-list").addEventListener("click", async (e) => {
  const toggle = e.target.closest("[data-toggle]");
  const remove = e.target.closest("[data-remove]");
  try {
    if (toggle) {
      await api(`/api/channels/${toggle.dataset.toggle}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: toggle.dataset.enabled !== "1" }),
      });
    } else if (remove) {
      const login = remove.dataset.remove;
      const grabando = lastStatus && lastStatus.watching.includes(login);
      const ok = await confirmar(
        `¿Dejar de vigilar ${login}?`,
        grabando
          ? "Ahora mismo se esta grabando su directo: la captura se cortara. " +
            "El audio ya guardado se conserva."
          : "Las grabaciones que ya tengas de este canal se conservan.",
        "Dejar de vigilar"
      );
      if (!ok) return;
      await api(`/api/channels/${login}`, { method: "DELETE" });
    } else return;
    loadChannels();
    refreshStatus();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#channel-input");
  const login = input.value.trim();
  if (!login) return;
  try {
    const r = await api("/api/channels", {
      method: "POST",
      body: JSON.stringify({ login }),
    });
    input.value = "";
    toast(`Vigilando ${r.login}`);
    loadChannels();
  } catch (err) {
    toast(err.message, true);
  }
});

// -------------------------------------------------------------- biblioteca

let recordingsCache = [];
let filtroCanal = ""; // "" = todos

// ---- desplegable propio (ver el <select> nativo no se puede estilar) ----

const dd = {
  abierto: false,
  abrir(v) {
    this.abierto = v;
    $("#filter-canal").classList.toggle("open", v);
    $("#dd-btn").setAttribute("aria-expanded", String(v));
  },
  pintar(opciones) {
    $("#dd-menu").innerHTML = opciones
      .map(
        (o) =>
          `<li role="option" data-valor="${escape(o.valor)}"` +
          ` aria-selected="${o.valor === filtroCanal}">${escape(o.texto)}</li>`
      )
      .join("");
    const sel = opciones.find((o) => o.valor === filtroCanal) || opciones[0];
    $("#dd-label").textContent = sel ? sel.texto : "Todos los canales";
  },
};

$("#dd-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  dd.abrir(!dd.abierto);
});

$("#dd-menu").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  filtroCanal = li.dataset.valor;
  dd.abrir(false);
  loadRecordings();
});

// Cerrar al pulsar fuera o con Escape, como cualquier menu.
document.addEventListener("click", () => dd.abierto && dd.abrir(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && dd.abierto) dd.abrir(false);
});

async function loadRecordings() {
  if (!recordingsCache.length) {
    $("#recording-list").innerHTML = skeletons(3);
    ultimoGrabaciones = "";
  }
  try {
    recordingsCache = await api("/api/recordings");
  } catch (e) {
    $("#recording-list").innerHTML = "";
    return toast(e.message, true);
  }
  $("#stat-recordings").textContent = recordingsCache.length;

  const logins = [...new Set(recordingsCache.map((r) => r.login))].sort();
  if (!logins.includes(filtroCanal)) filtroCanal = "";
  dd.pintar([
    { valor: "", texto: "Todos los canales" },
    ...logins.map((l) => ({ valor: l, texto: l })),
  ]);
  // Con un solo canal el filtro no aporta nada.
  $("#filter-canal").style.display = logins.length > 1 ? "" : "none";

  renderRecordings();
}

/** Junta en una sola entrada los trozos de un mismo directo ya terminado.
 *
 * Un directo puede quedar partido en varios ficheros si el programa se cierra
 * o el PC se reinicia a mitad. Verlos sueltos en la biblioteca no aporta nada:
 * son el mismo directo, la extension ya los encadena sola al reproducir, y lo
 * util es saber cuanto se tiene de el en total.
 *
 * Mientras uno siga grabando NO se agrupan: ahi si importa distinguir lo que
 * ya esta cerrado de lo que se esta escribiendo ahora mismo.
 */
function agruparTrozos(lista) {
  const porVod = new Map();
  const sueltas = [];
  for (const r of lista) {
    if (!r.vod_id) {
      sueltas.push(r);
      continue;
    }
    if (!porVod.has(r.vod_id)) porVod.set(r.vod_id, []);
    porVod.get(r.vod_id).push(r);
  }

  const salida = [...sueltas];
  for (const trozos of porVod.values()) {
    if (trozos.length === 1 || trozos.some((t) => t.status === "recording")) {
      salida.push(...trozos);
      continue;
    }
    trozos.sort((a, b) => a.capture_start.localeCompare(b.capture_start));
    const suma = (campo) => trozos.reduce((n, t) => n + (t[campo] || 0), 0);
    salida.push({
      ...trozos[0],
      // El estado del conjunto es el del peor trozo: si a alguno le falta el
      // fichero o se corto, el directo no esta entero y hay que decirlo.
      status: trozos.some((t) => t.status === "error")
        ? "error"
        : trozos.some((t) => t.status === "interrumpida")
        ? "interrumpida"
        : "done",
      exists: trozos.every((t) => t.exists),
      duration_seconds: suma("duration_seconds"),
      bytes: suma("bytes"),
      trozos: trozos.map((t) => t.id),
    });
  }
  return salida.sort((a, b) => b.capture_start.localeCompare(a.capture_start));
}

function renderRecordings() {
  const box = $("#recording-list");
  const items = agruparTrozos(
    filtroCanal
      ? recordingsCache.filter((r) => r.login === filtroCanal)
      : recordingsCache
  );

  if (!items.length) {
    box.innerHTML = emptyState(
      "Aun no hay grabaciones",
      "Se crean solas cuando un canal vigilado empieza a emitir. " +
        "Cuando el directo acabe, se emparejan con su VOD."
    );
    return;
  }

  const html = items
    .map((r) => {
      let chip = '<span class="chip wait">esperando al VOD</span>';
      if (r.status === "recording") chip = '<span class="chip rec">grabando ahora</span>';
      else if (r.status === "interrumpida")
        chip =
          '<span class="chip wait" title="La captura se corto antes de que ' +
          'acabara el directo: por cerrar el programa, un reinicio o dejar de ' +
          'vigilar el canal">a medias</span>';

      else if (r.status === "error")
        chip = `<span class="chip bad" title="${escape(r.error || "")}">fallo</span>`;
      else if (!r.exists) chip = '<span class="chip bad">fichero borrado</span>';
      else if (r.vod_id) chip = '<span class="chip ok">listo</span>';

      // Un directo partido se enseña como una sola entrada, pero conviene
      // decir de cuantos ficheros se compone: entre trozo y trozo hay un
      // hueco real, el rato que la captura estuvo caida.
      const trozos = r.trozos
        ? `<span class="chip" title="El directo quedo partido en ${r.trozos.length} ` +
          `ficheros. Se reproducen encadenados; entre uno y otro falta el rato ` +
          `que la captura estuvo caida.">${r.trozos.length} trozos</span>`
        : "";

      const vodLink = r.vod_id
        ? `<a href="https://www.twitch.tv/videos/${escape(r.vod_id)}" target="_blank"
              rel="noreferrer" class="chip" title="Abrir el VOD en Twitch">ver VOD</a>`
        : "";

      return `
      <div class="row">
        <img class="avatar" src="${escape(r.avatar_url || "")}" alt="">
        <div class="info">
          <div class="title">${escape(r.title || "(sin titulo)")}</div>
          <div class="meta">${escape(r.display_name || r.login)} · ${humanDate(r.capture_start)}
            · ${humanDuration(r.duration_seconds)} · ${humanBytes(r.bytes)}</div>
        </div>
        <div class="actions">
          ${trozos}${chip}${vodLink}
          <button class="icon-btn warn" data-del="${r.trozos ? r.trozos.join(",") : r.id}"
                  title="Borrar la grabacion">
            ${ICON.trash}
          </button>
        </div>
      </div>`;
    })
    .join("");
  if (html !== ultimoGrabaciones) {
    box.innerHTML = html;
    ultimoGrabaciones = html;
  }
}

$("#recording-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (!del) return;
  // Una entrada agrupada son varios ficheros: el boton lleva todos sus ids.
  const ids = del.dataset.del.split(",");
  const afectadas = recordingsCache.filter((r) => ids.includes(String(r.id)));
  const grabando = afectadas.some((r) => r.status === "recording");

  const ok = await confirmar(
    ids.length > 1 ? `¿Borrar este directo entero?` : "¿Borrar esta grabacion?",
    (grabando ? "Se esta grabando ahora mismo: primero se cortara la captura. " : "") +
      (ids.length > 1
        ? `Son ${ids.length} ficheros, los trozos en que quedo partido el ` +
          "directo. Se borran todos del disco y no se pueden recuperar."
        : "El fichero de audio se borra del disco y no se puede recuperar."),
    "Borrar"
  );
  if (!ok) return;
  try {
    // De uno en uno y en orden: si alguno falla, se dice cual y los demas se
    // quedan como estaban en vez de dejarlo a medias en silencio.
    for (const id of ids) {
      await api(`/api/recordings/${id}`, { method: "DELETE" });
    }
    loadRecordings();
    refreshStatus();
  } catch (err) {
    toast(err.message, true);
    loadRecordings();
  }
});

// ----------------------------------------------------------------- ajustes

async function loadConfig() {
  try {
    const c = await api("/api/config");
    $("#cfg-client-id").value = c.client_id;
    $("#cfg-client-secret").value = c.client_secret;
    $("#cfg-audio-dir").value = c.audio_dir;
    $("#cfg-poll").value = c.poll_seconds;
    $("#cfg-retention").value = c.retention_days;

    const chip = $("#cred-chip");
    const ok = lastStatus && lastStatus.credentials_set;
    chip.textContent = ok ? "configuradas" : "sin configurar";
    chip.className = `chip ${ok ? "ok" : "wait"}`;
  } catch (e) {
    toast(e.message, true);
  }
}

$("#btn-save-config").addEventListener("click", async () => {
  const msg = $("#config-msg");
  msg.textContent = "Guardando…";
  msg.className = "msg";
  try {
    const r = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        client_id: $("#cfg-client-id").value.trim(),
        client_secret: $("#cfg-client-secret").value.trim(),
        audio_dir: $("#cfg-audio-dir").value.trim(),
        poll_seconds: Number($("#cfg-poll").value),
        retention_days: Number($("#cfg-retention").value),
      }),
    });
    if (r.credentials && r.credentials !== "ok") {
      msg.textContent = r.credentials;
      msg.className = "msg bad";
    } else {
      msg.textContent = "Guardado correctamente.";
      msg.className = "msg good";
      setTimeout(() => (msg.textContent = ""), 3000);
    }
    await refreshStatus();
    loadConfig();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "msg bad";
  }
});

$("#btn-quit").addEventListener("click", async () => {
  const n = lastStatus ? lastStatus.watching.length : 0;
  const ok = await confirmar(
    "¿Cerrar Audio Vault?",
    n
      ? `Hay ${n} grabacion${n > 1 ? "es" : ""} en curso. Se cerrara${
          n > 1 ? "n" : ""
        } correctamente antes de salir, pero dejaras de capturar el resto del directo.`
      : "Dejara de vigilar y no se grabara ningun directo hasta que lo abras otra vez.",
    "Cerrar"
  );
  if (!ok) return;
  try {
    await api("/api/quit", { method: "POST" });
  } catch {
    /* el proceso muere antes de contestar: es lo esperado */
  }
  document.body.innerHTML = `
    <main style="max-width:520px;margin-top:80px">
      ${emptyState(
        "Audio Vault cerrado",
        "Ya puedes cerrar esta pestaña. Para volver a arrancarlo, usa Iniciar.vbs."
      )}
    </main>`;
});

// ------------------------------------------------------------------ acceso

const mostrarAcceso = () => $("#gate").classList.add("open");

$("#gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#gate-msg");
  const valor = $("#gate-pass").value;
  msg.textContent = "";
  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: valor }),
    });
    if (!res.ok) throw new Error("Contraseña incorrecta");
    token = valor;
    localStorage.setItem(CLAVE, token);
    $("#gate").classList.remove("open");
    arrancar();
  } catch (err) {
    msg.textContent = err.message;
    $("#gate-pass").select();
  }
});

// ---------------------------------------------------------------- arranque

// Las grabaciones primero: las tarjetas de canal las usan para decir cuando
// fue la ultima captura de cada uno.
async function arrancar() {
  await refreshStatus();
  await loadRecordings();
  await loadChannels();
}

(async () => {
  let requiere = false;
  try {
    requiere = (await (await fetch("/api/auth")).json()).required;
  } catch {
    /* sin servidor: refreshStatus ya lo reflejara */
  }
  if (requiere && !token) return mostrarAcceso();
  arrancar();
})();

setInterval(async () => {
  await refreshStatus();
  if ($("#view-channels").classList.contains("active")) loadChannels();
  if ($("#view-library").classList.contains("active")) loadRecordings();
}, 10000);
