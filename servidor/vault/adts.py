"""Indice de tiempo para ficheros AAC crudo (ADTS).

Un ADTS es una sucesion de tramas sin ninguna tabla que diga en que byte
empieza cada segundo. El navegador, para saltar a un punto, tiene que estimar
por tasa de bits y rastrear: medido sobre una grabacion de 3 horas, saltar a
los 10 minutos tardaba 10 segundos y a los 50 no llegaba a terminar.

Aqui se recorren las cabeceras de las tramas una vez y se apunta en que byte
empieza cada tramo de N segundos. Con eso el servidor puede entregar el fichero
ya recortado desde donde se le pida, y el navegador lo recibe como si fuera un
audio corto que empieza en cero.

Cada trama ADTS lleva 1024 muestras, asi que su duracion es 1024/frecuencia.
"""
from __future__ import annotations

import json
from pathlib import Path

# Cada cuantos segundos se apunta una marca. Mas fino ocupa mas y no aporta:
# el navegador ya ajusta el resto por su cuenta.
GRANULARIDAD = 10

FRECUENCIAS = [
    96000, 88200, 64000, 48000, 44100, 32000,
    24000, 22050, 16000, 12000, 11025, 8000,
]


def _leer_indice_cacheado(audio: Path, cache: Path) -> dict | None:
    """Lee el indice guardado tal cual. Quien decide si sirve es `indice`."""
    if not cache.exists():
        return None
    try:
        return json.loads(cache.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def construir(audio: Path, granularidad: int = GRANULARIDAD,
              previo: dict | None = None) -> dict:
    """Recorre el fichero y devuelve las marcas de tiempo -> byte.

    Con `previo` se reanuda un indice anterior: se conservan las marcas ya
    calculadas y se recorren solo los bytes nuevos. Vale porque una grabacion
    en curso solo se amplia por el final; si el fichero se hubiera reescrito,
    `indice` no llega a pasar `previo`.
    """
    if previo:
        marcas: list[int] = list(previo["marcas"])
        tiempos: list[float] = list(previo.get("tiempos") or [])
        tiempo = float(previo.get("duracion", 0.0))
        siguiente = float(previo.get("siguiente", 0.0))
        base = int(previo["pos"])  # byte del fichero donde empieza `resto`
        granularidad = int(previo.get("granularidad", granularidad))
    else:
        marcas = []
        tiempos = []
        tiempo = 0.0
        siguiente = 0.0
        base = 0
    resto = b""

    with open(audio, "rb") as fh:
        fh.seek(base)
        while True:
            trozo = fh.read(1 << 20)
            if not trozo and not resto:
                break
            buf = resto + trozo
            i = 0
            while i + 7 <= len(buf):
                if buf[i] != 0xFF or (buf[i + 1] & 0xF0) != 0xF0:
                    i += 1  # fuera de sincronia: se busca la siguiente cabecera
                    continue
                frec = (buf[i + 2] >> 2) & 0x0F
                if frec >= len(FRECUENCIAS):  # valores reservados
                    i += 1
                    continue
                largo = (
                    ((buf[i + 3] & 0x03) << 11)
                    | (buf[i + 4] << 3)
                    | ((buf[i + 5] >> 5) & 0x07)
                )
                if largo < 7:
                    i += 1
                    continue
                if i + largo > len(buf):
                    break  # trama partida: se completa en la vuelta siguiente
                while tiempo >= siguiente:
                    marcas.append(base + i)
                    # El tiempo REAL de la trama, no el multiplo redondo:
                    # la marca cae en la primera trama que alcanza ese
                    # segundo, unos milisegundos despues. Guardarlo permite
                    # dar la duracion exacta sin pasarse del final.
                    tiempos.append(tiempo)
                    siguiente += granularidad
                tiempo += 1024 / FRECUENCIAS[frec]
                i += largo
            resto = buf[i:]
            base += i
            if not trozo:
                break

    return {
        "granularidad": granularidad,
        "bytes": audio.stat().st_size,
        "duracion": tiempo,
        "marcas": marcas,
        "tiempos": tiempos,
        # Estado para reanudar sin volver a recorrer lo ya leido.
        "siguiente": siguiente,
        "pos": base,
    }


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
    # Las caches anteriores no guardaban el tiempo real de cada marca, y
    # sin el la duracion servida sale redondeada y puede pasarse del final.
    # Se rehacen; el vigilante las va calentando de una en una.
    if len(datos.get("tiempos") or []) != len(datos.get("marcas") or []):
        return None
    return datos


def indice(audio: Path) -> dict:
    """Indice del fichero, construyendolo la primera vez y guardandolo al lado.

    Con una grabacion en curso el fichero crece, y rehacer el indice entero en
    cada peticion costaba segundos (medido: 6-12 s en una de 645 MB, en cada
    salto). Como el fichero solo se amplia por el final, se conserva lo ya
    recorrido y se escanean unicamente los bytes nuevos.
    """
    cache = audio.with_suffix(audio.suffix + ".idx")
    datos = _reanudable(audio, _leer_indice_cacheado(audio, cache))
    if datos is not None and datos.get("bytes") == audio.stat().st_size:
        return datos  # nada ha cambiado
    if datos is not None:
        datos = construir(audio, previo=datos)
        try:
            cache.write_text(json.dumps(datos), encoding="utf-8")
        except OSError:
            pass
        return datos
    datos = construir(audio)
    try:
        cache.write_text(json.dumps(datos), encoding="utf-8")
    except OSError:
        pass  # sin cache funciona igual, solo mas lento
    return datos


def tramo(audio: Path, segundo: float, dura: float = 0) -> tuple[int, int, float]:
    """Primer byte, ultimo byte + 1 y duracion real del tramo que se sirve.

    El final vale 0 cuando se sirve hasta el final del fichero. La duracion es
    la del tramo de verdad, no la pedida: los dos extremos se redondean a
    marcas del indice, asi que pedir 300 s devuelve otra cosa. El cliente la
    necesita para saber donde acaba de verdad lo que recibe.
    """
    datos = indice(audio)
    marcas = datos["marcas"]
    g = datos["granularidad"]
    if not marcas:
        return 0, 0, float(datos.get("duracion") or 0.0)

    tiempos = datos.get("tiempos") or []
    exactos = len(tiempos) == len(marcas)
    k = min(max(0, int(segundo // g)), len(marcas) - 1)
    principio = int(marcas[k])
    inicio_real = tiempos[k] if exactos else k * g

    fin = 0
    final_real = float(datos.get("duracion") or 0.0)
    if dura > 0:
        j = int((segundo + dura) // g)
        if 0 <= j < len(marcas) and marcas[j] > principio:
            fin = int(marcas[j])
            final_real = tiempos[j] if exactos else j * g
    return principio, fin, max(0.0, final_real - inicio_real)


def byte_hasta(audio: Path, segundo: float) -> int:
    """Byte donde termina el tramo que llega hasta ese segundo.

    Devuelve 0 si cae mas alla del final del fichero, que es como `/audio`
    expresa "hasta el final". No vale reusar `byte_de` para esto: aquel
    recorta al ultimo tramo, asi que pedirle un segundo pasado el final
    devolveria la ultima marca y cortaria el audio antes de tiempo.
    """
    datos = indice(audio)
    marcas = datos["marcas"]
    k = int(segundo // datos["granularidad"])
    if k < 0 or k >= len(marcas):
        return 0
    return marcas[k]


def byte_de(audio: Path, segundo: float) -> tuple[int, float]:
    """Byte donde empieza el tramo que contiene ese segundo, y su tiempo real.

    Se redondea SIEMPRE hacia abajo a un multiplo de la granularidad para que
    el cliente pueda calcular el mismo valor sin preguntar.
    """
    datos = indice(audio)
    g = datos["granularidad"]
    k = max(0, int(segundo // g))
    marcas = datos["marcas"]
    if not marcas:
        return 0, 0.0
    k = min(k, len(marcas) - 1)
    return marcas[k], float(k * g)
