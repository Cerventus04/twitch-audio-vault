/* Twitch Audio Vault — content script
 *
 * Sobre un VOD de twitch.tv: pregunta al servidor local si hay audio grabado
 * de ese directo, silencia el <video> nativo y reproduce encima la grabacion,
 * siguiendo al video con sus propios eventos (play/pause/seek).
 *
 * No pinta nada en la pagina: el estado y los controles viven en el popup de
 * la extension, que se comunica con este script por mensajes.
 */
"use strict";

const DRIFT_SEEK = 0.5; // desfase a partir del cual se salta en seco
// Cuanto se tolera que el audio vaya POR DELANTE antes de rebobinarlo. Alto a
// proposito: rebobinar repite audio ya escuchado, asi que se prefiere frenarlo
// y que converja solo. Solo se salta si esta tan lejos que ya no converge.
const DRIFT_MAX_ADELANTO = 5;
const DRIFT_TRIM = 0.06; // desfase a partir del cual se corrige con velocidad
const TICK_MS = 250;
// Anticipacion del relevo. timeupdate/ended tambien lo comprueban; ningun
// margen garantiza continuidad si Chrome suspende el proceso o la descarga.
const MARGEN_RELEVO = 1;
// Con cuanta antelacion se prepara el relevo. Precargarlo nada mas conmutar lo
// dejaba aparcado casi 5 minutos, y Chrome le suelta el bufer a un elemento
// pausado y silenciado: al conmutar tenia que volver a bajar el tramo ENTERO
// (~7,9 MB por relevo, medido). Un tramo tarda ~1 s en bajar, asi que con esto
// sobra de sobra, incluyendo los reintentos si el trozo aun no existe.
const ANTICIPO_RELEVO = 45;
// El relevo NO baja la cola entera (en un VOD largo son cientos de MB y por red
// nunca llega a tiempo). Baja tramos acotados de DURA_RELEVO segundos y los
// ENCADENA: antes de que uno acabe ya tiene el siguiente aparcado en el punto
// del cambio y conmuta en caliente. Sin descargas gigantes ni microcortes.
const DURA_RELEVO = 300;
// Se pide pronto: el punto de cambio de la primera ventana puede quedar a solo
// unos segundos, y con un retardo largo el tramo no llegaba a tiempo. Un salto
// nuevo lo aborta igualmente (ver manual()), asi que esperar mucho no aporta.
const RETARDO_RELEVO = 2000;
// Un directo en curso se sigue grabando mientras se ve: el tramo siguiente
// puede no existir todavia y aparecer unos segundos despues.
const REINTENTOS_RELEVO = 6;
const ESPERA_REINTENTO = 2500;
// Tope de la ventana INICIAL del salto (lo que descargas antes de oir nada).
// Mas pequena = salto mas rapido, PERO tiene que dar pista suficiente para que
// el relevo llegue a tiempo, y ahi hay una trampa: el punto de cambio se
// redondea hacia abajo a multiplo de la granularidad (10 s), y la reproduccion
// no empieza al principio de la ventana sino donde estuvieras. Con 15 s el
// cambio caia en R+10 y la pista real podia ser de 1-2 s -> el relevo no
// llegaba y se recargaba (microcorte). Con 25 s el cambio cae en R+20, dejando
// entre 10 y 20 s de pista: de sobra para los ~3,7 s que tarda el relevo.
// El servidor manda su propio tamano de ventana; aqui se recorta a este.
const VENTANA_SALTO = 25;

let base = ""; // url del servidor local, la da el service worker
let currentVod = null;
let video = null;
let audio = null;
let track = null;
let trozos = [];      // tramos de audio que cubren este VOD, en orden
let trozoActual = null;
// Donde empieza a contar el reproductor dentro del fichero actual. Cero en
// AAC crudo; en MP4 fragmentado es la marca del primer fragmento, porque ahi
// el elemento usa la linea temporal absoluta del contenido.
let origen = 0;
// Segundo del trozo por el que empieza el recorte que se pidio al servidor.
let recorte = 0;
// Primer instante que existe dentro del fichero cargado, en la escala del
// elemento. No se puede deducir de `origen`: al recortar, el AAC devuelto
// empieza en cero mientras que el MP4 conserva su tiempo absoluto.
let inicioFichero = 0;
const minimo = () => inicioFichero;

// ---- DEPURACION TEMPORAL: vida del relevo ---------------------------------
// Interruptor de la depuracion. En false no se imprime nada; ponerlo en true
// devuelve todo el rastro del encadenado (programarRelevo, prepararRelevo,
// soltarReserva, ponerTrozo con su motivo, y por que rama sale
// convieneRecargar). Filtro util en la consola, en modo Regex:
//   /ponerTrozo|prepararRelevo|programarRelevo|soltarReserva|conviene/
const DEPURAR = false;
const dbg = (q) => {
  if (!DEPURAR) return;
  console.info("[TAV] " + q + " | " + JSON.stringify({
    aud: audio ? +audio.currentTime.toFixed(1) : null,
    ini: +inicioFichero.toFixed(1),
    rec: recorte,
    vFin: ventanaFin === null ? null : +ventanaFin.toFixed(1),
    dur: audio && Number.isFinite(audio.duration) ? +audio.duration.toFixed(1) : null,
    camb: cambioEn === null ? null : +cambioEn.toFixed(1),
    hayReserva: !!reserva,
    listo: relevoListo,
  }));
};
// ---------------------------------------------------------------------------


// Fin de lo cargado, cuando se pidio una ventana corta. Null si el
// fichero llega hasta el final de la grabacion.
let ventanaFin = null;
// Segundo elemento que se va cargando por detras para tomar el relevo cuando
// la ventana se agote. Espera PARADO justo en el limite, asi no hay solape.
let reserva = null;
let reservaParams = null; // escala del tramo en reserva, para adoptarla al conmutar
// Instante (en la escala del elemento que suena AHORA) en que hay que ceder el
// testigo al tramo en reserva. Se calcula al pedirlo; null si no hay relevo.
let cambioEn = null;
let relevoListo = false;
// Donde se mando a descargar a la reserva. Sirve para NO volver a apuntarla en
// cada vuelta: el destino avanza con el reloj, y resembrar la descarga cada
// cuarto de segundo impide que llegue a tener datos nunca (se queda en
// readyState 1 para siempre y el relevo no entra).
let reservaBuscada = null;
let temporizadorRelevo = null;
let cambiando = false; // evita que el bucle pise una carga en curso
let baseOffset = 0;
// Ajuste manual del desfase. Ya no hay interfaz para tocarlo: el calculo
// automatico se corrige solo (ver `_afinar_desfases` en el servidor). Se
// mantiene en las cuentas porque el servidor sigue admitiendo un
// `offset_override` por grabacion.
let nudge = 0;
let enabled = true;
let volumen = 1; // volumen propio, independiente del de Twitch
// Velocidad a la que el usuario ve el VOD (1x normalmente). El audio SIEMPRE la
// sigue; `video.playbackRate` es solo el mando fisico que ademas se usa para
// hacer que el video persiga al audio cuando la pestana esta oculta, asi que no
// puede tomarse como referencia de la velocidad elegida.
let tasaUsuario = 1;
let timer = null;

// El reloj oculto es el audio, no el video que Twitch puede ralentizar.
// Durante load() su escala deja de ser valida: conservar segundos de VOD.
let audioMaster = false;
// Instante en que la pestana volvio a ser visible. Sirve para no confundir la
// recolocacion que hace Twitch al volver con un salto del usuario.
let ultimaVuelta = 0;
// Margen tras volver en el que un salto hacia atras todavia es de Twitch y no
// del usuario (a un salto suyo aun no le ha dado tiempo).
const GRACIA_VUELTA = 3000;
// Cuanto puede haberse quedado atras el video en segundo plano. Mas alla de
// esto ya no es retraso acumulado: es un salto de verdad.
const ATRASO_MAX_FONDO = 180;
let anclaCarga = null;
let saltoInterno = null; // { el, target }; nunca confundirlo con un seek manual
let seekUsuario = false;
let trozoFallido = null;
let cancelarCarga = null;
let generacion = 0;
const posicionAudio = () => audio.currentTime - origen + baseOffset + nudge;
// El ancla congela la posicion MIENTRAS se pide una ventana nueva, para que no
// se mueva el suelo bajo los pies durante la carga. Solo vale, por tanto, si
// hay una carga en vuelo (`cambiando`).
//
// Antes bastaba con que estuviera puesta, y la ponia `manual()` en cada salto.
// Si el salto se resolvia en sitio, sin llegar a pedir ventana, nadie la
// borraba —quien lo hace es `alCargar`— y quedaba clavada: la posicion efectiva
// devolvia siempre ese instante viejo, y `devolverReloj` llevaba el video ahi
// una y otra vez. Se veia como saltos hacia atras al mismo segundo, siempre el
// mismo. Aparecia solo en las grabaciones recortadas porque, dentro de un tramo
// de relevo de 300 s, ninguna correccion cae fuera de la ventana y no hay
// recarga que la limpie de rebote.
const posicionEfectiva = () => audioMaster
  ? (anclaCarga === null || !cambiando ? posicionAudio() : anclaCarga)
  : video.currentTime;

function liderAudio(motivo) {
  if (audioMaster || !enabled || !audio || !trozoActual || seekUsuario) return;
  audioMaster = true;
  audio.playbackRate = tasaUsuario;
}

// Cuanto se tolera que el video vaya desacompasado antes de moverlo. Mover el
// video NO es gratis: obliga al reproductor de Twitch a vaciar su buffer y
// recolocarse, y ese tiron se percibe como un salto —incluso como si el
// directo retrocediera— aunque el ajuste sea de menos de un segundo.
//
// Medido: con la pestaña oculta el video pierde ~1 s cada 25 (Chrome lo
// estrangula) mientras el audio sigue clavado en tiempo real. Con el umbral
// anterior (una milesima) eso significaba un seek a Twitch CADA vez que
// volvias. Por debajo de este margen sale mas a cuenta dejarlo estar y que lo
// corrija el audio, que es mucho mas barato de recolocar.
const TOLERANCIA_VIDEO = 2;

function colocarVideo(t, motivo) {
  if (!video || !Number.isFinite(t)) return;
  const target = Math.max(0, Math.min(t, Number.isFinite(video.duration) ? video.duration : t));
  if (Math.abs(video.currentTime - target) < TOLERANCIA_VIDEO && !video.seeking) return;
  saltoInterno = { el: video, target };
  try { video.currentTime = target; }
  catch { saltoInterno = null; }
}

function devolverReloj(motivo) {
  if (!audioMaster || cambiando) return;
  if (video) video.playbackRate = tasaUsuario; // deshacer la persecucion
  // Congelar lo oido mientras Twitch busca: al terminar no queda audio nuevo
  // que obligue a otro salto, ni se rebobina al objetivo antiguo del video.
  const t = posicionEfectiva();
  // Con el video solo un poco retrasado no se toca nada: ni el video, porque
  // hacer buscar a Twitch se nota, ni el audio, porque recolocarlo hacia atras
  // es volver a oir lo ya oido. Se devuelve el mando y que converja solo.
  if (Math.abs(video.currentTime - t) < TOLERANCIA_VIDEO) {
    audioMaster = false;
    return;
  }
  // El audio NO se pausa: sigue sonando de maestro mientras el video se
  // recoloca por detras. Antes se congelaba hasta que el video terminaba de
  // buscar, y con mala conexion ese rebuffer es lento -> silencio. Asi el
  // sonido no se corta nunca; solo la imagen tarda un instante en alcanzarlo.
  colocarVideo(t, motivo);
  if (!saltoInterno) audioMaster = false;
}

function resetReloj(motivo, devolver = false) {
  if (devolver && audioMaster && video && audio) colocarVideo(posicionEfectiva(), motivo);
  audioMaster = false;
  anclaCarga = null;
  saltoInterno = null;
  seekUsuario = false;
}

function fallbackAudio(motivo) {
  const t = posicionEfectiva();
  const eraMaster = audioMaster;
  audio.pause();
  audioMaster = false;
  anclaCarga = null;
  if (eraMaster) colocarVideo(t, motivo);
  callarVideo(false);
}

function eventosAudio(el) {
  for (const nombre of ["timeupdate", "ended"]) {
    el.addEventListener(nombre, () => { if (el === audio) tick(); });
  }
  el.addEventListener("error", () => {
    if (el !== audio || !enabled || cambiando) return;
    trozoFallido = trozoActual;
    fallbackAudio("error-audio");
    setStatus("No se pudo cargar el audio del servidor", "off");
  });
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) ultimaVuelta = Date.now();
  if (enabled && audio && video && track) {
    if (document.hidden) liderAudio("oculto-audio-master");
    else devolverReloj("visible-video-hacia-audio");
    reclamarTeclasDeMedios();
  }
});

// Lo que se enseña en el popup.
let status = { text: "Esto no es un VOD", state: "" };

const setStatus = (text, state = "", detalle = "") => {
  status = { text, state, detalle };
};

/** Reloj h:mm:ss, para decir a que altura del VOD va cada trozo. */
function reloj(segundos) {
  const s = Math.max(0, Math.round(segundos));
  const dos = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${dos(Math.floor((s % 3600) / 60))}:${dos(s % 60)}`;
}

/** Tramo del VOD que cubre un trozo, tal como se ve en la barra de Twitch. */
function tramoDelTrozo(s) {
  if (!s) return "";
  const desde = reloj(s.inicio + nudge);
  if (s.fin === null || s.fin === undefined) return `desde ${desde}`;
  return `${desde} – ${reloj(s.fin + nudge)}`;
}

// Rastro de lo ultimo que se miro, para poder ver desde el popup por que no
// arranca sin tener que abrir las herramientas del navegador.
let diag = "";
const setDiag = (t) => {
  diag = t;
};

// Todo el trafico con el servidor pasa por el service worker (ver background.js).
const ask = (msg) =>
  new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (r) =>
      resolve(r || { ok: false, error: "sin respuesta de la extension" })
    )
  );

// ------------------------------------------------------------------ helpers

const vodIdFromUrl = () => {
  const m = location.pathname.match(/^\/videos\/(\d+)/);
  return m ? m[1] : null;
};

// Rutas de un solo tramo que no son canales. No hace falta que la lista sea
// exhaustiva: si se cuela alguna, el servidor no encuentra grabaciones suyas
// y no pasa nada.
const NO_SON_CANALES = new Set([
  "directory", "videos", "settings", "downloads", "store", "subs", "friends",
  "following", "u", "p", "popout", "team", "search", "drops", "turbo", "prime",
  "wallet", "inventory", "payments", "jobs", "legal", "privacy", "about",
]);

// Pestañas de un canal que dejan el reproductor sonando arriba: el ultimo
// directo sigue reproduciendose aunque cambies de pestaña.
const PESTANAS_DE_CANAL = new Set([
  "about", "clips", "videos", "schedule", "home", "collections", "events",
]);

/** Login del canal si estamos en su pagina (portada o cualquier pestaña). */
const loginDeCanal = () => {
  const partes = location.pathname.split("/").filter(Boolean);
  if (!partes.length || partes.length > 2) return null;
  const login = partes[0].toLowerCase();
  if (!/^[a-zA-Z0-9_]{3,25}$/.test(login)) return null;
  if (NO_SON_CANALES.has(login)) return null;
  if (partes.length === 2 && !PESTANAS_DE_CANAL.has(partes[1].toLowerCase())) {
    return null;
  }
  return login;
};

/** Duracion del reproductor, o null si lo que suena es un directo.
 *
 * Se mide dos veces: en un directo la duracion no para de crecer, mientras que
 * en un VOD es fija. Es la unica forma de distinguirlos que no depende de como
 * este montada la pagina, que Twitch cambia cuando quiere.
 */
async function duracionDelReproductor(el, esperaMs = 15000) {
  const limite = Date.now() + esperaMs;
  while (Date.now() < limite) {
    const d = el.duration;
    if (Number.isFinite(d) && d > 60) {
      // Un directo crece un segundo por segundo, asi que con 700 ms ya se
      // distingue de sobra de un VOD, que no crece nada.
      await new Promise((r) => setTimeout(r, 700));
      if (!el.isConnected) return null;
      return Math.abs(el.duration - d) < 0.2 ? d : null;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** El <video> del reproductor principal.
 *
 * Puede haber mas de uno: la portada de un canal y la lista de videos traen
 * vistas previas que tambien son elementos de video. Se prefiere el que cuelga
 * del reproductor, y si eso no basta, el mas grande en pantalla.
 */
function videoPrincipal() {
  const enReproductor = [
    ...document.querySelectorAll(
      '[data-a-target="video-player"] video, .video-player video'
    ),
  ];
  const candidatos = enReproductor.length
    ? enReproductor
    : [...document.querySelectorAll("video")];
  if (candidatos.length < 2) return candidatos[0] || null;
  // Siempre el mas grande en pantalla, no el primero del documento: al
  // navegar, Twitch puede dejar el reproductor anterior en el DOM pero oculto,
  // y ese seguiria saliendo antes en el orden del documento.
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  return candidatos.reduce((mejor, el) => (area(el) > area(mejor) ? el : mejor));
}

async function findVideoElement(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = videoPrincipal();
    if (el) return el;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function fmt(seconds) {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

// --------------------------------------------------- silenciado del video
//
// Silenciar con `video.muted` funciona, pero inutiliza los controles de audio
// de Twitch: el boton queda siempre en "silenciado" y el deslizador no sirve.
// Enrutando el audio del video por un nodo de ganancia a cero, el elemento no
// esta silenciado para Twitch, asi que sus controles siguen vivos y se pueden
// leer como intencion del usuario para aplicarsela al audio grabado.

let ctx = null;
let ganancia = null;
let webaudio = false;

// Un elemento solo admite UN MediaElementSourceNode en toda su vida: si se
// intenta crear otro, aunque sea en un contexto nuevo, el navegador lanza un
// error y nos quedariamos sin poder tocar su audio. Y Twitch reutiliza el
// mismo <video> al pasar de la portada del canal a un VOD. Por eso el enrutado
// se guarda por elemento y se reaprovecha en vez de rehacerlo.
const enrutados = new WeakMap();

function tomarAudioDelVideo() {
  if (!video) return false;

  const guardado = enrutados.get(video);
  if (guardado) {
    ctx = guardado.ctx;
    ganancia = guardado.ganancia;
    webaudio = true;
    return true;
  }

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    const fuente = ctx.createMediaElementSource(video);
    ganancia = ctx.createGain();
    ganancia.gain.value = 0;
    fuente.connect(ganancia);
    ganancia.connect(ctx.destination);
    webaudio = true;
    enrutados.set(video, { ctx, ganancia });
  } catch (e) {
    // Puede fallar si Twitch ya enruta el audio o el navegador lo impide.
    setDiag(`sin Web Audio: ${e && e.name ? e.name : e}`);
    webaudio = false;
    ctx = null;
    ganancia = null;
  }
  return webaudio;
}

/** true = que no se oiga el VOD; false = devolverle el sonido. */
function callarVideo(callar) {
  if (webaudio) {
    ganancia.gain.value = callar ? 0 : 1;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  } else {
    video.muted = callar;
  }
}

/** Volumen que toca, leido de los controles de Twitch cuando se puede. */
function volumenEfectivo() {
  if (!webaudio) return volumen; // manda el deslizador del popup
  return video.muted ? 0 : video.volume;
}

// ------------------------------------------------------------ sincronizacion

/** Trozo que cubre ese segundo del VOD, o null si cae en un hueco. */
function trozoPara(t) {
  for (const s of trozos) {
    const ini = s.inicio + nudge;
    // Si aun se esta grabando no se sabe donde acaba: se fia de la duracion
    // que reporte el propio fichero una vez cargado.
    const fin =
      s.fin !== null
        ? s.fin + nudge
        : ini +
          (trozoActual === s && audio && audio.duration && ventanaFin === null
            ? recorte + (audio.duration - inicioFichero)
            : 1e9);
    if (t >= ini && t < fin) return s;
  }
  return null;
}

/** Segundo del fichero, contando desde su principio, para un instante del VOD. */
const dentroDelTrozo = (s, t) => t - s.inicio - nudge;

/** True si conviene pedir el trozo recortado de nuevo en vez de mover la aguja.
 *
 * Solo en formatos sin indice propio (el MP4 fragmentado trae el suyo y salta
 * en 30 ms). Se recarga cuando el destino no esta en el bufer y ademas queda
 * lejos: para correcciones de un par de segundos sale mas caro recargar.
 */
// Margen en los bordes del fichero cargado. Justo despues de conmutar a un
// tramo nuevo la aguja queda casi en cero, y la posicion deseada se calcula
// desde el VIDEO, que va unas decimas por detras: `t` sale ligeramente
// NEGATIVO. Sin este margen eso se leia como "estamos fuera de la grabacion" y
// se recargaba la ventana entera —pausa y espera al servidor— en CADA
// conmutacion, es decir cada ~5 min. Por unas decimas no hace falta recargar:
// basta con recolocar la aguja en el borde.
const BORDE = 2;

function convieneRecargar(s, t) {
  if (!s.granularidad) { dbg("conviene NO: sin granularidad"); return false; }
  if (t < minimo() - BORDE) {
    dbg("conviene SI: t=" + t.toFixed(2) + " por debajo de min=" + minimo().toFixed(2));
    return true;
  }
  if (audio.duration && t > audio.duration + BORDE) {
    dbg("conviene SI: t=" + t.toFixed(2) + " pasa dur=" + audio.duration.toFixed(2));
    return true;
  }

  // Dentro de la ventana cargada el salto en sitio es barato: son
  // pocos megas y el navegador los tiene enteros.
  if (s.ventana && ventanaFin !== null && t >= minimo() && t <= ventanaFin) {
    return false;
  }
  dbg(
    "conviene FUERA-DE-VENTANA t=" + t.toFixed(2) +
      " ventana=" + s.ventana + " vFin=" + (ventanaFin === null ? "null" : ventanaFin.toFixed(2)) +
      " min=" + minimo().toFixed(2)
  );

  // Para todo lo demas, pedir el fichero ya colocado. Aqui NO se mira si el
  // destino esta descargado, aunque lo parezca sensato: lo que cuesta no es
  // bajar los bytes, es que el navegador los recorra para encontrar el sitio.
  // Con el fichero en local se descarga entero enseguida, asi que ese criterio
  // daba siempre "ya lo tengo" y mandaba todos los saltos al camino lento
  // (medido: 250-540 ms, frente a los ~90 ms de pedir una ventana nueva).
  const lejos = Math.abs(t - audio.currentTime) > s.granularidad;
  dbg("conviene " + (lejos ? "SI" : "NO") + ": |t-aguja|=" + Math.abs(t - audio.currentTime).toFixed(2));
  return lejos;
}

/** Carga un trozo posicionado en `t` (instante del VOD).
 *
 * En AAC crudo se le pide al servidor que lo recorte: el formato no tiene
 * indice y saltar dentro de un fichero de horas puede tardar minutos. Al
 * recibirlo recortado, el navegador ve un audio que empieza en cero justo
 * donde nos interesa.
 */
// Cada carga lleva numero: si el usuario vuelve a saltar antes de que la
// anterior termine, la vieja queda anulada y no puede recolocar el audio en el
// sitio que ya no toca.
let cargaId = 0;

function ponerTrozo(s, t, motivo) {
  dbg(
    "ponerTrozo POR=" + (motivo || "?") +
      " enVod=" + t.toFixed(1) +
      " quiere=" + (audio && video ? wanted().toFixed(2) : "?") +
      " min=" + minimo().toFixed(2) +
      " BORDE=" + BORDE
  );
  if (cancelarCarga) cancelarCarga();
  const mia = ++cargaId;
  const el = audio;
  anclaCarga = t;
  cambiando = true;
  audio.pause();
  // Un relevo del MISMO trozo sigue valiendo despues de recargar: cambia la
  // ventana que suena, no la grabacion. Tirarlo era lo que impedia converger:
  // cada recarga cancelaba una descarga casi terminada y volvia a empezar de
  // cero, y como la siguiente recarga llegaba antes que el relevo, el ciclo no
  // acababa nunca. Su instante de conmutacion si caduca (iba en la escala del
  // elemento viejo) y se recalcula al cargar.
  const conservar = reserva !== null && trozoActual === s;
  if (conservar) cambioEn = null;
  else soltarReserva();
  trozoActual = s;
  baseOffset = s.inicio;
  ventanaFin = null;

  let url = `${base}${s.audio_url}`;
  if (s.granularidad) {
    // Se redondea hacia abajo al mismo multiplo que usa el servidor, asi que
    // ambos lados saben exactamente en que segundo empieza el recorte.
    const corte = Math.max(
      0,
      Math.floor(dentroDelTrozo(s, t) / s.granularidad) * s.granularidad
    );
    url += (url.includes("?") ? "&" : "?") + `desde=${corte}`;
    recorte = corte;
    if (s.absoluto) {
      // MP4 fragmentado: cada fragmento lleva su tiempo absoluto, asi que el
      // recorte suena en la misma linea temporal que el fichero entero. Solo
      // cambia donde empieza.
      origen = s.origen || 0;
      inicioFichero = origen + corte;
    } else {
      // AAC crudo: el recorte es un corte de bytes y el fichero resultante
      // empieza en cero, asi que el desplazamiento es negativo.
      origen = -corte;
      inicioFichero = 0;
    }
    if (s.ventana) {
      // Se pide solo un rato (VENTANA_SALTO): asi el salto suena enseguida. El
      // resto (DURA_RELEVO) llega detras en el relevo.
      const w = Math.min(s.ventana, VENTANA_SALTO);
      url += `&dura=${w}`;
      ventanaFin = inicioFichero + w;
    }
  } else {
    origen = s.origen || 0;
    recorte = 0;
    inicioFichero = origen;
  }

  // Si la carga falla o tarda demasiado hay que soltar el cerrojo igualmente:
  // dejarlo puesto congelaria toda la sincronizacion.
  let resuelto = false;
  let timeoutCarga = null;
  const soltar = () => {
    if (resuelto) return;
    resuelto = true;
    clearTimeout(timeoutCarga);
    el.removeEventListener("loadedmetadata", alCargar);
    el.removeEventListener("error", fallo);
    if (cancelarCarga === soltar) cancelarCarga = null;
    // El cerrojo solo lo abre la carga vigente: si ya hay otra en marcha, es
    // suya la ultima palabra.
    if (cargaId === mia) cambiando = false;
  };
  const alCargar = () => {
    soltar();
    if (cargaId !== mia || audio !== el || !enabled) return;
    audio.currentTime = Math.max(minimo(), wanted());
    anclaCarga = null;
    audio.playbackRate = tasaUsuario;
    if (document.hidden) liderAudio("carga-audio-master");
    else if (audioMaster) devolverReloj("carga-visible");
    callarVideo(true);
    if (!video.paused && !seekUsuario && !saltoInterno) audio.play().catch(() => {});
    // El servidor puede devolver MENOS de lo pedido (recorta a marcas del
    // indice, o se acaba la grabacion), y entonces hay que adelantar el final.
    // Pero en un fichero que llega por trozos la duracion de `loadedmetadata`
    // es una ESTIMACION con lo poco bajado, y se queda corta; recortar por ella
    // ponia el cambio encima de la aguja y encadenaba recargas cada
    // granularidad. Por eso solo se recorta si deja pista de verdad, y se
    // revisa cada vez que el navegador corrige la duracion.
    ajustarVentanaFin();
    audio.addEventListener("durationchange", ajustarVentanaFin);
    audio.addEventListener("progress", ajustarVentanaFin);
    // El relevo (tramos acotados encadenados) se programa en cuanto la ventana
    // esta sonando; con retardo, para no pedirlo en pleno salto.
    if (ventanaFin === null) return;
    if (reserva && reservaParams) {
      // Relevo heredado de la ventana anterior: su sitio en el trozo no ha
      // cambiado, pero hay que traducirlo a la escala de esta ventana.
      cambioEn = inicioFichero + (reservaParams.recorte - recorte);
      // Si ya se paso, no se descarta: el bucle conmutara en cuanto este listo,
      // y `hacerRelevo` coloca la aguja donde toca.
    } else {
      programarRelevo();
    }
  };
  const fallo = () => {
    soltar();
    if (cargaId !== mia || audio !== el || !enabled) return;
    trozoFallido = s;
    fallbackAudio("fallo-carga");
    setStatus("No se pudo cargar ese trozo de audio", "off");
  };
  cancelarCarga = soltar;
  el.addEventListener("loadedmetadata", alCargar);
  el.addEventListener("error", fallo);
  timeoutCarga = setTimeout(fallo, 15000);
  // La duracion real llega en una cabecera, antes que el audio. En cuanto se
  // sepa, el final de ventana deja de ser una estimacion y el punto de cambio
  // se calcula bien a la primera.
  if (ventanaFin !== null) {
    duraReal(url).then((d) => {
      if (d === null || cargaId !== mia || audio !== el) return;
      const exacto = inicioFichero + d;
      if (Math.abs(ventanaFin - exacto) < 0.05) return;
      dbg("duraReal ventana: " + ventanaFin.toFixed(2) + " -> " + exacto.toFixed(2));
      ventanaFin = exacto;
      reprogramar();
    });
  }

  el.src = url;
  el.load();
}

function soltarReserva() {
  if (reserva) dbg("soltarReserva (tira el relevo en curso)");
  if (temporizadorRelevo) {
    clearTimeout(temporizadorRelevo);
    temporizadorRelevo = null;
  }
  if (reserva) {
    reserva.pause();
    reserva.removeAttribute("src");
    // Sin este `load()` el navegador sigue bajando lo que le quedaba, y son
    // cientos de megas peleando con lo que si corre prisa.
    reserva.load();
    reserva.remove();
  }
  reserva = null;
  reservaBuscada = null;
  reservaParams = null;
  cambioEn = null;
  relevoListo = false;
}

/** Escala temporal de un tramo que empieza en el segundo `corte` del trozo.
 *
 * `corte` DEBE venir ya redondeado a un multiplo de la granularidad: el
 * servidor lo redondea hacia abajo por su cuenta, y si el cliente calcula la
 * escala con un valor sin redondear, las dos lineas temporales quedan
 * desfasadas hasta `granularidad` segundos. Ese fue el fallo del primer intento
 * de encadenado: recargas continuas cada +10 s (justo la granularidad).
 */
function BASE_URL(s) {
  return base + s.audio_url;
}

function paramsDeChunk(s, corte) {
  const org = s.absoluto ? s.origen || 0 : -corte;
  const ini = s.absoluto ? org + corte : 0;
  let url = BASE_URL(s);
  url += (url.includes("?") ? "&" : "?") + "desde=" + corte + "&dura=" + DURA_RELEVO;
  return { origen: org, inicioFichero: ini, recorte: corte, ventanaFin: ini + DURA_RELEVO, url };
}

/** Ajusta el final de la ventana a la duracion real del fichero, PERO solo
 * cuando esa duracion es de fiar.
 *
 * En un fichero servido por trozos el navegador no sabe cuanto dura: la estima
 * a partir del ritmo de lo poco que lleva bajado, y esa estimacion se queda
 * corta (una ventana de 25 s llegaba a anunciarse como 15). Recortar por ella
 * adelantaba el punto de cambio, el relevo se pedia y se cancelaba al instante,
 * y la ventana se recargaba cada granularidad: microcorte cada 10 s.
 *
 * La duracion solo vale cuando el fichero ESTA ENTERO en el bufer; hasta
 * entonces se mantiene el tamano nominal, y si de verdad el tramo era mas
 * corto, ya lo recoge el manejador de `ended` recargando desde ahi.
 */
function ajustarVentanaFin() {
  if (!audio || ventanaFin === null) return;
  const d = audio.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  const tope = inicioFichero + DURA_RELEVO;

  if (d >= ventanaFin) {
    // El fichero resulto ser mas largo de lo estimado: devolver la ventana a
    // su tamano nominal y recolocar el punto de cambio.
    const antes = ventanaFin;
    ventanaFin = Math.min(d, tope);
    if (ventanaFin > antes) { dbg("ajustar CRECE " + antes.toFixed(1) + "->" + ventanaFin.toFixed(1)); reprogramar(); }
    return;
  }

  // Encoger solo con el fichero completo delante: si no, la duracion es una
  // estimacion y recortar por ella rompe el encadenado.
  const b = audio.buffered;
  const completo = b.length > 0 && b.end(b.length - 1) >= d - 0.25 && b.start(0) <= 0.25;
  if (completo) {
    dbg("ajustar ENCOGE " + ventanaFin.toFixed(1) + "->" + d.toFixed(1));
    ventanaFin = d;
    reprogramar();
  }
}

/** Recolocar el punto de cambio, pero SOLO si no hay ya un relevo en marcha.
 *
 * `ajustarVentanaFin` se llama tambien desde `progress`, que salta decenas de
 * veces mientras se descarga, y en un fichero que llega por trozos la duracion
 * crece en cada una. Llamar a `programarRelevo` en todas hacia que cada
 * crecimiento soltase el relevo a medio bajar y volviese a pedirlo: la misma
 * peticion repetida cuatro y cinco veces, compitiendo entre si por el ancho de
 * banda (medido: 1,4 min para un tramo que por curl tarda 1,35 s).
 *
 * Si ya hay un relevo pedido no hay nada que recolocar: sigue siendo del mismo
 * trozo y del mismo corte. Que la ventana crezca solo significa que tomara el
 * testigo un poco antes de lo estrictamente necesario, y eso no se nota.
 */
function reprogramar() {
  const destino = puntoDeCambio();
  if (destino === null) return;
  if (reserva) {
    // Con un relevo ya pedido normalmente no hay nada que hacer. PERO si la
    // duracion real resulto MENOR que la ventana nominal, el punto de cambio se
    // adelanta y el relevo quedo apuntando mas alla del final del fichero: al
    // conmutar se saltarian los segundos que van del final real al corte
    // pedido. Se oye como un corte. En ese caso hay que volver a apuntar.
    if (!reservaParams || reservaParams.recorte === destino) {
      dbg("reprogramar BLOQUEADO (relevo ya apunta a " + destino + ")");
      return;
    }
    dbg(
      "reprogramar REAPUNTA: relevo en " + reservaParams.recorte +
        " pero el cambio es en " + destino
    );
    soltarReserva();
  }
  programarRelevo();
}

/** Segundo del trozo en que el tramo actual cede el testigo.
 *
 * Se redondea al mismo multiplo que usa el servidor, para que el tramo
 * siguiente empiece EXACTAMENTE ahi y se aparque en su inicio sin mover la
 * aguja (moverla invalidaba el bufer recien bajado y obligaba a bajar el tramo
 * dos veces). Depende de `ventanaFin`, asi que CAMBIA cuando se descubre la
 * duracion real del fichero.
 */
function puntoDeCambio() {
  if (ventanaFin === null || !trozoActual || !trozoActual.granularidad) return null;
  const gran = trozoActual.granularidad;
  const finTramo = recorte + (ventanaFin - inicioFichero) - MARGEN_RELEVO;
  return Math.max(0, Math.floor(finTramo / gran) * gran);
}

/** Duracion REAL del tramo que va a servir el servidor, o null si no se sabe.
 *
 * El servidor nunca devuelve los segundos pedidos: redondea a marcas de su
 * indice, asi que a `dura=300` responde 261, 283, 316... Sin este dato la
 * extension programaba el punto de cambio con los 300 NOMINALES, y cuando el
 * tramo salia mas corto el relevo quedaba apuntando mas alla del final real:
 * al conmutar se saltaban esos segundos y se oia un corte. Se corregia sola al
 * terminar la descarga, pero a costa de tirar un tramo entero por ciclo.
 *
 * La cabecera llega en la PRIMERA respuesta, antes de ningun byte de audio, y
 * se pide un solo byte. Va por el service worker porque la respuesta no trae
 * Access-Control-Allow-Origin (ver background.js).
 */
async function duraReal(url) {
  try {
    const r = await ask({ type: "dura", url });
    if (!r || !r.ok) {
      dbg("duraReal FALLO: " + ((r && r.error) || "sin respuesta"));
      return null;
    }
    return r.dura;
  } catch (e) {
    dbg("duraReal EXCEPCION: " + e);
    return null;
  }
}

/** Programa el SIGUIENTE tramo para tenerlo listo antes de que haga falta. */
function programarRelevo() {
  if (temporizadorRelevo) {
    clearTimeout(temporizadorRelevo);
    temporizadorRelevo = null;
  }
  if (ventanaFin === null || !trozoActual || !trozoActual.granularidad) return;
  const s = trozoActual;
  const puntoCambio = puntoDeCambio();
  if (puntoCambio === null) return;
  // Ese mismo instante, pero en la escala del elemento que suena AHORA.
  const cambioActual = inicioFichero + (puntoCambio - recorte);
  const mia = cargaId;
  // Cuanto falta para el cambio, menos la antelacion que se quiere. Nunca por
  // debajo de RETARDO_RELEVO: en la ventana corta de arranque el cambio esta
  // encima y hay que pedirlo ya.
  // La aguja puede no estar colocada aun (recien puesto el src marca 0 aunque
  // el fichero empiece en `inicioFichero`), y entonces `falta` sale enorme y el
  // relevo se programaria DESPUES del cambio. Nunca se esta por debajo del
  // inicio del fichero, asi que ese es el suelo.
  const aguja = Math.max(audio.currentTime, inicioFichero);
  const falta = (cambioActual - aguja) * 1000;
  const espera = Math.max(RETARDO_RELEVO, falta - ANTICIPO_RELEVO * 1000);
  dbg("programarRelevo -> pedira corte=" + puntoCambio + " en " + Math.round(espera) + " ms");
  temporizadorRelevo = setTimeout(function () {
    temporizadorRelevo = null;
    if (cargaId === mia && ventanaFin !== null && trozoActual === s) {
      prepararRelevo(s, puntoCambio, cambioActual);
    }
  }, espera);
}

/** Carga por detras un tramo acotado y lo deja aparcado en su INICIO, que es
 * justo donde tomara el testigo (el punto de cambio va redondeado al mismo
 * multiplo que usa el servidor). Aparcarlo en su inicio evita mover la aguja,
 * y con ello la segunda descarga del mismo tramo. */
function prepararRelevo(s, corte, cambioActual, intentos = 0) {
  dbg("prepararRelevo PIDE corte=" + corte + " intento=" + intentos);
  soltarReserva();
  const p = paramsDeChunk(s, corte);
  const park = p.inicioFichero;

  const el = document.createElement("audio");
  el.preload = "auto";
  el.volume = 0;
  el.style.display = "none";
  document.body.appendChild(el);

  el.addEventListener(
    "loadedmetadata",
    function () {
      if (reserva !== el) return;
      try {
        el.currentTime = park;
        // Queda constancia de DONDE se mando a descargar. Sin esto, la primera
        // pasada de `hacerRelevo` la daba por no apuntada y le movia la aguja,
        // y ese movimiento abre una SEGUNDA descarga del mismo tramo (~7,7 MB)
        // que ademas se queda a medias, estrangulada por estar el elemento en
        // pausa. Es justo lo que evita aparcarla en su inicio.
        reservaBuscada = park;
      } catch {
        soltarReserva();
        return;
      }
      // No basta con que el fichero exista y la aguja se pueda colocar: si no
      // hay datos DONDE va a empezar a sonar, la conmutacion entrega un
      // elemento que se atasca en el acto. Se espera a tener con que seguir.
      if (el.readyState >= 3) {
        relevoListo = true;
        return;
      }
      const listo = () => {
        if (reserva !== el) return;
        relevoListo = true;
        el.removeEventListener("canplay", listo);
      };
      el.addEventListener("canplay", listo);
    },
    { once: true }
  );
  el.addEventListener("error", function () {
    if (reserva !== el) return;
    soltarReserva();
    // En un directo en curso la grabacion todavia esta creciendo: el tramo que
    // se pide puede no existir AUN. Antes no lo reintentaba nadie y habia que
    // esperar a que la ventana se agotase, con recarga (microcorte). Se vuelve
    // a intentar unas cuantas veces: para cuando toque el cambio, el servidor
    // ya suele tener ese trozo grabado.
    if (intentos >= REINTENTOS_RELEVO) return;
    const mia = cargaId;
    temporizadorRelevo = setTimeout(function () {
      temporizadorRelevo = null;
      if (cargaId === mia && ventanaFin !== null && trozoActual === s) {
        prepararRelevo(s, corte, cambioActual, intentos + 1);
      }
    }, ESPERA_REINTENTO);
  });

  cambioEn = cambioActual; // instante, en la escala del elemento que suena ahora
  // Lo mismo para el relevo: su `ventanaFin` viaja en reservaParams y se adopta
  // al conmutar, asi que corregirla aqui hace que el tramo siguiente se
  // programe bien desde el primer instante.
  duraReal(p.url).then((d) => {
    if (d === null) { dbg("duraReal relevo " + corte + ": SIN CABECERA"); return; }
    if (reserva !== el || reservaParams !== p) {
      dbg("duraReal relevo " + corte + ": llego tarde (la reserva ya es otra)");
      return;
    }
    const exacto = p.inicioFichero + d;
    dbg(
      "duraReal relevo " + corte + ": " + p.ventanaFin.toFixed(2) +
        " -> " + exacto.toFixed(2)
    );
    p.ventanaFin = exacto;
  });

  el.src = p.url;
  el.load();
  reserva = el;
  reservaParams = p;
}

/** Cambia al elemento de reserva. Devuelve false si aun no estaba listo. */
// Chrome deja de descargar y suelta el bufer de un elemento pausado, silenciado
// y oculto. La reserva se prepara ~290 s antes de usarse, asi que para cuando
// toma el testigo puede tener solo los metadatos. Un empujon a la aguja la
// obliga a volver a pedir datos.
// Posicion que le toca a la reserva, en SU escala, sin tocar la del elemento
// que suena ahora mismo.
const posicionEnReserva = (p) =>
  p.origen + (posicionEfectiva() - baseOffset - nudge);

// Los dos tramos se solapan varios segundos, asi que en el momento del cambio
// LOS DOS LLEVAN EL MISMO AUDIO. Cortar en seco empalma dos flujos decodificados
// aparte, con unas centesimas de desfase: se oye un chasquido. Solapandolos unas
// decimas y cruzando el volumen, el empalme deja de notarse.
const FUNDIDO = 0.12; // segundos
const PASO_FUNDIDO = 15; // ms entre escalones

function fundirYSoltar(viejo, nuevo) {
  const soltar = () => {
    viejo.pause();
    viejo.removeAttribute("src");
    viejo.load();
    viejo.remove();
  };
  // Si el viejo ya no suena no hay nada que cruzar.
  if (viejo.paused || viejo.readyState < 3) {
    nuevo.volume = volumenEfectivo();
    soltar();
    return;
  }
  const t0 = performance.now();
  const escalon = () => {
    const k = Math.min(1, (performance.now() - t0) / (FUNDIDO * 1000));
    const v = volumenEfectivo();
    try {
      nuevo.volume = v * k;
      viejo.volume = v * (1 - k);
    } catch {
      /* el elemento pudo irse por otro lado */
    }
    if (k < 1) {
      setTimeout(escalon, PASO_FUNDIDO);
      return;
    }
    soltar();
  };
  escalon();
}

function hacerRelevo() {
  if (!reserva || !relevoListo) return false;

  // `relevoListo` se otorgo en `canplay` al precargar, y vale para la posicion
  // de aparcamiento. Pero lo que importa es si hay datos DONDE va a sonar, y
  // eso solo se sabe despues de colocar la aguja. Asi que primero se coloca,
  // luego se comprueba, y solo entonces se consume la reserva: mientras no se
  // consuma, el elemento viejo sigue sonando (tiene margen de sobra por delante,
  // el punto de cambio va redondeado hacia atras) y el bucle reintenta.
  const destino = posicionEnReserva(reservaParams);
  // Se apunta UNA vez, o de nuevo solo si el destino se ha ido lejos de donde
  // se mando a descargar. Reapuntar en cada vuelta era el error: cada salto
  // cancelaba la descarga anterior y la reserva no cargaba nunca.
  let salto1 = null; // distancia del salto de apuntado, si lo hubo
  let salto2 = null; // idem del ajuste fino
  if (reservaBuscada === null || Math.abs(destino - reservaBuscada) > 1) {
    try {
      salto1 = destino - (reservaBuscada === null ? reserva.currentTime : reservaBuscada);
      reserva.currentTime = destino;
      reservaBuscada = destino;
    } catch {
      /* fuera de rango: lo arregla el bucle */
    }
  }
  if (reserva.readyState < 3) {
    dbg(
      "hacerRelevo ESPERA: sin datos en destino=" + destino.toFixed(3) +
      " apuntada=" + (reservaBuscada === null ? "-" : reservaBuscada.toFixed(3)) +
      " (readyState=" + reserva.readyState + ")"
    );
    return false;
  }
  // Ajuste fino, pero solo si de verdad hace falta: cualquier salto abre una
  // peticion nueva al servidor. Por debajo de DRIFT_SEEK no se toca nada, que
  // de eso ya se encarga el bucle estirando el ritmo, y eso no se oye.
  const fino = posicionEnReserva(reservaParams);
  if (Math.abs(reserva.currentTime - fino) > DRIFT_SEEK) {
    try {
      salto2 = fino - reserva.currentTime;
      reserva.currentTime = fino;
    } catch {
      /* fuera de rango: lo arregla el bucle */
    }
  }

  const nuevo = reserva;
  const p = reservaParams;
  const viejo = audio;
  reserva = null;
  reservaParams = null;
  relevoListo = false;
  reservaBuscada = null;
  // El instante de conmutacion estaba en la escala del elemento que se va;
  // dejarlo puesto haria que el siguiente tick creyera que toca conmutar otra
  // vez (sin reserva) y acabara recargando. Lo repone `programarRelevo`.
  cambioEn = null;

  // Posicion en la escala del VOD de lo que sonaba, medida ANTES de cambiar de
  // escala: es el unico momento en que el elemento viejo sigue siendo legible.
  const vodViejo = viejo ? viejo.currentTime - origen + baseOffset + nudge : null;
  const listoViejo = viejo ? viejo.readyState : null;

  // Adoptar la escala del tramo nuevo ANTES de calcular la posicion.
  origen = p.origen;
  inicioFichero = p.inicioFichero;
  recorte = p.recorte;

  // La aguja ya quedo colocada y con datos antes de consumir la reserva.
  nuevo.volume = 0; // lo sube `fundirYSoltar`; a pelo se oye el empalme
  eventosAudio(nuevo);
  nuevo.playbackRate = tasaUsuario;

  audio = nuevo;
  ventanaFin = p.ventanaFin;
  // Igual que en la ventana: el tramo servido puede ser mas corto que el
  // pedido, pero la duracion solo vale si es creible (ver ajustarVentanaFin).
  nuevo.addEventListener("durationchange", ajustarVentanaFin);
  nuevo.addEventListener("progress", ajustarVentanaFin);
  ajustarVentanaFin(); // por si la duracion ya se sabia y no llega el evento
  if (!video.paused && !saltoInterno && !seekUsuario) nuevo.play().catch(() => {});

  if (viejo) fundirYSoltar(viejo, nuevo);
  const vodNuevo = nuevo.currentTime - p.origen + baseOffset + nudge;
  const salto = vodViejo === null ? null : vodNuevo - vodViejo;
  dbg(
    "hacerRelevo CONMUTA a corte=" + recorte +
    " apuntado=" + (salto1 === null ? "no" : salto1.toFixed(3)) +
    " fino=" + (salto2 === null ? "no" : salto2.toFixed(3)) +
    " vodViejo=" + (vodViejo === null ? "-" : vodViejo.toFixed(3)) +
    " vodNuevo=" + vodNuevo.toFixed(3) +
    " SALTO=" + (salto === null ? "-" : (salto >= 0 ? "+" : "") + salto.toFixed(3)) +
    " listoViejo=" + listoViejo + " listoNuevo=" + nuevo.readyState
  );
  // Cuanto silencio hay de verdad: del momento de conmutar al primer
  // fotograma de audio que el elemento nuevo entrega.
  const t0 = performance.now();
  const alSonar = () => {
    nuevo.removeEventListener("playing", alSonar);
    dbg("hacerRelevo SUENA tras " + Math.round(performance.now() - t0) + " ms");
  };
  nuevo.addEventListener("playing", alSonar);
  programarRelevo(); // encadena el siguiente, sin cortes
  return true;
}

// Posicion que toca dentro del fichero, ya en la escala que usa el elemento.
const wanted = () => origen + (posicionEfectiva() - baseOffset - nudge);

function resync() {
  if (!audio || !video || !enabled) return;
  audio.playbackRate = tasaUsuario;
  if (reserva) reserva.playbackRate = tasaUsuario;
}

function tick() {
  if (!enabled || !audio || !video || !track) return;
  if (!vigilarElemento()) return;

  if (cambiando || seekUsuario || saltoInterno || video.seeking) return;
  if (document.hidden && trozoActual && trozoActual !== trozoFallido) liderAudio("tick-audio-master");
  if (!document.hidden && audioMaster) {
    devolverReloj("tick-visible");
    if (saltoInterno) return;
  }

  const enVod = posicionEfectiva();
  const toca = trozoPara(enVod);

  if (!toca || toca === trozoFallido) {
    fallbackAudio("hueco-o-fin");
    if (!toca) trozoActual = null;
    setStatus(
      trozos.length > 1
        ? "Hueco entre grabaciones — suena el VOD"
        : "Fuera del tramo grabado — suena el VOD"
    );
    return;
  }

  if (toca !== trozoActual) {
    ponerTrozo(toca, enVod, "otro-trozo");
    return;
  }

  // OJO: `t` se recalcula despues de conmutar. `hacerRelevo` adopta el origen
  // del tramo nuevo y cambia el elemento, asi que un `t` calculado antes queda
  // en la escala del tramo VIEJO. Compararlo con la duracion del nuevo daba
  // "estamos fuera del fichero" y recargaba la ventana en CADA conmutacion.
  let t = wanted();

  // Se acaba la ventana: entra el elemento de reserva, que ya espera colocado.
  // Si no llego a tiempo, se recarga desde aqui (un tropiezo corto, pero no se
  // queda callado).
  const limite = cambioEn !== null ? cambioEn : ventanaFin - MARGEN_RELEVO;
  if (ventanaFin !== null && (audio.ended || audio.currentTime >= limite)) {
    // Si el fichero acaba antes del limite nominal y no hay cola lista,
    // no recargar indefinidamente el mismo ultimo segundo.
    if (audio.ended && !relevoListo) {
      // Que el fichero se acabe NO implica que la grabacion haya fallado: el
      // servidor puede haber servido un tramo mas corto que el pedido. Solo es
      // el final de verdad si la posicion ya esta al borde del trozo. Si no, se
      // recarga desde aqui (un tropiezo corto) en vez de condenar el trozo, que
      // dejaba el VOD entero sin audio grabado hasta el siguiente salto.
      const finTrozo = trozoActual.fin;
      const enElFinal =
        finTrozo !== null && finTrozo !== undefined && enVod >= finTrozo - 2;
      if (enElFinal) {
        trozoFallido = trozoActual;
        fallbackAudio("fin-de-grabacion");
        return;
      }
      setDiag("tramo mas corto de lo pedido: recargando");
      ponerTrozo(trozoActual, enVod, "tramo-corto");
      return;
    }
    if (!hacerRelevo()) {
      // Aqui se recargaba en el acto, y esa recarga es justo el corte: pausa el
      // audio y deja varios segundos de silencio esperando al servidor. Pero al
      // llegar al punto de cambio TODAVIA QUEDA audio en el elemento (el punto
      // va redondeado hacia atras, y detras hay hasta MARGEN_RELEVO mas). Se
      // apura hasta el final de verdad: se sigue sonando y cada vuelta del
      // bucle reintenta la conmutacion, que ocurrira en cuanto el relevo este.
      // Solo si el fichero se agota del todo se recarga (lo hace la rama de
      // `ended` de mas arriba).
      if (!audio.ended) {
        setDiag("relevo no listo: apurando la ventana");
        return;
      }
      setDiag("el relevo no llego a tiempo: recargando");
      ponerTrozo(trozoActual, enVod, "relevo-tarde");
      return;
    }
    // Conmutado: la escala es otra, asi que la posicion deseada se recalcula.
    t = wanted();
  }

  if (audio.ended) {
    const finTrozo = trozoActual.fin;
    const enElFinal =
      finTrozo !== null && finTrozo !== undefined && enVod >= finTrozo - 2;
    if (enElFinal) {
      trozoFallido = trozoActual;
      fallbackAudio("fin-de-grabacion");
      return;
    }
    setDiag("fichero acabado antes de tiempo: recargando");
    ponerTrozo(trozoActual, enVod, "fichero-acabado");
    return;
  }

  // Fuera de lo que abarca el fichero cargado, o demasiado lejos de lo que hay
  // descargado: sale mas a cuenta pedirlo recortado en el punto nuevo.
  if (convieneRecargar(trozoActual, t)) {
    ponerTrozo(trozoActual, enVod, "conviene-recargar");
    return;
  }
  if (t < minimo() || (audio.duration && t > audio.duration)) {
    // Dentro del margen de borde no es un error: es el desfase de decimas con
    // el video al empezar o acabar un tramo. Se pega la aguja al limite y el
    // bucle converge solo, sin recargar nada.
    if (t < minimo() && t >= minimo() - BORDE &&
        Math.abs(audio.currentTime - minimo()) > DRIFT_SEEK) {
      audio.currentTime = minimo();
    }
    return;
  }

  // Twitch rehace su reproductor al cambiar de calidad o volver de un
  // anuncio, asi que se vuelve a imponer el silencio en cada vuelta.
  callarVideo(true);
  audio.volume = volumenEfectivo();
  setStatus(
    trozos.length > 1
      ? `Audio original · trozo ${trozos.indexOf(trozoActual) + 1} de ${trozos.length}`
      : `Audio original · ${fmt(track.duration)} grabados`,
    "on",
    tramoDelTrozo(trozoActual)
  );

  if (video.paused) {
    if (!audio.paused) audio.pause();
    return;
  }
  if (audio.paused) {
    // Si ya esta colocado no se vuelve a mover la aguja: cada salto cuesta
    // que el decodificador se reinicie.
    if (Math.abs(audio.currentTime - t) > DRIFT_SEEK) audio.currentTime = t;
    audio.play().catch(() => setStatus("Pulsa play en el video"));
    return;
  }

  if (audioMaster) {
    // EXPERIMENTO: en vez de dejar que el video se atrase mientras esta oculto
    // y recolocarlo al volver, se intenta ACELERARLO para que persiga al audio
    // en tiempo real. Si Chrome respeta el playbackRate de una pestana oculta,
    // al volver ya estaria en sync y no haria falta ningun salto.
    //
    // El audio se mantiene a 1x aparte: nunca hereda la velocidad de
    // persecucion (si no, se oiria acelerado). Si Chrome capa el decodificado
    // de fondo, el video se atrasa igual y el salto-hacia-adelante de la vuelta
    // lo recoloca como hasta ahora: este experimento no puede empeorar nada.
    audio.playbackRate = tasaUsuario;
    if (document.hidden && video) {
      // El video, oculto, va mas lento de lo que Chrome deberia; se le acelera
      // (sobre la velocidad del usuario) para que persiga al audio en tiempo
      // real. Medido: con esto vuelve en sync sin ningun salto.
      const atraso = posicionAudio() - video.currentTime;
      const factor = atraso > 0.25 ? 2 : atraso < -0.25 ? 0.5 : 1;
      video.playbackRate = tasaUsuario * factor;
    } else if (video) {
      video.playbackRate = tasaUsuario;
    }
    return;
  }
  const drift = audio.currentTime - t;
  // El audio NO se rebobina para corregir desfase: rebobinar es volver a oir
  // algo ya oido, y se nota muchisimo. Es lo que pasaba al volver de tener
  // Chrome minimizado: el video se queda ~1 s atras cada 25 s en segundo
  // plano, y al devolverle el mando arrastraba el audio hacia atras.
  //
  // Si el audio va por delante se le frena un poco y converge sin que se note.
  // Saltar hacia atras solo cuando esta tan lejos que ya no es desfase, sino
  // que algo se ha descuadrado de verdad.
  if (drift > DRIFT_MAX_ADELANTO) {
    // Audio muy por delante: pasa al volver de segundo plano si el video
    // rebufferea lento. Rebobinar el audio seria repetir lo ya oido, asi que
    // se adelanta el VIDEO hasta donde va el audio. El sonido no se toca.
    colocarVideo(posicionAudio(), "alcanzar-audio");
  } else if (drift < -DRIFT_SEEK) {
    // Audio por detras. OJO: hay dos motivos muy distintos para eso.
    //
    // Si es desfase de verdad, adelantar la aguja es correcto: salta un poco
    // pero no repite nada. Si el elemento esta ATASCADO esperando bytes (el
    // relevo aparcado baja despacio, porque Chrome estrangula el bufer de un
    // medio en pausa, y al conmutar hay que pedirlo otra vez), entonces el
    // audio se queda atras por falta de datos y adelantar la aguja se SALTA el
    // trozo que no llego a sonar. Se oye como si el directo diera tirones.
    //
    // readyState < HAVE_FUTURE_DATA significa que no hay con que seguir
    // sonando: en ese caso no se toca nada y se espera a que llegue.
    if (audio.readyState < 3) return;
    audio.currentTime = t;
    audio.playbackRate = tasaUsuario;
  } else if (Math.abs(drift) > DRIFT_TRIM) {
    // 2 % arriba o abajo: converge en un par de segundos y no se nota.
    audio.playbackRate = tasaUsuario * (drift > 0 ? 0.98 : 1.02);
  } else {
    audio.playbackRate = tasaUsuario;
  }
}

/** Recoloca y reanuda el audio en el acto tras un salto del video.
 *
 * Antes esto lo hacia el bucle: `seeked` solo movia la aguja y habia que
 * esperar hasta 250 ms a la siguiente vuelta para que sonara, que ademas
 * volvia a mover la aguja (dos saltos por cada uno del usuario).
 */
function trasSaltar() {
  if (!enabled || !audio || !video || !track) return;
  // Ojo: aqui NO se comprueba `cambiando`. Si el usuario salta otra vez
  // mientras se carga, hay que atender el salto nuevo y anular el anterior; si
  // no, llega una ventana del sitio equivocado y el bucle tarda otro cuarto de
  // segundo en darse cuenta. Eso era el paron al encadenar saltos.
  const enVod = video.currentTime;
  const toca = trozoPara(enVod);
  if (!toca) {
    if (cancelarCarga) cancelarCarga();
    ++cargaId;
    anclaCarga = null;
    tick();
    return;
  }
  if (toca !== trozoActual) {
    ponerTrozo(toca, enVod, "salto-otro-trozo"); // se coloca y arranca al terminar
    return;
  }
  const t = wanted();
  if (convieneRecargar(toca, t)) {
    ponerTrozo(toca, enVod, "salto-conviene");
    return;
  }
  if (t < minimo() || (audio.duration && t > audio.duration)) return;
  // Con una carga en marcha no se toca la aguja: el destino ya cae dentro de
  // lo que se esta pidiendo, y `alCargar` lo colocara al terminar. Moverla
  // ahora obliga al elemento a atender un salto en mitad de la carga, que es
  // trabajo de mas justo cuando corre prisa.
  if (cambiando) { anclaCarga = enVod; return; }
  // Si ya esta donde tiene que estar, NO se toca la aguja. Twitch tarda
  // cientos de milisegundos en rematar su propio salto, y para cuando avisa
  // con `seeked` el audio suele llevar rato colocado por el bucle. Moverlo
  // otra vez obliga al descodificador a empezar de nuevo y tira a la basura
  // justo lo que ya estaba listo.
  if (Math.abs(audio.currentTime - t) > 0.25) audio.currentTime = t;
  if (!video.paused && audio.paused) audio.play().catch(() => {});
}

/** Se ata a un elemento de video concreto: audio enrutado y eventos puestos.
 *
 * Twitch es una SPA y al navegar deja un instante el <video> de la pagina
 * anterior en el DOM, para sustituirlo despues por el del reproductor nuevo.
 * Si nos quedamos con aquel, sus eventos no llegan nunca y parece que la
 * extension no arranca hasta recargar a mano.
 */
function engancharVideo(el) {
  // Al soltar el elemento anterior se le devuelve su sonido: si no, quedaria
  // callado para siempre aunque ya no lo usemos.
  if (video && video !== el) {
    resetReloj("reemplazo");
    if (cancelarCarga) cancelarCarga();
    ++cargaId;
    soltarReserva();
    if (audio) audio.pause();
    callarVideo(false);
    trozoFallido = null;
  }
  video = el;
  ctx = null;
  ganancia = null;
  webaudio = false;
  tomarAudioDelVideo();
  attachVideoEvents();
  reclamarTeclasDeMedios();
}

// La tecla de medios Play/Pausa (y el boton del raton que la manda) la enruta
// Chrome al elemento que suena. Como ahora suena NUESTRO audio, se la quitaba
// al video de Twitch y el boton dejaba de pausar el directo. Reclamando la
// sesion de medios recibimos la tecla y la reenviamos al video, que es lo que
// el usuario espera; nuestro audio ya sigue al video por sus eventos.
function reclamarTeclasDeMedios() {
  if (!("mediaSession" in navigator)) return;
  try {
    // Chrome solo enruta la tecla de medios a una pestana de fondo si tiene una
    // sesion "activa": con metadatos y estado. Sin esto, al quitarle la sesion
    // a Twitch la tecla se pierde en segundo plano.
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: document.title || "Twitch Audio Vault",
        artist: "Audio original del directo",
      });
    } catch { /* MediaMetadata no soportado */ }
    navigator.mediaSession.playbackState =
      video && video.paused ? "paused" : "playing";
    // TODOS los manejadores ALTERNAN, no fuerzan direccion. La tecla de medios
    // es un toggle, pero Chrome dispara `play` o `pause` segun el playbackState
    // que declaramos, y ese se desincroniza (Twitch y nuestro audio tambien lo
    // tocan). Si forzaramos la direccion, un playbackState obsoleto haria que
    // se disparase la accion equivocada y se quedara clavado ("repite estado").
    // Alternando, de la accion que sea siempre se cambia al estado contrario.
    for (const accion of ["play", "pause", "playpause"]) {
      try {
        navigator.mediaSession.setActionHandler(accion, alternarVideo);
      } catch { /* accion no soportada */ }
    }
  } catch { /* navegador sin soporte: la tecla ira a donde Chrome decida */ }
}

// Alterna play/pausa del VIDEO (no del audio, que lo sigue por sus eventos).
// Con antirrebote: si la tecla llegara a la vez por dos vias no cuenta doble.
let ultimaAlternancia = 0;
function alternarVideo() {
  if (!video) return;
  const ahora = Date.now();
  if (ahora - ultimaAlternancia < 250) return; // antirrebote: dos vias a la vez
  ultimaAlternancia = ahora;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

// La tecla de medios Play/Pausa (y el boton del raton que la emite) llega a la
// pagina como un keydown, pero Twitch no la maneja y Chrome ya no la enruta al
// video porque nuestro audio le robo la sesion de medios. Se captura aqui y se
// aplica al video. Solo cuando hay grabacion activa (video enganchado); si no,
// se deja pasar para no cambiar el comportamiento normal de la pagina.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "MediaPlayPause" || e.code === "MediaPlayPause" || e.keyCode === 179) {
      if (!video || !track) return;
      e.preventDefault();
      alternarVideo();
    }
  },
  true
);

function soltarTeclasDeMedios() {
  if (!("mediaSession" in navigator)) return;
  try {
    // Hay que soltar TODO lo que pudimos poner. Si queda algun manejador (p.ej.
    // "playpause"), en la pagina siguiente —un directo, donde la extension no
    // hace nada— seguiria capturando la tecla y ejecutando codigo que ya no
    // tiene video: la tecla se pierde y el directo no se pausa. Vaciando la
    // sesion, Twitch la recupera.
    for (const accion of ["play", "pause", "playpause"]) {
      navigator.mediaSession.setActionHandler(accion, null);
    }
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  } catch { /* nada */ }
}

/** Comprueba que seguimos sobre el reproductor bueno y, si no, se reengancha.
 *
 * No basta con mirar si el elemento sigue en el DOM: al navegar dentro de
 * Twitch el reproductor anterior puede quedarse ahi, oculto, mientras el nuevo
 * se monta al lado. Por eso se vuelve a elegir cual es el principal.
 */
function vigilarElemento() {
  if (!video) return false;
  const nuevo = videoPrincipal();
  if (!nuevo) return video.isConnected;
  if (nuevo === video) return true;
  setDiag("el reproductor cambio: reenganchando");
  engancharVideo(nuevo);
  trozoActual = null; // obliga a recolocar el audio sobre el reproductor nuevo
  return true;
}

// Twitch reutiliza el mismo <video> entre paginas, asi que hay que llevar la
// cuenta de a cuales ya nos hemos atado: si no, cada visita añadiria otra
// tanda de manejadores sobre el mismo elemento.
const conEventos = new WeakSet();

function attachVideoEvents() {
  if (conEventos.has(video)) return;
  conEventos.add(video);
  const el = video;
  const activo = () => el === video && enabled && audio && track;
  const interno = () => saltoInterno && saltoInterno.el === el &&
    Math.abs(el.currentTime - saltoInterno.target) < 0.1;
  const manual = () => {
    saltoInterno = null;
    audioMaster = false;
    seekUsuario = true;
    trozoFallido = null;
    anclaCarga = video.currentTime;
    audio.pause();
    // Abortar el relevo en cuanto empieza el salto, no al cargar la ventana
    // nueva. El relevo descarga la cola entera y, en un servidor con disco
    // lento (el HP: graba + sirve a la vez), competir con la ventana que corre
    // prisa dispara la espera del servidor. Soltarlo aqui libera el disco antes
    // de pedir la ventana. La cola se volvera a preparar 4 s despues de que la
    // reproduccion se asiente, ya sin salto en curso.
    soltarReserva();
  };
  /** Un salto que no hemos hecho nosotros y que TAMPOCO es del usuario.
   *
   * En el VOD de un directo que sigue emitiendo, Twitch recoloca su reproductor
   * por su cuenta al volver a la pestana (esta sirviendo un fichero que crece y
   * rebufferea). Ese salto entraba por la misma puerta que un salto del usuario:
   * se soltaba el mando del audio y se le llevaba a la posicion del video, que
   * viene ATRASADA porque Chrome lo estrangula en segundo plano. Eso es
   * justamente el audio volviendo atras.
   *
   * Se reconoce porque el usuario no ha podido hacerlo: la pestana estaba
   * oculta, o acaba de volver; y porque el destino cae DETRAS del audio, dentro
   * de lo que se puede haber atrasado el video de fondo. */
  const recolocacionDeTwitch = () => {
    if (!audio || !trozoActual || video.paused) return false;
    const reciente = document.hidden || Date.now() - ultimaVuelta < GRACIA_VUELTA;
    if (!reciente) return false;
    const atraso = posicionAudio() - el.currentTime;
    return atraso > 0 && atraso < ATRASO_MAX_FONDO;
  };
  el.addEventListener("seeking", () => {
    if (!activo() || interno()) return;
    // No soltar el mando: el audio sigue mandando y el video lo alcanzara.
    if (recolocacionDeTwitch()) return;
    manual();
  });
  el.addEventListener("seeked", () => {
    if (!activo()) return;
    if (interno()) {
      saltoInterno = null;
      audioMaster = false;
      anclaCarga = null; // el salto termino: el ancla ya no representa nada
      if (document.hidden) liderAudio("seek-interno-oculto");
      if (!el.paused && !cambiando && trozoActual !== trozoFallido) audio.play().catch(() => {});
      return;
    }
    // Twitch recolocandose solo: se mantiene el audio de maestro y se deja que
    // el video lo persiga, en vez de rebobinar el sonido hasta el.
    //
    // Se vuelve a comprobar AQUI aunque ya se comprobara en `seeking`, y sin
    // exigir que no haya un salto en curso: cuando salta `seeking` el
    // reproductor no siempre ha movido todavia la aguja, el retraso sale como
    // cero, no se reconoce la recolocacion y `manual()` ya ha soltado el mando.
    // En `seeked` la posicion es firme, asi que si resulta ser cosa de Twitch,
    // se deshace lo que hizo `manual()`.
    if (recolocacionDeTwitch()) {
      seekUsuario = false;
      saltoInterno = null;
      anclaCarga = null; // o la posicion efectiva se quedaria clavada atras
      liderAudio("recolocacion-de-twitch");
      if (!el.paused && !cambiando && trozoActual !== trozoFallido) {
        audio.play().catch(() => {});
      }
      return;
    }
    // Un destino distinto interrumpe tambien un seek nuestro pendiente.
    if (saltoInterno) manual();
    seekUsuario = false;
    trasSaltar();
    if (document.hidden && !cambiando && trozoPara(el.currentTime)) liderAudio("seek-oculto");
  });
  el.addEventListener("play", () => {
    // Solo si seguimos activos en ESTE elemento y hay grabacion: si no, en un
    // directo (donde Twitch reutiliza el mismo <video>) este viejo listener
    // volveria a registrar nuestros manejadores y se comeria la tecla.
    if (!activo() || saltoInterno || seekUsuario) return;
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "playing";
      reclamarTeclasDeMedios();
    }
    if (audioMaster) { if (!cambiando) audio.play().catch(() => {}); }
    else { trasSaltar(); if (document.hidden && !cambiando) liderAudio("play-oculto"); }
  });
  el.addEventListener("pause", () => {
    if (!activo()) return;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    audio.pause();
  });
  el.addEventListener("ratechange", () => {
    if (!activo()) return;
    // Solo cuenta como eleccion del usuario si la pestana esta visible: los
    // cambios de la persecucion ocurren ocultos y no deben confundirse con ella.
    if (!document.hidden) tasaUsuario = video.playbackRate;
    resync();
  });

  // Con Web Audio los controles de Twitch son los del audio grabado: se
  // aplican en el acto, sin esperar al siguiente ciclo. Si Web Audio no
  // estuviera disponible, se recurre a silenciar el elemento y hay que
  // deshacer al instante el intento de desmutear para que no suene doble.
  video.addEventListener("volumechange", () => {
    if (el !== video || !enabled || !audio || !track) return;
    if (webaudio) audio.volume = volumenEfectivo();
    else if (!video.muted) video.muted = true;
  });
}

// --------------------------------------------------------- ciclo de la pagina

function teardown() {
  ++generacion;
  if (cancelarCarga) cancelarCarga();
  ++cargaId;
  resetReloj("teardown");
  trozoFallido = null;
  if (timer) clearInterval(timer);
  timer = null;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio.remove();
    audio = null;
  }
  if (video) callarVideo(false);
  soltarReserva();
  ventanaFin = null;
  recorte = 0;
  inicioFichero = 0;
  // El contexto NO se cierra: pertenece al elemento, que puede seguir siendo
  // el mismo en la pagina siguiente, y su enrutado no se puede rehacer.
  ctx = null;
  ganancia = null;
  webaudio = false;
  soltarTeclasDeMedios();
  video = null;
  track = null;
  origen = 0;
  trozos = [];
  trozoActual = null;
  cambiando = false;
  currentVod = null;
  nudge = 0;
  baseOffset = 0;
  setStatus("Esto no es un VOD");
}

async function enterVod(vodId, elemento = null) {
  const sesion = generacion;
  currentVod = vodId;
  setStatus("Buscando audio grabado…");

  const reply = await ask({ type: "match", vod: vodId });
  if (!reply.ok) {
    setStatus("Twitch Audio Vault no esta abierto", "off");
    return;
  }
  base = reply.base;
  const data = reply.data;
  if (!data.found) {
    setStatus("No hay audio grabado de este directo", "off");
    return;
  }

  const el = elemento || (await findVideoElement());
  if (!el) {
    setStatus("No encuentro el reproductor", "off");
    return;
  }
  engancharVideo(el);

  track = data;
  trozos = data.segments || [
    { id: data.id, inicio: data.offset || 0, fin: null, audio_url: data.audio_url },
  ];
  trozoActual = null;
  baseOffset = trozos[0].inicio;

  audio = document.createElement("audio");
  audio.preload = "auto";
  audio.volume = volumen;
  audio.style.display = "none";
  audio.addEventListener("error", () =>
    setStatus("No se pudo cargar el audio del servidor", "off")
  );
  document.body.appendChild(audio);
  ponerTrozo(trozos[0], trozos[0].inicio, "arranque");

  setStatus(`Audio original · ${fmt(data.duration)} grabados`, "on");
  timer = setInterval(tick, TICK_MS);
}

/** Portada de un canal: Twitch reproduce ahi el ultimo directo emitido.
 *
 * La URL no dice cual es, asi que se pregunta al servidor por los VODs
 * grabados de ese canal y se elige por duracion. Si nada encaja no se toca
 * nada: mas vale no sonar que sonar encima de lo que no toca.
 */
async function enterCanal(login) {
  const mia = claveRuta;
  setStatus("Mirando que suena en esta pagina…");

  setDiag("preguntando por el canal");
  const reply = await ask({ type: "canal", login });
  if (claveRuta !== mia) return; // el usuario ya se ha ido a otro sitio
  if (!reply.ok) {
    setDiag(`el servidor fallo: ${reply.error || "?"}`);
    setStatus("Twitch Audio Vault no esta abierto", "off");
    return;
  }
  const videos = (reply.data && reply.data.videos) || [];
  setDiag(`${videos.length} vods grabados de ${login}`);
  if (!videos.length) {
    setStatus("No hay grabaciones de este canal", "off");
    return;
  }

  const el = await findVideoElement();
  if (claveRuta !== mia) return;
  if (!el) {
    setStatus("No encuentro el reproductor", "off");
    return;
  }

  const duracion = await duracionDelReproductor(el);
  if (claveRuta !== mia) return;
  if (duracion === null) {
    setDiag("duracion no fija o no legible (parece directo)");
    setStatus("Aqui suena el directo, no un VOD grabado");
    return;
  }
  setDiag(`reproductor dura ${Math.round(duracion)} s; grabados ${videos
    .map((v) => v.duracion)
    .join(", ")}`);

  // Tolerancia de 25 s: la duracion que da Twitch va redondeada al segundo y
  // el reproductor no siempre coincide al decimal.
  const cual = videos.find(
    (v) => v.duracion && Math.abs(v.duracion - duracion) <= 25
  );
  if (!cual) {
    setStatus("Lo que suena aqui no es un directo que tengas grabado", "off");
    return;
  }
  await enterVod(cual.vod, el);
}

// Que estamos mirando ahora mismo: "v<id>" un VOD, "c<login>" una portada.
let claveRuta = null;

function onRouteChange() {
  const id = vodIdFromUrl();
  const canal = id ? null : loginDeCanal();
  const clave = id ? `v${id}` : canal ? `c${canal}` : null;
  if (clave === claveRuta) return;
  teardown();
  claveRuta = clave;
  intentos = 0;
  proximoIntento = Date.now() + 4000;
  diag = "";
  if (clave) arrancarRuta();
}

// ------------------------------------------------------- dialogo con el popup

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === "state") {
    respond({
      onVod: Boolean(currentVod),
      hasAudio: Boolean(track),
      status,
      enabled,
      nudge,
      volumen,
      volumenDeTwitch: webaudio,
      offset: baseOffset,
    });
    return;
  }

  if (msg.type === "setEnabled") {
    enabled = Boolean(msg.value);
    if (!enabled) {
      audio && audio.pause();
      if (video) callarVideo(false);
      setStatus("Desactivado — suena el audio del VOD");
    }
    respond({ ok: true });
    return;
  }

  if (msg.type === "setVolume") {
    volumen = Math.min(1, Math.max(0, Number(msg.value)));
    if (audio) audio.volume = volumen;
    chrome.storage.sync.set({ volumen });
    respond({ ok: true });
    return;
  }

  respond({ ok: false, error: "peticion desconocida" });
});

// El volumen elegido se recuerda entre VODs y entre sesiones.
chrome.storage.sync.get({ volumen: 1 }, (cfg) => {
  volumen = cfg.volumen;
  if (audio) audio.volume = volumen;
});

// Reintentos: al navegar dentro de Twitch el reproductor puede tardar en
// montarse, y en la portada de un canal la duracion tarda en poder leerse. Sin
// esto, un intento fallido no se repetiria nunca, porque la URL ya no cambia.
let ocupado = false;
let intentos = 0;
let proximoIntento = 0;
const MAX_INTENTOS = 6;

async function arrancarRuta() {
  if (ocupado) return;
  ocupado = true;
  try {
    const id = vodIdFromUrl();
    if (id) await enterVod(id);
    else {
      const canal = loginDeCanal();
      if (canal) await enterCanal(canal);
    }
  } finally {
    ocupado = false;
  }
}

// Twitch es una SPA: no hay recarga al navegar, hay que vigilar la URL.
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    onRouteChange();
    return;
  }
  if (!claveRuta || track || ocupado || intentos >= MAX_INTENTOS) return;
  if (Date.now() < proximoIntento) return;
  intentos += 1;
  proximoIntento = Date.now() + 4000;
  setDiag(`reintento ${intentos} de ${MAX_INTENTOS}`);
  arrancarRuta();
}, 500);

onRouteChange();
