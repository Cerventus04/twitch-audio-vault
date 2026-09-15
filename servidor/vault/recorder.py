"""Captura del audio del directo usando streamlink como libreria.

Se pide la variante `audio_only` que sirve el propio Twitch (AAC ~160 kbps).
Los bytes se escriben tal cual: no hay recodificacion, asi que no se pierde
calidad y el fichero es el audio original que sonaba en el directo.
"""
from __future__ import annotations

import datetime as dt
import logging
import re
import threading
from pathlib import Path
from urllib.parse import urljoin

import httpx
import streamlink
from streamlink.session import Streamlink

from . import config, db, mp4, tsdemux

log = logging.getLogger("vault.recorder")

CHUNK = 64 * 1024

# Nombre de canal: se queda solo con lo inequivocamente seguro.
SAFE_LOGIN = re.compile(r"[^A-Za-z0-9_.-]+")
# Titulo: Windows prohibe \ / : * ? " < > | y los caracteres de control.
PROHIBIDOS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
ESPACIOS = re.compile(r"\s+")
# Nombres reservados de MS-DOS que siguen vivos en Windows.
RESERVADOS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
# Margen para no pasarse del limite de ruta de Windows (260).
MAX_RUTA = 240


def _utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _session() -> Streamlink:
    s = Streamlink()
    # Sin anuncios pre-roll: evita que el fichero empiece con audio de publicidad.
    s.set_option("twitch-disable-ads", True)
    s.set_option("stream-timeout", 60.0)
    s.set_option("stream-segment-attempts", 5)
    s.set_option("stream-segment-timeout", 20.0)
    s.set_option("hls-live-restart", False)
    return s


def _pick(streams: dict, preference: str):
    for name in [p.strip() for p in preference.split(",") if p.strip()]:
        if name in streams:
            return name, streams[name]
    if streams:
        name = list(streams)[-1]
        return name, streams[name]
    return None, None


def retraso_del_borde(login: str) -> float:
    """Cuantos segundos por detras del directo empieza a leer streamlink.

    streamlink no se engancha al ultimo segmento sino unos cuantos por detras
    (`hls-live-edge`), para tener colchon. Ese retraso es justo el error que
    aparecia al calcular el desfase con la hora del reloj.
    """
    s = _session()
    streams = s.streams(f"https://twitch.tv/{login}")
    if not streams:
        raise RuntimeError("el canal no ofrece streams")
    _q, stream = _pick(streams, config.load()["audio_quality"])
    texto = httpx.get(stream.url, timeout=20).text
    duraciones = [float(x) for x in re.findall(r"#EXTINF:([\d.]+)", texto)]
    if not duraciones:
        raise RuntimeError("el playlist no trae duraciones")
    return (sum(duraciones) / len(duraciones)) * int(s.get_option("hls-live-edge"))


def duracion_del_vod(vod_id: str) -> float:
    """Segundos de VOD publicados ahora mismo (`EXT-X-TWITCH-TOTAL-SECS`).

    Es el ancla exacta: dice a que punto del VOD corresponde el borde del
    directo, sin depender de relojes ni de la latencia de la red.
    """
    s = _session()
    streams = s.streams(f"https://www.twitch.tv/videos/{vod_id}")
    if not streams:
        raise RuntimeError("el VOD no ofrece streams")
    _q, stream = _pick(streams, "audio,best")
    texto = httpx.get(stream.url, timeout=25).text
    m = re.search(r"TWITCH-TOTAL-SECS:([\d.]+)", texto)
    if not m:
        raise RuntimeError("el playlist del VOD no trae TOTAL-SECS")
    return float(m.group(1))


def constante_del_vod(vod_id: str) -> float:
    """Cuanto hay que restar al instante del contenido para obtener el
    segundo del VOD.

    Twitch numera el contenido con una marca de tiempo propia (PTS en MPEG-TS,
    `tfdt` en MP4 fragmentado) y el VOD usa esa misma numeracion desplazada por
    una constante. Se descarga un unico segmento, se mira su marca y se compara
    con el segundo en que ese segmento empieza. Medido sobre un directo real,
    la constante no variaba ni 5 milisegundos en tres horas.
    """
    s = _session()
    streams = s.streams(f"https://www.twitch.tv/videos/{vod_id}")
    if not streams:
        raise RuntimeError("el VOD no ofrece streams")
    _q, stream = _pick(streams, "audio,best")
    url = stream.url
    lineas = httpx.get(url, timeout=25).text.splitlines()
    base = url.rsplit("/", 1)[0] + "/"

    # En MP4 fragmentado la escala de tiempo vive en el segmento de
    # inicializacion, que el playlist declara aparte con EXT-X-MAP.
    init = b""
    for linea in lineas:
        if linea.startswith("#EXT-X-MAP:"):
            m = re.search(r'URI="([^"]+)"', linea)
            if m:
                init = httpx.get(urljoin(base, m.group(1)), timeout=40).content
            break

    inicio = 0.0
    elegido = None
    for i, linea in enumerate(lineas):
        if linea.startswith("#EXTINF:"):
            if elegido is None and inicio > 60:
                elegido = (inicio, lineas[i + 1])
                break
            inicio += float(linea.split(":")[1].rstrip(","))
    if elegido is None:
        raise RuntimeError("el VOD es demasiado corto para medir")

    datos = httpx.get(urljoin(base, elegido[1]), timeout=60).content

    if datos[:1] == b"G":  # MPEG-TS
        d = tsdemux.Demuxer()
        d.feed(datos)
        if d.primer_pts is None:
            raise RuntimeError("no se encontro PTS en el segmento del VOD")
        marca = d.primer_pts
    else:  # MP4 fragmentado
        marca = mp4.primer_tiempo(init + datos)
        if marca is None:
            raise RuntimeError("no se encontro tfdt en el segmento del VOD")

    return marca - elegido[0]


def limpiar_titulo(titulo: str, tope: int) -> str:
    """Convierte el titulo del directo en algo que Windows acepte.

    Quita los caracteres prohibidos, junta los espacios y corta por la ultima
    palabra que quepa, para no dejar la frase partida a mitad.
    """
    t = PROHIBIDOS.sub("", titulo or "")
    t = ESPACIOS.sub(" ", t).strip()
    # Windows no admite que un nombre acabe en punto o espacio.
    t = t.strip(" .")
    if not t:
        return ""
    if t.split()[0].upper() in RESERVADOS and len(t.split()) == 1:
        return ""
    if len(t) > tope:
        corte = t[:tope]
        espacio = corte.rfind(" ")
        t = (corte[:espacio] if espacio > tope * 0.6 else corte).strip(" .")
    return t


def target_path(login: str, started: dt.datetime, titulo: str = "") -> Path:
    """Ruta del fichero: `grabaciones/<canal>/<fecha> - <titulo>.aac`.

    La fecha va delante para que el listado quede en orden cronologico; el
    titulo es lo que hace el nombre reconocible de un vistazo.
    """
    carpeta = config.audio_dir() / SAFE_LOGIN.sub("_", login.lower())
    stamp = started.astimezone(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")

    # Lo que sobra hasta el limite de ruta se reparte al titulo.
    margen = MAX_RUTA - len(str(carpeta)) - len(stamp) - len(" - ") - len(".aac") - 6
    titulo_limpio = limpiar_titulo(titulo, margen) if margen >= 12 else ""

    base = f"{stamp} - {titulo_limpio}" if titulo_limpio else stamp
    ruta = carpeta / f"{base}.aac"

    # Dos directos pueden empezar el mismo segundo tras una reconexion.
    n = 2
    while ruta.exists():
        ruta = carpeta / f"{base} ({n}).aac"
        n += 1
    return ruta


class Recording(threading.Thread):
    """Graba un directo hasta que termina o hasta que se pide parar."""

    def __init__(self, login: str, stream_info: dict):
        super().__init__(name=f"rec-{login}", daemon=True)
        self.login = login.lower()
        self.stream_info = stream_info
        self.stop_event = threading.Event()
        self.recording_id: int | None = None
        self.path: Path | None = None
        self.bytes_written = 0
        self.error: str | None = None

    # -- ciclo de vida -------------------------------------------------

    def stop(self) -> None:
        self.stop_event.set()

    def run(self) -> None:
        try:
            self._record()
        except Exception as exc:  # noqa: BLE001 - se guarda para mostrarlo en la UI
            self.error = f"{type(exc).__name__}: {exc}"
            self._finish("error")
        else:
            # Si se pidio parar, el directo seguia y la grabacion queda a
            # medias: cerrar el programa o dejar de vigilar el canal no es lo
            # mismo que un directo que termina solo.
            self._finish("interrumpida" if self.stop_event.is_set() else "done")

    # -- interno -------------------------------------------------------

    def _record(self) -> None:
        cfg = config.load()
        session = _session()
        streams = session.streams(f"https://twitch.tv/{self.login}")
        if not streams:
            raise RuntimeError("el canal no ofrece streams (puede haber terminado)")

        quality, stream = _pick(streams, cfg["audio_quality"])
        started = dt.datetime.now(dt.timezone.utc)
        self.path = target_path(
            self.login, started, self.stream_info.get("title") or ""
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)

        canal = db.one(
            "SELECT display_name, avatar_url FROM channels WHERE login=?",
            (self.login,),
        ) or {}
        with db.tx() as conn:
            cur = conn.execute(
                """INSERT INTO recordings
                   (login, stream_id, title, capture_start, stream_start, path,
                    status, display_name, avatar_url)
                   VALUES (?,?,?,?,?,?,'recording',?,?)""",
                (
                    self.login,
                    self.stream_info.get("id"),
                    self.stream_info.get("title"),
                    started.isoformat(timespec="seconds"),
                    self.stream_info.get("started_at"),
                    str(self.path),
                    canal.get("display_name"),
                    canal.get("avatar_url"),
                ),
            )
            self.recording_id = cur.lastrowid

        fd = stream.open()
        demuxer = tsdemux.Demuxer()
        crudo = False  # se activa si el flujo no viene en MPEG-TS
        primero = True
        marca_guardada = False
        lector_mp4 = mp4.Lector()
        try:
            with open(self.path, "wb") as out:
                last_flush = 0
                while not self.stop_event.is_set():
                    data = fd.read(CHUNK)
                    if not data:
                        break  # el directo termino
                    if primero:
                        # Twitch manda MPEG-TS, pero si algun dia cambiara se
                        # guarda tal cual antes que guardar basura.
                        crudo = data[:1] != b"\x47"
                        primero = False
                        if crudo:
                            log.info(
                                "%s emite en MP4 fragmentado (Emision Mejorada): "
                                "se guarda tal cual", self.login,
                            )
                    # Los navegadores no reproducen MPEG-TS, asi que se le
                    # quita la envoltura y se guarda el AAC (ADTS) de dentro.
                    if crudo:
                        # MP4 fragmentado: se guarda tal cual (el navegador lo
                        # reproduce) y la marca de tiempo se lee de `tfdt`.
                        trozo = data
                        lector_mp4.feed(data)
                        marca = lector_mp4.tiempo
                    else:
                        trozo = demuxer.feed(data)
                        marca = demuxer.primer_pts
                    if not trozo:
                        continue
                    out.write(trozo)
                    self.bytes_written += len(trozo)
                    if marca is not None and not marca_guardada:
                        self._guardar_pts(marca)
                        marca_guardada = True
                    # Cada ~4 MB se refresca el progreso y se baja a disco, para
                    # que un corte de luz no se lleve la grabacion entera.
                    if self.bytes_written - last_flush >= 4 * 1024 * 1024:
                        out.flush()
                        last_flush = self.bytes_written
                        self._touch()

                # Lo que quedara a medias en el ultimo paquete.
                if not crudo:
                    cola = demuxer.flush()
                    if cola:
                        out.write(cola)
                        self.bytes_written += len(cola)
        finally:
            fd.close()

    def _guardar_pts(self, pts: float) -> None:
        if self.recording_id is None:
            return
        with db.tx() as conn:
            conn.execute(
                "UPDATE recordings SET first_pts=? WHERE id=?", (pts, self.recording_id)
            )
        log.info("%s: el audio empieza en el segundo %.3f del directo",
                 self.login, pts)

    def _touch(self) -> None:
        if self.recording_id is None:
            return
        with db.tx() as conn:
            conn.execute(
                "UPDATE recordings SET bytes=? WHERE id=?",
                (self.bytes_written, self.recording_id),
            )

    def _finish(self, status: str) -> None:
        if self.recording_id is None:
            return
        row = db.one(
            "SELECT capture_start FROM recordings WHERE id=?", (self.recording_id,)
        )
        duration = None
        if row:
            start = dt.datetime.fromisoformat(row["capture_start"])
            duration = (dt.datetime.now(dt.timezone.utc) - start).total_seconds()
        with db.tx() as conn:
            conn.execute(
                """UPDATE recordings
                   SET status=?, error=?, bytes=?, capture_end=?, duration_seconds=?
                   WHERE id=?""",
                (
                    status,
                    self.error,
                    self.bytes_written,
                    _utcnow(),
                    duration,
                    self.recording_id,
                ),
            )
