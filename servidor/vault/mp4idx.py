"""Indice de tiempo para MP4 fragmentado grabado en directo.

Un fMP4 que se va escribiendo segmento a segmento no lleva ninguna tabla de
busqueda: ni `sidx` ni `mfra`. Para saltar a un punto el navegador tiene que
recorrer los `moof` en cadena desde donde alcance, y en una grabacion de horas
eso se nota igual que en el AAC crudo.

A diferencia del ADTS, aqui el recorte no puede ser un simple corte de bytes:
los fragmentos necesitan el segmento de inicializacion (`ftyp` + `moov`), que
declara el codec y la escala de tiempo. Lo que se sirve es ese segmento pegado
delante de los fragmentos que interesan, que es exactamente lo que hace un
reproductor de HLS.

Ventaja frente al ADTS: como cada `tfdt` trae el tiempo **absoluto**, el
fichero recortado conserva la misma linea temporal que el completo y el cliente
no tiene que corregir nada.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

from . import mp4

GRANULARIDAD = 10

# Cajas que acompañan al `moof` por delante dentro de un mismo segmento.
ANTESALA = {b"styp", b"sidx", b"prft", b"emsg", b"free", b"skip"}


def _cajas_del_fichero(fh, tam_total: int, desde: int = 0):
    """Recorre las cajas de primer nivel sin leerse el fichero entero.

    Con `desde` se arranca en mitad del fichero, que es como se reanuda un
    indice ya construido sin volver a recorrer lo anterior.
    """
    pos = desde
    while pos + 8 <= tam_total:
        fh.seek(pos)
        cabecera = fh.read(8)
        if len(cabecera) < 8:
            return
        tam = struct.unpack(">I", cabecera[:4])[0]
        tipo = cabecera[4:8]
        cuerpo = pos + 8
        if tam == 1:
            extra = fh.read(8)
            if len(extra) < 8:
                return
            tam = struct.unpack(">Q", extra)[0]
            cuerpo = pos + 16
        elif tam == 0:
            tam = tam_total - pos
        if tam < 8 or pos + tam > tam_total:
            return
        yield tipo, pos, cuerpo, pos + tam
        pos += tam


def construir(audio: Path, granularidad: int = GRANULARIDAD,
              previo: dict | None = None) -> dict:
    """Recorre los fragmentos y apunta en que byte empieza cada tramo.

    Con `previo` se reanuda un indice anterior: se conserva lo ya recorrido y
    se siguen leyendo solo los fragmentos nuevos. Vale porque una grabacion en
    curso solo se amplia por el final.
    """
    tam_total = audio.stat().st_size
    marcas: list[int] = []
    tiempos: list[float] = []
    de_init: list[int] = []  # que inicializacion le toca a cada marca
    # Twitch reenvia un segmento de inicializacion nuevo tras una
    # discontinuidad, asi que un fichero largo puede tener varios. A cada
    # fragmento le corresponde el ultimo que aparecio antes que el: pegarle
    # otro puede dejarlo sin descodificar.
    inits: list[list[int]] = []
    escala = None
    init_ini = None
    origen = None
    siguiente = 0.0
    arranca_en = 0
    if previo:
        marcas = list(previo["marcas"])
        tiempos = list(previo.get("tiempos") or [])
        de_init = list(previo.get("de_init") or [])
        inits = [list(x) for x in (previo.get("inits") or [])]
        escala = previo.get("escala")
        origen = previo.get("origen_real")
        siguiente = float(previo.get("siguiente", 0.0))
        arranca_en = int(previo["pos"])
        granularidad = int(previo.get("granularidad", granularidad))
    # Principio del segmento actual: las cajas que preceden al `moof` (el
    # `styp`, sobre todo) forman parte de el y hay que servirlas tambien.
    antesala = None

    fin_ultimo = arranca_en  # final de la ultima caja completa leida
    with open(audio, "rb") as fh:
        for tipo, principio, cuerpo, final in _cajas_del_fichero(
            fh, tam_total, arranca_en
        ):
            fin_ultimo = final
            if tipo == b"ftyp":
                init_ini = principio
                antesala = None
                continue
            if tipo == b"moov":
                fh.seek(principio)
                nueva = mp4.escala(fh.read(final - principio))
                if nueva:
                    escala = nueva
                inits.append([init_ini if init_ini is not None else principio, final])
                init_ini = None
                antesala = None
                continue
            if tipo in ANTESALA:
                if antesala is None:
                    antesala = principio
                continue
            if tipo != b"moof":
                antesala = None
                continue

            arranque = antesala if antesala is not None else principio
            antesala = None
            if escala is None or not inits:
                continue
            fh.seek(principio)
            bmdt = mp4.primer_tfdt(fh.read(final - principio))
            if bmdt is None:
                continue
            t = bmdt / escala
            if origen is None:
                origen = t
            # Un directo puede traer saltos hacia atras si el streamer se cae y
            # vuelve; el indice tiene que quedar creciente para poder buscarlo.
            relativo = t - origen
            if relativo < siguiente:
                continue
            while relativo >= siguiente:
                marcas.append(arranque)
                tiempos.append(t)
                de_init.append(len(inits) - 1)
                siguiente += granularidad

    # Si al parar quedaba un segmento a medias (su `styp` o su `ftyp` ya leidos
    # pero sin el `moof`/`moov` que los cierra), se reanuda desde ahi para que
    # ese segmento se vuelva a componer entero.
    pendientes = [x for x in (antesala, init_ini) if x is not None]
    pos_reanudar = min(pendientes + [fin_ultimo])

    return {
        "granularidad": granularidad,
        "bytes": tam_total,
        "inits": inits,
        "origen": origen or 0.0,
        "marcas": marcas,
        "tiempos": tiempos,
        "de_init": de_init,
        # Estado para reanudar sin recorrer otra vez lo ya leido.
        "pos": pos_reanudar,
        "siguiente": siguiente,
        "escala": escala,
        "origen_real": origen,
    }


def _cacheado(audio: Path, cache: Path) -> dict | None:
    """Lee el indice guardado tal cual. Quien decide si sirve es `indice`."""
    if not cache.exists():
        return None
    try:
        return json.loads(cache.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _reanudable(audio: Path, datos: dict | None) -> dict | None:
    """Devuelve el indice cacheado si sirve (igual o ampliable), o None.

    Se descarta cuando el fichero ha menguado (reemplazado o truncado) o cuando
    la cache es de una version anterior sin estado de reanudacion.
    """
    if not datos:
        return None
    guardado = datos.get("bytes")
    if not isinstance(guardado, int):
        return None
    tam = audio.stat().st_size
    if guardado > tam:
        return None  # el fichero no es el mismo
    if guardado < tam and datos.get("pos") is None:
        return None  # cache antigua: no se puede reanudar
    return datos


def _guardar(cache: Path, datos: dict) -> None:
    try:
        cache.write_text(json.dumps(datos), encoding="utf-8")
    except OSError:
        pass  # sin cache funciona igual, solo mas lento


def indice(audio: Path) -> dict:
    """Indice del fichero, construyendolo la primera vez y guardandolo al lado.

    Con una grabacion en curso el fichero crece, y antes eso invalidaba la
    cache entera: cada peticion rehacia el indice desde cero y costaba segundos
    (medido: 6-12 s en una grabacion de 645 MB, en CADA salto, mientras que la
    misma ya terminada respondia en 7 ms). Como el fichero solo se amplia por
    el final, ahora se conserva lo recorrido y se leen solo los bytes nuevos.
    """
    cache = audio.with_suffix(audio.suffix + ".m4idx")
    datos = _reanudable(audio, _cacheado(audio, cache))
    if datos is not None:
        if datos.get("bytes") == audio.stat().st_size:
            return datos  # nada ha cambiado
        datos = construir(audio, previo=datos)
        _guardar(cache, datos)
        return datos
    datos = construir(audio)
    _guardar(cache, datos)
    return datos


def corte(
    audio: Path, segundo: float, dura: float = 0
) -> tuple[list[int], int, int, float]:
    """Que inicializacion pegar delante y que tramo de bytes servir.

    `segundo` se cuenta desde el principio de la grabacion, y se redondea hacia
    abajo al mismo multiplo de granularidad que calcula el cliente. Con `dura`
    se corta tambien por el final, en el limite de fragmento correspondiente:
    sirve para entregar una ventana corta, que el navegador analiza en un
    suspiro en vez de recorrerse una cola de cientos de megas.

    Devuelve (inicializacion, primer byte, ultimo byte + 1, duracion real); el
    final es el tamaño del fichero si no se pidio ventana.

    La duracion real casi nunca coincide con `dura`, porque los dos extremos se
    redondean a marcas del indice: pedir 300 s puede devolver entre 260 y 355.
    El cliente la necesita para programar el relevo justo donde acaba el tramo
    y no mas alla, que es lo que sonaba como un corte seco.
    """
    datos = indice(audio)
    inits = datos.get("inits") or [[0, 0]]
    marcas = datos["marcas"]
    tiempos = datos.get("tiempos") or []
    total = int(datos["bytes"])
    if not marcas:
        return inits[0], inits[0][1], total, 0.0

    g = datos["granularidad"]
    k = max(0, int(segundo // g))
    k = min(k, len(marcas) - 1)
    cual = datos.get("de_init") or [0] * len(marcas)
    init = inits[min(cual[k], len(inits) - 1)]

    fin = total
    # Sin ventana se sirve hasta el final del fichero; como referencia de
    # tiempo se usa la ultima marca conocida, que se queda por debajo del
    # final real en menos de la granularidad. Mejor corto que pasarse.
    j = len(marcas) - 1
    if dura > 0:
        candidato = int((segundo + dura) // g)
        # Solo se corta si queda algo por detras: pedir mas de lo que hay debe
        # devolver hasta el final, no una ventana vacia.
        if 0 <= candidato < len(marcas) and marcas[candidato] > marcas[k]:
            fin = int(marcas[candidato])
            j = candidato
    real = 0.0
    if k < len(tiempos) and j < len(tiempos):
        real = max(0.0, tiempos[j] - tiempos[k])
    return init, int(marcas[k]), fin, real
