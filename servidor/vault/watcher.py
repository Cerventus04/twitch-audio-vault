"""Vigilante: consulta quien esta en directo y arranca/para las grabaciones.

Ademas resuelve a que VOD corresponde cada grabacion (Helix expone el
`stream_id` del VOD, asi que el emparejamiento es exacto, no por hora) y
aplica la politica de retencion.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import threading
import time
from pathlib import Path

from . import adts, config, db, mp4idx, recorder, twitch

log = logging.getLogger("vault.watcher")


def _modulo_indice(audio: Path):
    """Que indexador le toca al fichero, mirando lo que hay dentro."""
    try:
        with open(audio, "rb") as fh:
            cabecera = fh.read(12)
    except OSError:
        return None, ""
    if cabecera[4:8] == b"ftyp":
        return mp4idx, ".m4idx"
    if cabecera[:1] and cabecera[0] == 0xFF:
        return adts, ".idx"
    return None, ""


def _indice_al_dia(audio: Path, sufijo: str) -> bool:
    """True si el indice guardado cubre ya todo el fichero."""
    cache = audio.with_suffix(audio.suffix + sufijo)
    if not cache.exists():
        return False
    try:
        datos = json.loads(cache.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    try:
        return datos.get("bytes") == audio.stat().st_size
    except OSError:
        return False


class Watcher(threading.Thread):
    def __init__(self):
        super().__init__(name="watcher", daemon=True)
        self.active: dict[str, recorder.Recording] = {}
        self.stop_event = threading.Event()
        self.last_error: str | None = None
        self.last_poll: str | None = None

    def stop(self) -> None:
        self.stop_event.set()
        for rec in list(self.active.values()):
            rec.stop()

    def run(self) -> None:
        db.init()
        # Cuando se intento por ultima vez afinar el desfase de cada VOD, para
        # no insistir cada 30 s con uno que ya no existe.
        self._afinado_fallido: dict[str, float] = {}
        self._cerrar_huerfanas()
        while not self.stop_event.is_set():
            try:
                self._tick()
                self.last_error = None
            except twitch.TwitchError as exc:
                self.last_error = str(exc)
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"{type(exc).__name__}: {exc}"
                log.exception("fallo en el ciclo del watcher")
            try:
                self._calentar_indices()
            except Exception:  # noqa: BLE001 - calentar nunca debe romper el ciclo
                log.debug("fallo calentando indices", exc_info=True)
            self.last_poll = dt.datetime.now(dt.timezone.utc).isoformat(
                timespec="seconds"
            )
            self.stop_event.wait(max(15, int(config.load()["poll_seconds"])))

    def _calentar_indices(self) -> None:
        """Mantiene los indices al dia para que el primer salto no espere.

        Un indice frio obliga a recorrer el fichero entero en la primera
        peticion de audio: medido, 9,4 s en una grabacion de 645 MB, y el
        navegador se come esa espera antes de oir nada. Aqui se adelanta ese
        trabajo en segundo plano.

        Las grabaciones en curso se refrescan en cada ciclo: como el indice es
        incremental, solo se leen los bytes nuevos y cuesta milisegundos. Las
        que esten frias se calientan de UNA EN UNA, porque esa si es una
        lectura grande y no conviene amontonarlas mientras alguien reproduce
        (en este equipo el disco es el recurso escaso).
        """
        frias: list[tuple] = []
        for row in db.query(
            "SELECT path, status FROM recordings ORDER BY id DESC LIMIT 60"
        ):
            if not row["path"]:
                continue
            audio = Path(row["path"])
            if not audio.exists():
                continue
            mod, sufijo = _modulo_indice(audio)
            if mod is None:
                continue
            if row["status"] == "recording":
                self._indexar(mod, audio)
            elif not _indice_al_dia(audio, sufijo):
                frias.append((mod, audio))
        if frias:
            mod, audio = frias[0]
            log.info("calentando el indice de %s", audio.name)
            self._indexar(mod, audio)

    @staticmethod
    def _indexar(mod, audio: Path) -> None:
        try:
            mod.indice(audio)
        except Exception as exc:  # noqa: BLE001 - calentar es opcional
            log.debug("no se pudo calentar el indice de %s: %s", audio.name, exc)

    def _cerrar_huerfanas(self) -> None:
        """Cierra grabaciones que quedaron a medias al apagarse el programa.

        Si el PC se reinicia o se corta la luz durante un directo, el hilo que
        escribia muere sin poder marcar la fila como terminada. Al arrancar de
        nuevo esas filas siguen diciendo "grabando", y ademas el vigilante
        empieza otra grabacion del mismo directo: acabas viendo dos entradas
        activas cuando solo una lo esta.

        La hora de la ultima escritura del fichero es justo cuando se corto,
        asi que sirve para reconstruir duracion y tamano.
        """
        pendientes = db.query("SELECT * FROM recordings WHERE status='recording'")
        for row in pendientes:
            ruta = Path(row["path"])
            fin = dt.datetime.now(dt.timezone.utc)
            tam = row["bytes"]
            if ruta.exists():
                tam = ruta.stat().st_size
                fin = dt.datetime.fromtimestamp(ruta.stat().st_mtime, dt.timezone.utc)
            inicio = dt.datetime.fromisoformat(row["capture_start"])
            with db.tx() as conn:
                conn.execute(
                    """UPDATE recordings
                       SET status='interrumpida', bytes=?, capture_end=?,
                           duration_seconds=?
                       WHERE id=?""",
                    (
                        tam,
                        fin.isoformat(timespec="seconds"),
                        max(0.0, (fin - inicio).total_seconds()),
                        row["id"],
                    ),
                )
            log.info(
                "grabacion %s de %s quedo a medias: cerrada con %.1f min",
                row["id"], row["login"], (fin - inicio).total_seconds() / 60,
            )

    # -- ciclo ---------------------------------------------------------

    def _tick(self) -> None:
        # Los hilos que ya terminaron se sacan del registro de activos.
        for login, rec in list(self.active.items()):
            if not rec.is_alive():
                del self.active[login]

        channels = db.query("SELECT login FROM channels WHERE enabled=1")
        logins = [c["login"] for c in channels]

        # Si un canal deja de estar vigilado (borrado o pausado) mientras se
        # graba, hay que cortar su hilo: si no, seguiria capturando para
        # siempre y dejaria el fichero bloqueado.
        for login in list(self.active):
            if login not in logins:
                log.info("%s ya no esta vigilado: se para su grabacion", login)
                self.active[login].stop()

        if logins:
            live = twitch.live_streams(logins)
            for login in logins:
                info = live.get(login)
                if info and login not in self.active:
                    self._start(login, info)
                elif not info and login in self.active:
                    # Ya no aparece en directo: el hilo terminara solo cuando el
                    # HLS se agote, pero se le pide parar para no esperar.
                    self.active[login].stop()

        self._resolve_vods()
        self._afinar_desfases()
        self._apply_retention()

    def _start(self, login: str, info: dict) -> None:
        log.info("empieza directo de %s: %s", login, info.get("title"))
        rec = recorder.Recording(login, info)
        self.active[login] = rec
        rec.start()

    # -- emparejado con el VOD ----------------------------------------

    def _resolve_vods(self) -> None:
        pending = db.query(
            """SELECT r.id, r.login, r.stream_id, r.capture_start,
                      r.status, r.first_pts, c.user_id
               FROM recordings r JOIN channels c ON c.login = r.login
               -- Tambien las que siguen grabando: Twitch publica el VOD
               -- mientras el directo esta en el aire, asi que se puede usar
               -- lo capturado hasta ahora sin esperar a que termine.
               WHERE r.vod_id IS NULL AND r.status IN ('done','error','recording','interrumpida')
                 AND r.capture_start > ?""",
            ((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=3)).isoformat(),),
        )
        by_user: dict[str, list[dict]] = {}
        for row in pending:
            if row["user_id"] and row["stream_id"]:
                by_user.setdefault(row["user_id"], []).append(row)

        for user_id, rows in by_user.items():
            try:
                vods = twitch.archives(user_id, limit=40)
            except twitch.TwitchError:
                continue
            index = {v.get("stream_id"): v for v in vods if v.get("stream_id")}
            for row in rows:
                vod = index.get(row["stream_id"])
                if not vod:
                    continue
                offset, metodo = self._calcular_desfase(row, vod)
                with db.tx() as conn:
                    conn.execute(
                        """UPDATE recordings
                           SET vod_id=?, vod_created_at=?, vod_offset=?,
                               offset_metodo=? WHERE id=?""",
                        (vod["id"], vod["created_at"], offset, metodo, row["id"]),
                    )
                log.info("grabacion %s emparejada con el VOD %s", row["id"], vod["id"])

    def _afinar_desfases(self) -> None:
        """Rehace los desfases que no se pudieron medir con el metodo exacto.

        Una grabacion que empieza a la vez que el directo se empareja con un
        VOD que aun dura segundos, y entonces no hay material suficiente para
        comparar los PTS: se recurre a una aproximacion que puede irse varios
        segundos. Como el desfase se guardaba y no se volvia a mirar, ese error
        se quedaba para siempre en el primer trozo de cada directo.

        Aqui se reintenta el metodo bueno una vez el VOD ha crecido. No se toca
        lo que el usuario haya ajustado a mano.
        """
        pendientes = db.query(
            """SELECT id, login, vod_id, first_pts, vod_offset, offset_metodo
               FROM recordings
               WHERE vod_id IS NOT NULL AND first_pts IS NOT NULL
                 AND offset_override IS NULL
                 AND (offset_metodo IS NULL OR offset_metodo != 'pts')
                 AND capture_start > ?""",
            ((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=3)).isoformat(),),
        )
        if not pendientes:
            return

        # Todos los trozos de un mismo directo comparten constante, asi que se
        # mide una vez por VOD aunque haya varios pendientes.
        constantes: dict[str, float | None] = {}
        ahora = time.monotonic()
        for row in pendientes:
            vod = row["vod_id"]
            if vod not in constantes:
                # Un VOD que ya no exista fallaria en cada sondeo: tras un
                # fallo se deja descansar un rato antes de volver a pedirlo.
                if ahora - self._afinado_fallido.get(vod, -1e9) < 600:
                    constantes[vod] = None
                    continue
                try:
                    constantes[vod] = recorder.constante_del_vod(vod)
                except Exception as exc:  # noqa: BLE001 - se reintenta luego
                    log.debug("aun no se puede medir el VOD %s (%s)", vod, exc)
                    constantes[vod] = None
                    self._afinado_fallido[vod] = ahora
            k = constantes[vod]
            if k is None:
                continue

            offset = row["first_pts"] - k
            if offset < 0:
                continue
            viejo = row["vod_offset"] or 0.0
            with db.tx() as conn:
                conn.execute(
                    "UPDATE recordings SET vod_offset=?, offset_metodo='pts' "
                    "WHERE id=? AND offset_override IS NULL",
                    (offset, row["id"]),
                )
            log.info(
                "desfase de la grabacion %s afinado por PTS: %.3f s "
                "(antes %.3f por %s, correccion de %+.2f s)",
                row["id"], offset, viejo, row["offset_metodo"] or "?", offset - viejo,
            )

    def _calcular_desfase(self, row: dict, vod: dict) -> tuple[float, str]:
        """A que segundo del VOD corresponde el principio de la grabacion.

        Metodo bueno (solo mientras el directo sigue): se pregunta al playlist
        del VOD cuantos segundos lleva publicados y se resta lo transcurrido
        desde que empezamos a grabar y el retraso con que streamlink se
        engancha al directo. No interviene ningun reloj, asi que no arrastra
        latencias.

        Metodo de reserva (directo ya terminado): la hora de creacion del VOD
        menos ese mismo retraso, que es aproximado pero se queda cerca.
        """
        capture = dt.datetime.fromisoformat(row["capture_start"])

        # Metodo exacto: comparar los PTS. Ambos, directo y VOD, vienen del
        # mismo transcodificador y comparten numeracion.
        if row["first_pts"] is not None:
            try:
                k = recorder.constante_del_vod(vod["id"])
                offset = row["first_pts"] - k
                # El PTS es un contador de 33 bits a 90 kHz: da la vuelta cada
                # ~26,5 horas. En un directo mas largo que eso (una subathon)
                # el resultado seria disparatado, asi que se contrasta con el
                # calculo por reloj, que es tosco pero nunca se va tanto.
                created = dt.datetime.fromisoformat(
                    vod["created_at"].replace("Z", "+00:00")
                )
                aproximado = (capture - created).total_seconds()
                if offset < 0 or abs(offset - aproximado) > 600:
                    log.warning(
                        "el desfase por PTS (%.1f) no cuadra con el del reloj "
                        "(%.1f): puede que el contador haya dado la vuelta",
                        offset, aproximado,
                    )
                else:
                    log.info(
                        "desfase de %s por PTS: %.3f s (pts %.3f, constante %.3f)",
                        row["login"], offset, row["first_pts"], k,
                    )
                    return offset, "pts"
            except Exception as exc:  # noqa: BLE001
                log.warning("no se pudo medir por PTS (%s); se prueba otra via", exc)

        if row["status"] == "recording":
            try:
                total = recorder.duracion_del_vod(vod["id"])
                ahora = dt.datetime.now(dt.timezone.utc)
                transcurrido = (ahora - capture).total_seconds()
                retraso = recorder.retraso_del_borde(row["login"])
                offset = total - transcurrido - retraso
                log.info(
                    "desfase de %s por playlist: %.1f s (VOD %.0f s, "
                    "transcurrido %.0f s, borde %.1f s)",
                    row["login"], offset, total, transcurrido, retraso,
                )
                return max(0.0, offset), "playlist"
            except Exception as exc:  # noqa: BLE001
                log.warning("no se pudo medir por playlist (%s); se usa la hora", exc)

        created = dt.datetime.fromisoformat(vod["created_at"].replace("Z", "+00:00"))
        retraso = 12.5  # valor tipico: 3 segmentos de ~4,2 s
        try:
            retraso = recorder.retraso_del_borde(row["login"])
        except Exception:  # noqa: BLE001 - el canal ya no esta en directo
            pass
        return max(0.0, (capture - created).total_seconds() - retraso), "reloj"

    # -- limpieza ------------------------------------------------------

    def _apply_retention(self) -> None:
        days = int(config.load()["retention_days"])
        if days <= 0:
            return
        cutoff = (
            dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
        ).isoformat()
        old = db.query(
            "SELECT id, path FROM recordings WHERE capture_start < ? AND status!='recording'",
            (cutoff,),
        )
        for row in old:
            p = Path(row["path"])
            p.unlink(missing_ok=True)
            p.with_suffix(p.suffix + ".idx").unlink(missing_ok=True)
            with db.tx() as conn:
                conn.execute("DELETE FROM recordings WHERE id=?", (row["id"],))


_watcher: Watcher | None = None


def start() -> Watcher:
    global _watcher
    if _watcher is None or not _watcher.is_alive():
        _watcher = Watcher()
        _watcher.start()
    return _watcher


def current() -> Watcher | None:
    return _watcher
