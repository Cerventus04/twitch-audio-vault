# Poner Audio Vault en un servidor gratis

Todo esto sale a **0 €**: servidor en el nivel siempre gratuito de Oracle Cloud
y subdominio gratuito de DuckDNS.

Ventaja de fondo: el servidor esta encendido siempre, asi que graba aunque tu
PC este apagado. Es la limitacion mas seria de la version local.

---

## 1. Cuenta de Oracle Cloud

https://www.oracle.com/cloud/free/ → *Start for free*

Te pediran una tarjeta para verificar identidad. **No cobran nada** mientras te
quedes en los recursos "Always Free", pero la tarjeta es obligatoria.

Elige bien la **region**: no se puede cambiar despues, y la disponibilidad de
maquinas gratis depende de ella. Para Espa~na, Madrid o Frankfurt.

## 2. Crear la maquina

*Compute* → *Instances* → **Create instance**

| Campo | Valor |
|---|---|
| Image | **Ubuntu 24.04** (no Oracle Linux) |
| Shape | **VM.Standard.A1.Flex** (ARM, 1 OCPU y 6 GB) o **VM.Standard.E2.1.Micro** (x86, 1 GB) |
| Boot volume | **100 GB** |
| SSH keys | *Generate a key pair* y **descarga la clave privada** |

> **Aviso realista**: es muy habitual que salga *"Out of capacity"* con las
> maquinas ARM gratuitas, porque tienen mucha demanda. Si pasa, reintenta a
> otra hora o coge la **VM.Standard.E2.1.Micro** (x86), que casi siempre esta
> libre. Solo tiene 1 GB de RAM, pero `instalar.sh` detecta la falta de memoria
> y crea 2 GB de intercambio, que es lo unico que hace falta para que la
> instalacion no se ahogue.

Apunta la **IP publica** que te da al terminar.

## 3. Abrir los puertos

Son **dos sitios distintos**, y olvidar el segundo es el fallo mas comun.

**a) En la consola de Oracle**: entra en la instancia → *Subnet* → *Security
List* → **Add Ingress Rules**. A~nade dos reglas:

- Source `0.0.0.0/0`, protocolo TCP, puerto destino **80**
- Source `0.0.0.0/0`, protocolo TCP, puerto destino **443**

**b) En la propia maquina**: las imagenes de Oracle traen `iptables` bloqueando
todo menos SSH. De eso se encarga el script `instalar.sh`.

## 4. Subdominio gratis con DuckDNS

https://www.duckdns.org → entra con Google/GitHub → crea un subdominio
(por ejemplo `mi-vault`) y pon la **IP publica** de tu servidor.

Te queda `mi-vault.duckdns.org`. Con eso Caddy saca el certificado.

## 5. Copiar el proyecto al servidor

Desde tu PC, en PowerShell (cambia la ruta de la clave y la IP):

```powershell
scp -i C:\ruta\a\tu-clave.key -r "C:\ruta\a\TwitchAudioVault" ubuntu@TU_IP:~/vault
```

## 6. Configurar y arrancar

Conectate:

```bash
ssh -i C:\ruta\a\tu-clave.key ubuntu@TU_IP
```

Y dentro:

```bash
cd ~/vault
cp despliegue/env.ejemplo .env
nano .env          # pon tu subdominio en VAULT_DOMAIN
bash despliegue/instalar.sh
```

El `.env` ya viene con tus credenciales de Twitch y una contrase~na larga
generada al azar. **Guardala**, la necesitas para entrar al panel.

Tarda unos minutos: instala Docker, construye la imagen y Caddy pide el
certificado. Para ver como va:

```bash
sudo docker compose logs -f caddy
```

## 7. Comprobar

Abre `https://tu-subdominio.duckdns.org` en el navegador. Deberia pedirte la
contrase~na del `.env`.

## 8. Apuntar la extension al servidor

En el popup: **Configurar servidor**

- Direccion: `https://tu-subdominio.duckdns.org`
- Contrase~na: la del `.env`

## 9. Llevarte lo que ya tienes (opcional)

Para no perder las grabaciones y los canales del PC:

```powershell
scp -i C:\ruta\a\tu-clave.key -r "C:\ruta\a\TwitchAudioVault\grabaciones" ubuntu@TU_IP:~/
```

Y en el servidor:

```bash
sudo docker compose cp ~/grabaciones/. vault:/data/
sudo docker compose restart vault
```

---

## Cuando ya funcione

**Apaga el de tu PC** para que no graben los dos a la vez y dupliquen ficheros:
quita el acceso directo de `shell:startup` y cierra el programa desde Ajustes.

**Vigila el disco.** A 95 MB/hora y con varios canales se llena rapido. Con 150
GB y retencion de 7 dias vas holgado, pero echale un ojo la primera semana.

## Comandos utiles

```bash
sudo docker compose ps                 # estado
sudo docker compose logs -f vault      # registro de la app
sudo docker compose restart vault      # reiniciar
sudo docker compose down               # parar todo
sudo docker compose up -d --build      # actualizar tras cambiar el codigo
df -h                                  # espacio en disco
```
