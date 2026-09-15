"""Servidor local: API JSON + interfaz web + servido del audio con Range."""
from __future__ import annotations

import datetime as dt
import logging
import mimetypes
import os
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import adts, auth, config, db, mp4idx, twitch, watcher

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")

app = FastAPI(title="Twitch Audio Vault", docs_url=None, redoc_url=None)

app.middleware("http")(auth.middleware)


@app.middleware("http")
async def _sin_cache_en_el_panel(request: Request, call_next):
    """Obliga a comprobar si el panel ha cambiado en cada carga.

    Sin `Cache-Control` el navegador se inventa cuanto tiempo dar por bueno un
    fichero, y con uno recien tocado eso significa seguir enseñando el de antes
    aunque recargues. Aqui el servidor esta en la misma maquina, asi que
    comprobarlo no cuesta nada: con el ETag la respuesta suele ser un 304 de
    tres bytes.

    El audio se queda fuera: son ficheros grandes que no cambian y que ademas
    se piden por trozos.
    """
    respuesta = await call_next(request)
    if not request.url.path.startswith("/audio/"):
        respuesta.headers.setdefault("Cache-Control", "no-cache")
    return respuesta

# Solo la extension (chrome-extension://), las paginas de Twitch donde corre el
# content script, localhost y, si se despliega en un servidor, el dominio
# propio. No se abre a "*" para que una web cualquiera no pueda sondear el
# servidor: cualquier pestaña abierta en el navegador alcanza esta maquina.
_dominio = os.environ.get("VAULT_PUBLIC_ORIGIN", "")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|moz-extension)://[a-z0-9-]+$"
    # La pagina de Twitch pide el audio y lee X-Dura-Real directamente, sin
    # pasar por el service worker, asi que necesita leer las respuestas.
    r"|^https://(www\.)?twitch\.tv$"
    # Chrome resuelve cualquier *.localhost a la maquina local y lo considera
    # origen de confianza, asi que vale un nombre bonito sin tocar el hosts.
    r"|^https?://([a-z0-9-]+\.)?(localhost|127\.0\.0\.1)(:\d+)?$"
    + (f"|^{re.escape(_dominio)}$" if _dominio else ""),
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=[
        "Content-Range", "Accept-Ranges", "Content-Length", "X-Dura-Real",
    ],
)


@app.on_event("startup")
def _startup() -> None:
    db.init()
    watcher.start()


# ---------------------------------------------------------------- estado


@app.get("/api/status")
def status() -> dict:
    w = watcher.current()
    cfg = config.load()
    return {
        "credentials_set": bool(cfg["client_id"] and cfg["client_secret"]),
        "watching": sorted(w.active) if w else [],
        "last_poll": w.last_poll if w else None,
        "last_error": w.last_error if w else None,
        "audio_dir": cfg["audio_dir"],
        "poll_seconds": cfg["poll_seconds"],
        "retention_days": cfg["retention_days"],
        "disk_used_bytes": _disk_used(),
    }


def _disk_used() -> int:
    total = 0
    for root, _dirs, files in os.walk(config.audio_dir()):
        for f in files:
            if f.endswith(".aac"):
                total += (Path(root) / f).stat().st_size
    return total


# ---------------------------------------------------------- configuracion


@app.get("/api/config")
def get_config() -> dict:
    cfg = config.load()
    # El secreto no vuelve al navegador; solo si esta puesto o no.
    cfg["client_secret"] = "********" if cfg["client_secret"] else ""
    return cfg


@app.post("/api/config")
def set_config(payload: dict = Body(...)) -> dict:
    if payload.get("client_secret") == "********":
        payload.pop("client_secret")
    config.save(payload)
    result: dict = {"ok": True}
    cfg = config.load()
    if cfg["client_id"] and cfg["client_secret"]:
        try:
            twitch.check_credentials()
            result["credentials"] = "ok"
        except twitch.TwitchError as exc:
            result["credentials"] = str(exc)
    return result


# ---------------------------------------------------------------- canales


@app.get("/api/channels")
def list_channels() -> list[dict]:
    rows = db.query("SELECT * FROM channels ORDER BY login")
    w = watcher.current()
    active = set(w.active) if w else set()
    for r in rows:
        r["recording"] = r["login"] in active
    return rows


@app.post("/api/channels")
def add_channel(payload: dict = Body(...)) -> dict:
    login = str(payload.get("login", "")).strip().lower()
    # Se acepta pegar la URL completa del canal.
    login = login.replace("https://", "").replace("http://", "")
    login = login.replace("www.twitch.tv/", "").replace("twitch.tv/", "").strip("/")
    if not re.fullmatch(r"[a-z0-9_]{3,25}", login):
        raise HTTPException(400, "Nombre de canal no valido")

    try:
        found = twitch.users([login])
    except twitch.TwitchError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not found:
        raise HTTPException(404, f"El canal '{login}' no existe en Twitch")
    u = found[0]

    with db.tx() as conn:
        conn.execute(
            """INSERT INTO channels (login, user_id, display_name, avatar_url, added_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(login) DO UPDATE SET
                   user_id=excluded.user_id,
                   display_name=excluded.display_name,
                   avatar_url=excluded.avatar_url,
                   enabled=1""",
            (
                u["login"].lower(),
                u["id"],
                u["display_name"],
                u.get("profile_image_url"),
                dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            ),
        )
    return {"ok": True, "login": u["login"].lower()}


@app.patch("/api/channels/{login}")
def toggle_channel(login: str, payload: dict = Body(...)) -> dict:
    with db.tx() as conn:
        conn.execute(
            "UPDATE channels SET enabled=? WHERE login=?",
            (1 if payload.get("enabled") else 0, login.lower()),
        )
    return {"ok": True}


@app.delete("/api/channels/{login}")
def remove_channel(login: str) -> dict:
    with db.tx() as conn:
        conn.execute("DELETE FROM channels WHERE login=?", (login.lower(),))
    return {"ok": True}


# ------------------------------------------------------------ grabaciones


@app.get("/api/recordings")
def list_recordings(login: str | None = None) -> list[dict]:
    # Si el canal se dejo de vigilar ya no hay ficha, asi que se recurre a la
    # copia que se guardo con la grabacion.
    sql = """SELECT r.*,
                    COALESCE(c.display_name, r.display_name) AS display_name,
                    COALESCE(c.avatar_url, r.avatar_url)     AS avatar_url
             FROM recordings r LEFT JOIN channels c ON c.login = r.login"""
    params: tuple = ()
    if login:
        sql += " WHERE r.login=?"
        params = (login.lower(),)
    sql += " ORDER BY r.capture_start DESC LIMIT 500"
    rows = db.query(sql, params)
    for r in rows:
        r["exists"] = Path(r["path"]).exists()
        r["effective_offset"] = (
            r["offset_override"]
            if r["offset_override"] is not None
            else (r["vod_offset"] or 0.0)
        )
    return rows


@app.patch("/api/recordings/{rec_id}")
def update_recording(rec_id: int, payload: dict = Body(...)) -> dict:
    if "offset_override" in payload:
        value = payload["offset_override"]
        with db.tx() as conn:
            conn.execute(
                "UPDATE recordings SET offset_override=? WHERE id=?",
                (None if value is None else float(value), rec_id),
            )
    return {"ok": True}


@app.delete("/api/recordings/{rec_id}")
def delete_recording(rec_id: int) -> dict:
    row = db.one("SELECT path, login, status FROM recordings WHERE id=?", (rec_id,))
    if not row:
        raise HTTPException(404, "No existe esa grabacion")

    # Windows no deja borrar un fichero abierto, asi que si la grabacion sigue
    # en marcha primero se corta el hilo y se espera a que cierre el fichero.
    if row["status"] == "recording":
        w = watcher.current()
        rec = w.active.get(row["login"]) if w else None
        if rec and rec.recording_id == rec_id:
            rec.stop()
            rec.join(timeout=15)
            if rec.is_alive():
                raise HTTPException(
                    409,
                    "La grabacion no ha terminado de cerrarse. "
                    "Prueba otra vez en unos segundos.",
                )

    try:
        p = Path(row["path"])
        p.unlink(missing_ok=True)
        # El indice de tiempos que se genera al vuelo se va con el audio.
        p.with_suffix(p.suffix + ".idx").unlink(missing_ok=True)
    except PermissionError:
        raise HTTPException(
            409,
            "El fichero esta en uso. Si lo tienes abierto en un reproductor, "
            "cierralo y vuelve a intentarlo.",
        ) from None

    with db.tx() as conn:
        conn.execute("DELETE FROM recordings WHERE id=?", (rec_id,))
    return {"ok": True}


@app.get("/api/auth")
def auth_required() -> dict:
    """Publico: dice si el panel debe pedir contraseña."""
    return {"required": bool(auth.token())}


@app.post("/api/auth")
def auth_login(payload: dict = Body(...)) -> dict:
    esperado = auth.token()
    if not esperado:
        return {"ok": True, "required": False}
    if secrets.compare_digest(str(payload.get("token", "")), esperado):
        return {"ok": True, "required": True}
    raise HTTPException(401, "Contraseña incorrecta")


# Segundos de audio que se sirven en la primera carga. Cuanto mas corta, antes
# suena; pero antes hay que relevarla.
#
# Las medidas originales se hicieron sirviendo desde localhost, donde bajar los
# bytes era gratis y solo contaba lo que tardaba el navegador en analizarlos.
# Con el servidor al otro lado de una red domestica manda el tamano: a 4,5 MB/s
# (Wi-Fi de 2,4 GHz) una ventana de 300 s son 7,3 MB y ~1,6 s de espera antes de
# oir nada. A 90 s baja a ~2,2 MB y medio segundo.
VENTANA_MP4 = 30
# El AAC crudo tambien la necesita, y por la misma razon: sin ella se sirve
# desde el corte HASTA EL FINAL del fichero, que en una grabacion de horas son
# cientos de megas ocupando el enlace mientras suena.
VENTANA_AAC = 30

_DURACION = re.compile(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?")
# Las duraciones de un canal cambian poco y la portada se visita a menudo:
# se guardan un rato para no gastar una llamada a Twitch en cada visita.
_cache_canal: dict[str, tuple[float, list[dict]]] = {}
_CACHE_SEGUNDOS = 120


def _segundos(texto: str) -> int:
    """Convierte la duracion de Twitch ("3h22m10s") a segundos."""
    m = _DURACION.fullmatch((texto or "").strip())
    if not m:
        return 0
    h, mi, se = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + se


@app.get("/api/canal")
def match_canal(login: str) -> dict:
    """VODs grabados de un canal, con su duracion, mas reciente primero.

    En la portada de un canal Twitch reproduce el ultimo directo emitido, pero
    la URL no dice cual es. La extension lo averigua comparando la duracion del
    reproductor con esta lista: es la unica pista fiable que hay sin depender
    de como este montada la pagina, que Twitch cambia cuando quiere.
    """
    login = login.lower()
    ahora = time.time()
    guardado = _cache_canal.get(login)
    if guardado and ahora - guardado[0] < _CACHE_SEGUNDOS:
        return {"videos": guardado[1]}

    mios = {
        r["vod_id"]
        for r in db.query(
            """SELECT DISTINCT vod_id FROM recordings
               WHERE login=? AND vod_id IS NOT NULL AND status!='error'""",
            (login,),
        )
    }
    if not mios:
        _cache_canal[login] = (ahora, [])
        return {"videos": []}

    fila = db.one("SELECT user_id FROM channels WHERE login=?", (login,))
    user_id = fila["user_id"] if fila and fila["user_id"] else None
    if not user_id:
        # El canal pudo dejar de vigilarse: sus grabaciones siguen valiendo.
        gente = twitch.users([login])
        user_id = gente[0]["id"] if gente else None
    if not user_id:
        return {"videos": []}

    videos = [
        {"vod": v["id"], "duracion": _segundos(v.get("duration", ""))}
        for v in twitch.archives(user_id, limit=40)
        if v["id"] in mios
    ]
    _cache_canal[login] = (ahora, videos)
    return {"videos": videos}


@app.get("/api/match")
def match_vod(vod: str, request: Request) -> dict:
    """Trozos de audio grabado que cubren ese VOD, en orden.

    Normalmente es uno solo, pero un directo puede quedar partido en varios
    ficheros: si el programa se cierra o el PC se reinicia a mitad, la captura
    continua en uno nuevo. Cada trozo dice que tramo del VOD cubre, y la
    extension va cambiando de uno a otro segun avanza la reproduccion.

    Entre trozo y trozo hay un hueco real —el tiempo que estuvo caido— que se
    deja como tal: ahi suena el audio del propio VOD.
    """
    filas = db.query(
        """SELECT * FROM recordings
           WHERE vod_id=? AND status!='error'
           ORDER BY capture_start""",
        (vod,),
    )

    # Un <audio> no puede mandar cabeceras, asi que la contraseña viaja en la
    # URL. Se reutiliza la que el cliente acaba de usar para llegar aqui.
    sufijo = ""
    if auth.token():
        dado = request.headers.get(auth.CABECERA) or request.query_params.get(
            auth.PARAMETRO, ""
        )
        sufijo = f"?{auth.PARAMETRO}={quote(dado)}"

    trozos = []
    for row in filas:
        if not Path(row["path"]).exists():
            continue
        inicio = (
            row["offset_override"]
            if row["offset_override"] is not None
            else (row["vod_offset"] or 0.0)
        )
        duracion = row["duration_seconds"]
        # En MP4 fragmentado el reproductor NO empieza a contar en cero: usa la
        # linea temporal absoluta del contenido, que arranca en la marca del
        # primer fragmento. Hay que decirle a la extension donde empieza cada
        # fichero para que pida la posicion correcta.
        #
        # Ninguno de los dos formatos trae tabla de busqueda: el AAC crudo no
        # tiene ninguna, y un fMP4 grabado en directo no lleva `sidx` ni
        # `mfra`. En los dos hay que recorrer el fichero para saltar, asi que
        # el servidor los entrega recortados desde un multiplo de la
        # granularidad y el navegador recibe algo corto.
        origen = 0.0
        absoluto = False
        ventana = 0
        if _tipo_de_audio(Path(row["path"])) == "audio/mp4":
            origen = row["first_pts"] or 0.0
            absoluto = True
            # Medido en Chrome sobre una grabacion de 3 h servida desde
            # localhost: saltar dentro del MP4 ya cargado cuesta 0-320 ms,
            # mientras que recargarlo recortado cuesta 580-790 ms. Con el
            # fichero al lado se descarga entero en un instante, asi que
            # recortar solo añade el coste de rehacer el reproductor.
            #
            # El ADTS es otra historia: ahi el salto en sitio cuesta 1023 ms
            # aunque el fichero este entero en memoria, porque hay que rastrear
            # las tramas. Por eso ese si se recorta.
            #
            # `/audio` sabe recortar MP4 igualmente (ver `mp4idx`), que es lo
            # que haria falta si el servidor estuviera lejos y descargar 300 MB
            # dejara de ser gratis.
            # Con ventana corta el navegador arranca en ~90 ms en vez de los
            # ~580 ms que cuesta analizar la cola entera (medido sobre 3 h de
            # grabacion). La extension carga esa ventana para sonar en el acto
            # y prepara detras el resto, que releva al primero justo donde se
            # acaba, sin corte.
            granularidad = mp4idx.GRANULARIDAD
            ventana = VENTANA_MP4
        else:
            granularidad = adts.GRANULARIDAD
            # El ADTS recortado arranca en ~340 ms, pero sin ventana llega
            # hasta el final del fichero. Sirviendolo por red eso son cientos
            # de megas por cada salto, asi que aqui tambien se acota y se deja
            # que el relevo traiga el resto por detras.
            ventana = VENTANA_AAC

        trozos.append(
            {
                "id": row["id"],
                "inicio": inicio,
                "origen": origen,
                "granularidad": granularidad,
                "absoluto": absoluto,
                "ventana": ventana,
                # Si sigue grabando aun no se sabe donde acaba: lo resuelve el
                # navegador leyendo la duracion real del fichero.
                "fin": (inicio + duracion) if duracion else None,
                "duracion": duracion,
                "parcial": row["status"] == "interrumpida",
                "audio_url": f"/audio/{row['id']}{sufijo}",
            }
        )

    if not trozos:
        return {"found": False}

    trozos.sort(key=lambda t: t["inicio"])
    primero = trozos[0]
    return {
        "found": True,
        "login": filas[0]["login"],
        "title": filas[0]["title"],
        "segments": trozos,
        # Campos del primer trozo, por si algo espera el formato antiguo.
        "id": primero["id"],
        "offset": primero["inicio"],
        "duration": primero["duracion"],
        "audio_url": primero["audio_url"],
    }


# ------------------------------------------------------------------ audio


def _trozo(path: Path, cabecera: bytes, principio: int, start: int, end: int):
    """Bytes del fichero servido, ambos extremos incluidos.

    Lo que se sirve puede no ser el fichero tal cual: en MP4 fragmentado va
    `cabecera` (el segmento de inicializacion) pegada delante de lo que hay a
    partir de `principio`. `start` y `end` cuentan sobre ese fichero de
    mentira, que es el unico que el navegador ve y sobre el que pide Range.
    """
    quedan = end - start + 1
    n = len(cabecera)
    if start < n:
        parte = cabecera[start : min(n, end + 1)]
        quedan -= len(parte)
        yield parte
        pos = principio
    else:
        pos = principio + (start - n)

    if quedan <= 0:
        return
    with open(path, "rb") as fh:
        fh.seek(pos)
        while quedan > 0:
            datos = fh.read(min(256 * 1024, quedan))
            if not datos:
                break
            quedan -= len(datos)
            yield datos


def _tipo_de_audio(path: Path) -> str:
    """Tipo MIME segun lo que haya de verdad dentro del fichero."""
    with open(path, "rb") as fh:
        cabecera = fh.read(12)
    if cabecera[4:8] == b"ftyp":
        return "audio/mp4"
    if cabecera[:1] == b"G":
        # MPEG-TS: ningun navegador lo reproduce, pero se declara con
        # honestidad en vez de mentir con un tipo que si soportan.
        return "video/mp2t"
    return "audio/aac"


@app.get("/audio/{rec_id}")
def serve_audio(rec_id: int, request: Request, desde: float = 0, dura: float = 0):
    """Sirve el audio con soporte de Range: sin esto no se puede hacer seek.

    Con `desde` se entrega recortado a partir de ese segundo, redondeado hacia
    abajo a un multiplo de la granularidad del indice. Sirve para que saltar
    dentro de un fichero largo sea instantaneo en vez de rastrearlo entero.
    """
    row = db.one("SELECT path FROM recordings WHERE id=?", (rec_id,))
    if not row:
        raise HTTPException(404, "No existe esa grabacion")
    path = Path(row["path"])
    if not path.exists():
        raise HTTPException(404, "El fichero de audio ya no esta en disco")

    # Twitch entrega unas veces MPEG-TS (que demultiplexamos a ADTS) y otras
    # MP4 fragmentado. Se mira la cabecera del fichero en vez de fiarse de la
    # extension: si el tipo no cuadra, el navegador no lo reproduce.
    media = _tipo_de_audio(path)

    # Recorte por tiempo. Los dos formatos lo necesitan, pero se hace distinto:
    # el AAC crudo es un corte limpio de bytes, mientras que en MP4 fragmentado
    # hay que pegar delante el segmento de inicializacion (ftyp + moov), sin el
    # cual los fragmentos no se pueden descodificar.
    principio = 0
    cabecera = b""
    fin = 0  # 0 = hasta el final del fichero
    dura_real = 0.0
    if (desde > 0 or dura > 0) and media == "audio/aac":
        try:
            principio, fin, dura_real = adts.tramo(path, desde, dura)
        except Exception:  # noqa: BLE001 - si el indice falla, se sirve entero
            principio, fin, dura_real = 0, 0, 0.0
    elif (desde > 0 or dura > 0) and media == "audio/mp4":
        try:
            init, principio, fin, dura_real = mp4idx.corte(path, desde, dura)
            with open(path, "rb") as fh:
                fh.seek(init[0])
                cabecera = fh.read(init[1] - init[0])
        except Exception:  # noqa: BLE001
            principio, cabecera, fin, dura_real = 0, b"", 0, 0.0

    size = (fin or path.stat().st_size) - principio + len(cabecera)
    # Lo servido casi nunca dura los segundos pedidos: los dos extremos caen
    # en marcas del indice. Sin este dato el cliente programaba el relevo con
    # la duracion nominal, se pasaba del final real del tramo y sonaba un
    # corte seco. Va en `expose_headers` para que la extension pueda leerlo.
    comunes = {"Accept-Ranges": "bytes"}
    if dura_real > 0:
        comunes["X-Dura-Real"] = f"{dura_real:.3f}"
    range_header = request.headers.get("range")

    if not range_header:
        # El atajo solo vale sirviendo el fichero entero: con ventana hay que
        # respetar el recorte.
        if principio == 0 and not cabecera and not fin:
            return FileResponse(path, media_type=media, headers=comunes)
        return StreamingResponse(
            _trozo(path, cabecera, principio, 0, size - 1),
            media_type=media,
            headers={**comunes, "Content-Length": str(size)},
        )

    m = RANGE_RE.fullmatch(range_header.strip())
    if not m:
        raise HTTPException(416, "Range mal formado")
    raw_start, raw_end = m.groups()
    if raw_start:
        start = int(raw_start)
        end = int(raw_end) if raw_end else size - 1
    else:
        # Forma "bytes=-N": los ultimos N bytes.
        start = max(0, size - int(raw_end or 0))
        end = size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        return Response(
            status_code=416, headers={"Content-Range": f"bytes */{size}"}
        )

    return StreamingResponse(
        _trozo(path, cabecera, principio, start, end),
        status_code=206,
        media_type=media,
        headers={
            **comunes,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
        },
    )


@app.post("/api/quit")
def quit_app() -> dict:
    """Cierra el programa. Sin consola no hay Ctrl+C, asi que hace falta esto."""

    def shutdown() -> None:
        w = watcher.current()
        if w:
            w.stop()
            # Se da margen a que las grabaciones en curso cierren su fichero.
            for rec in list(w.active.values()):
                rec.join(timeout=8)
        os._exit(0)

    threading.Timer(0.4, shutdown).start()
    return {"ok": True}


@app.exception_handler(twitch.TwitchError)
def _twitch_error(_request: Request, exc: twitch.TwitchError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(Exception)
def _unhandled(_request: Request, exc: Exception):
    """Cualquier fallo no previsto sale como JSON.

    Por defecto FastAPI devuelve un "Internal Server Error" en texto plano, que
    el panel intenta interpretar como JSON y acaba enseñando un error de
    sintaxis en vez del problema real.
    """
    logging.getLogger("vault.server").exception("fallo no controlado")
    return JSONResponse(
        {"detail": f"Error interno: {type(exc).__name__}: {exc}"}, status_code=500
    )


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
