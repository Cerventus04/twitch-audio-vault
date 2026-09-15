"""Lectura de tiempos en MP4 fragmentado (CMAF).

Twitch entrega el audio en dos envoltorios distintos segun como emita el
streamer: MPEG-TS de toda la vida, o MP4 fragmentado si usa la Emision
Mejorada. Los dos conviven, asi que hay que saber leer los dos.

Aqui se saca el instante del contenido igual que `tsdemux` saca el PTS: en MP4
esa marca vive en la caja `tfdt` de cada fragmento (`baseMediaDecodeTime`),
expresada en unidades de la escala que declara `mdhd`.
"""
from __future__ import annotations

import struct

# Cajas que solo contienen otras cajas: hay que entrar en ellas para buscar.
CONTENEDORAS = {b"moov", b"trak", b"mdia", b"moof", b"traf"}


def cajas(datos: bytes, inicio: int = 0, fin: int | None = None):
    """Recorre las cajas de un nivel. Devuelve (tipo, principio, final)."""
    fin = len(datos) if fin is None else fin
    i = inicio
    while i + 8 <= fin:
        tam = struct.unpack_from(">I", datos, i)[0]
        tipo = datos[i + 4 : i + 8]
        cuerpo = i + 8
        if tam == 1:  # tamaño de 64 bits en los 8 bytes siguientes
            if i + 16 > fin:
                return
            tam = struct.unpack_from(">Q", datos, i + 8)[0]
            cuerpo = i + 16
        elif tam == 0:  # se extiende hasta el final
            tam = fin - i
        if tam < 8 or i + tam > fin:
            return
        yield tipo, cuerpo, i + tam
        i += tam


def _buscar(datos: bytes, camino: tuple[bytes, ...], inicio=0, fin=None):
    """Primera caja que cuelgue de esa ruta, por ejemplo moov/trak/mdia/mdhd."""
    if not camino:
        return None
    for tipo, a, b in cajas(datos, inicio, fin):
        if tipo == camino[0]:
            if len(camino) == 1:
                return (a, b)
            hallado = _buscar(datos, camino[1:], a, b)
            if hallado:
                return hallado
        elif tipo in CONTENEDORAS:
            hallado = _buscar(datos, camino, a, b)
            if hallado:
                return hallado
    return None


def escala(datos: bytes) -> int | None:
    """Unidades por segundo declaradas en `mdhd` (suele ser 48000)."""
    sitio = _buscar(datos, (b"moov", b"trak", b"mdia", b"mdhd"))
    if not sitio:
        return None
    a, _b = sitio
    version = datos[a]
    # Tras version(1)+flags(3) van creacion y modificacion, de 4 u 8 bytes.
    desplazamiento = a + 4 + (16 if version == 1 else 8)
    if desplazamiento + 4 > len(datos):
        return None
    valor = struct.unpack_from(">I", datos, desplazamiento)[0]
    return valor or None


def primer_tfdt(datos: bytes) -> int | None:
    """`baseMediaDecodeTime` del primer fragmento, en unidades de escala."""
    sitio = _buscar(datos, (b"moof", b"traf", b"tfdt"))
    if not sitio:
        return None
    a, _b = sitio
    version = datos[a]
    if version == 1:
        if a + 12 > len(datos):
            return None
        return struct.unpack_from(">Q", datos, a + 4)[0]
    if a + 8 > len(datos):
        return None
    return struct.unpack_from(">I", datos, a + 4)[0]


def primer_tiempo(datos: bytes, escala_conocida: int | None = None) -> float | None:
    """Segundos de contenido en que empieza lo que hay en `datos`.

    Equivale al PTS del MPEG-TS: sirve para saber a que punto del VOD
    corresponde el principio de una grabacion.
    """
    ts = escala_conocida or escala(datos)
    bmdt = primer_tfdt(datos)
    if ts is None or bmdt is None:
        return None
    return bmdt / ts


class Lector:
    """Va acumulando trozos hasta poder leer el instante inicial.

    El fichero empieza por el segmento de inicializacion (con `moov`, que trae
    la escala) y despues llegan los fragmentos (con `moof`/`tfdt`). Puede hacer
    falta mas de un trozo para tener ambos.
    """

    def __init__(self, tope: int = 4 * 1024 * 1024) -> None:
        self.buffer = bytearray()
        self.escala: int | None = None
        self.tiempo: float | None = None
        self.tope = tope  # deja de acumular si no aparece: no crecer sin fin

    def feed(self, datos: bytes) -> None:
        if self.tiempo is not None or len(self.buffer) >= self.tope:
            return
        self.buffer += datos
        if self.escala is None:
            self.escala = escala(bytes(self.buffer))
        if self.escala is not None:
            bmdt = primer_tfdt(bytes(self.buffer))
            if bmdt is not None:
                self.tiempo = bmdt / self.escala
                self.buffer = bytearray()  # ya no hace falta guardar nada
