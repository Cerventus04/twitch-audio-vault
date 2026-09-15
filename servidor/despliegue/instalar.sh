#!/usr/bin/env bash
# Prepara un servidor Ubuntu recien creado para Twitch Audio Vault.
#
#   bash instalar.sh
#
# Instala Docker, abre los puertos y deja el proyecto listo para levantar.
# Pensado para el nivel gratuito de Oracle Cloud (Ubuntu 22.04/24.04, ARM o x86).

set -euo pipefail

verde() { printf '\033[32m%s\033[0m\n' "$*"; }
aviso() { printf '\033[33m%s\033[0m\n' "$*"; }

verde "==> Actualizando el sistema"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl git

# En la maquina gratuita x86 (E2.1.Micro) solo hay 1 GB de RAM. Sobra para
# grabar, pero instalar las dependencias de Python hace picos que la tumban.
# Con un fichero de intercambio deja de ser un problema.
ram_mb=$(free -m | awk '/^Mem:/{print $2}')
if [ "$ram_mb" -lt 2048 ] && [ ! -f /swapfile ]; then
    verde "==> Solo hay ${ram_mb} MB de RAM: creando 2 GB de intercambio"
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
    sudo swapon /swapfile
    grep -q '/swapfile' /etc/fstab || \
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    # Con poca RAM conviene tirar de intercambio antes de quedarse sin aire.
    echo 'vm.swappiness=30' | sudo tee /etc/sysctl.d/99-swap.conf >/dev/null
    sudo sysctl -q -w vm.swappiness=30
fi

verde "==> Instalando Docker"
if ! command -v docker >/dev/null; then
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    sudo usermod -aG docker "$USER"
else
    verde "    Docker ya estaba instalado"
fi

# Las imagenes de Oracle vienen con iptables bloqueando todo menos SSH. Es el
# fallo mas comun: abres el puerto en la consola web y sigue sin funcionar
# porque el cortafuegos de la propia maquina lo rechaza.
verde "==> Abriendo los puertos 80 y 443 en el cortafuegos de la maquina"
if command -v netfilter-persistent >/dev/null || [ -f /etc/iptables/rules.v4 ]; then
    sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
    sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
    sudo netfilter-persistent save 2>/dev/null || \
        sudo sh -c 'iptables-save > /etc/iptables/rules.v4'
    verde "    Reglas de iptables guardadas"
fi
if command -v ufw >/dev/null && sudo ufw status | grep -q active; then
    sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
fi

verde "==> Comprobando el fichero .env"
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
    aviso "    No hay .env todavia."
    aviso "    Copia despliegue/env.ejemplo a .env y pon tu dominio dentro:"
    aviso "        cp despliegue/env.ejemplo .env && nano .env"
    exit 1
fi
if grep -q CAMBIAME .env; then
    aviso "    Te falta poner tu dominio en .env (pone CAMBIAME)."
    exit 1
fi

verde "==> Levantando los contenedores"
sudo docker compose up -d --build

verde ""
verde "Listo. Comprueba el estado con:"
verde "    sudo docker compose ps"
verde "    sudo docker compose logs -f caddy    # aqui se ve el certificado"
verde ""
aviso "Si acabas de instalar Docker, cierra la sesion SSH y vuelve a entrar"
aviso "para poder usar 'docker' sin sudo."
