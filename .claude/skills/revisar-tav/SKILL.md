---
name: revisar-tav
description: Revision completa de Twitch Audio Vault con ponytail. Lee todo el codigo, confirma cada fallo con un caso concreto, lo arregla con su test, prueba en Chrome si hay grabacion emparejada y hace commit + push. Repite hasta que una pasada entera no encuentre nada. Usar con "/revisar-tav" o "/loop /revisar-tav".
---

# Revisar Twitch Audio Vault

Una ronda de revision. Con `/loop /revisar-tav` se encadenan solas; la ronda
que no encuentre nada cierra el bucle (ScheduleWakeup con `stop: true`).

## Reglas

- Todo cambio con ponytail: el arreglo mas pequeño que resuelve la causa,
  borrar antes que añadir, `shortcut:` para los limites conocidos.
- **Certezas, no teorias.** Un fallo solo cuenta con un caso concreto (esta
  entrada o esta situacion da este resultado malo). Si depende del
  navegador o de Twitch, medirlo antes de tocar nada. Sin prueba no se toca:
  se apunta en el resumen como riesgo sin confirmar.
- Cada arreglo lleva un test que **falla con el codigo anterior** (comprobarlo
  poniendo el fichero de `git show HEAD:...` y volviendo a dejar el nuevo).
- No preguntar entre arreglos: arreglar, probar, commit, push y seguir.
- Nunca escribir contraseñas, tokens ni la client secret en ningun campo.

## 1. Leer

Por orden de lo que mas cuesta si falla:

1. `extension/content.js` (sincronia, relevos, saltos, navegacion de Twitch).
2. `servidor/vault/server.py`, `adts.py`, `mp4idx.py` (servir audio por tramos).
3. `servidor/vault/recorder.py`, `watcher.py`, `tsdemux.py`, `mp4.py`, `twitch.py`, `db.py`, `auth.py`, `config.py`.
4. `extension/background.js`, `popup.js`, `opciones.js`, `puente.js`, `ajustes.js`.
5. `servidor/web/app.js` e `index.html`.

Buscar: fallos, seguridad (CSRF, escapado, secretos), perdida de datos,
carreras entre hilos o entre navegaciones, codigo muerto, duplicados.
Antes de llamar algo "sin usar", grep en todo el arbol (tests incluidos).

## 2. Probar

```bash
for t in content popup background puente; do node tests/${t}_test.js || exit 1; done
```

Python va por PowerShell (en Git Bash `py` esta roto):

```powershell
& py servidor/tests/test_audio.py
```

Nunca `python -` por tuberia: se cuelga.

## 3. Comprobar en Chrome (Claude in Chrome)

Solo si el grabador local (`http://localhost:8710`) tiene una grabacion con
`vod_id`:

```bash
curl -s localhost:8710/api/recordings
```

Diferencia esperada: `audio.currentTime - (video.currentTime - vod_offset + first_pts)`
(MP4: `absoluto`). Comprobar con registros por `setInterval` que no bloqueen
la pestaña (una espera de mas de 45 s dentro de `javascript_exec` la cuelga):

- Sincronia estable (normal: entre -150 y +100 ms; es el orden de lectura).
- Un salto dentro de la ventana cargada y otro lejos.
- Un relevo (cambio de `<audio>`) sin elemento vacio (`rs0`) ni recarga.
- Cerca del final si el directo sigue en marcha.

El usuario tiene que recargar la extension en `chrome://extensions` para
probar lo cambiado (esa pagina no se puede abrir). Si no lo ha hecho, probar
con la version cargada y decirlo en el resumen. Cerrar las pestañas propias
al acabar. Si hay que añadir un canal de prueba, quitarlo y borrar su
grabacion despues.

## 4. Commit y push

- Mensaje en un fichero nuevo del scratchpad (Write o heredoc de Bash; nunca
  `Set-Content`, que mete BOM) y `git commit -F <fichero>`.
- Un commit por arreglo, en español, explicando el caso medido.
- Push siempre despues de cada commit.

## 5. Resumen de la ronda

En español llano: que se arreglo (con commit), que se comprobo sin cambios,
riesgos sin confirmar y que no se pudo probar. Si no se encontro nada en
toda la pasada, decirlo y cerrar el bucle.
