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
import threading
from pathlib import Path

# Cada cuantos segundos se apunta una marca. Mas fino ocupa mas y no aporta:
# el navegador ya ajusta el resto por su cuenta.
GRANULARIDAD = 10


class FueraDelFichero(Exception):
    """Se pidio un tramo que empieza despues de lo grabado.

    Antes se recortaba a la ultima marca y se servia eso: el cliente creia
    estar en el segundo pedido y sonaba audio anterior, ya escuchado. Y el
    relevo, que reintenta cuando el tramo de un directo en curso aun no
    existe, nunca veia el error que esperaba.
    """

FRECUENCIAS = [
    96000, 88200, 64000, 48000, 44100, 32000,
    24000, 22050, 16000, 12000, 11025, 8000,
]


# Un cerrojo por fichero. Mientras se graba, el vigilante y las peticiones de
# /audio construyen y reescriben el mismo indice a la vez: uno leia el de otro
# a medio escribir, lo daba por roto y lo rehacia desde cero, que son segundos
# de espera en mitad de un relevo (medido: 360 de 1200 consultas con 4 hilos).
# Asi lo hace uno y los demas leen el resultado.
_cerrojos: dict[str, threading.Lock] = {}
_cerrojos_cerrojo = threading.Lock()


def cerrojo(audio: Path) -> threading.Lock:
    with _cerrojos_cerrojo:
        return _cerrojos.setdefault(str(audio), threading.Lock())


def guardar_indice(cache: Path, datos: dict) -> None:
    try:
        cache.write_text(json.dumps(datos), encoding="utf-8")
    except OSError:
        pass  # sin cache funciona igual, solo mas lento


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
    with cerrojo(audio):
        datos = _reanudable(audio, _leer_indice_cacheado(audio, cache))
        if datos is not None and datos.get("bytes") == audio.stat().st_size:
            return datos  # nada ha cambiado
        datos = construir(audio, previo=datos)  # sin previo, desde cero
        guardar_indice(cache, datos)
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
    k = max(0, int(segundo // g))
    if k >= len(marcas):
        raise FueraDelFichero(segundo)
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

