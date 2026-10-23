# MediaWiki para ChurrOS en Arch Linux

Esta guía despliega la interfaz nativa de `wiki.html`, el BFF de Node.js y MediaWiki como tres responsabilidades separadas. MediaWiki y MariaDB conservan los artículos; ChurrOS no los copia.

## Versiones y dependencias

Al 23 de octubre de 2026, Arch Linux publica `mediawiki 1.46.2-1`. MediaWiki 1.46.2 requiere PHP 8.3 o superior y MariaDB 10.3+, MySQL 5.7+, PostgreSQL 10+ o SQLite 3.31+. Esta guía usa MariaDB porque es la opción recomendada y mejor probada por el proyecto.

Fuentes: [paquete MediaWiki de Arch Linux](https://archlinux.org/packages/extra/any/mediawiki/), [requisitos oficiales de MediaWiki 1.46.2](https://www.mediawiki.org/wiki/Download/en#System_requirements) y [extensión OAuth](https://www.mediawiki.org/wiki/Extension:OAuth).

Instala sin iniciar ni modificar servicios automáticamente:

```bash
sudo pacman -Syu
sudo pacman -S --needed mediawiki nginx php-fpm mariadb nodejs npm php-apcu php-gd imagemagick composer git openssl
```

El paquete de Arch instala MediaWiki en `/usr/share/webapps/mediawiki` y un ejemplo de Apache en `/etc/webapps/mediawiki`. En `/etc/php/php.ini`, habilita como mínimo `iconv`, `intl`, `mysqli`, `mbstring`, `curl`, `sodium`, `xml`, `dom`, `xmlreader`, `fileinfo`, `calendar` y `ctype`; habilita también `apcu` y `gd` si aparecen como módulos separados. Comprueba el resultado, no asumas que una extensión quedó activa:

```bash
php -v
php -m | sort
php -r 'foreach (["intl","mbstring","mysqli","curl","sodium","dom","xmlreader","fileinfo"] as $e) { if (!extension_loaded($e)) { fwrite(STDERR, "Falta $e\n"); exit(1); } }'
```

## MariaDB

Inicializa MariaDB solo en una instalación nueva:

```bash
sudo mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql
sudo systemctl enable --now mariadb.service
sudo mariadb-secure-installation
```

Crea una base y un usuario exclusivos; reemplaza la contraseña antes de ejecutar:

```sql
CREATE DATABASE churros_wiki CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'churros_wiki'@'localhost' IDENTIFIED BY 'CONTRASEÑA_ALEATORIA';
GRANT ALL PRIVILEGES ON churros_wiki.* TO 'churros_wiki'@'localhost';
FLUSH PRIVILEGES;
```

MediaWiki administra su propio esquema. La base principal de ChurrOS no participa.

## Configurar MediaWiki

1. Crea almacenamiento persistente y caché:

   ```bash
   sudo install -d -o http -g http -m 0750 /var/lib/mediawiki/uploads /var/cache/mediawiki
   sudo install -d -o root -g http -m 0750 /etc/webapps/mediawiki
   ```

2. Copia `deploy/mediawiki/LocalSettings.churros.php.example` a `/usr/share/webapps/mediawiki/LocalSettings.php`.
3. Copia `deploy/mediawiki/churros-secrets.php.example` a `/etc/webapps/mediawiki/churros-secrets.php`, reemplaza todos los valores y aplica `root:http`/`0640` como indica el archivo.
4. Instala una versión de OAuth compatible con la rama `REL1_46`; no uses `master`:

   ```bash
   cd /usr/share/webapps/mediawiki/extensions
   sudo git clone --branch REL1_46 --depth 1 https://gerrit.wikimedia.org/r/mediawiki/extensions/OAuth
   cd OAuth
   sudo composer install --no-dev --optimize-autoloader
   ```

5. Genera las claves OAuth fuera del árbol web:

   ```bash
   sudo openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /etc/webapps/mediawiki/oauth-private.key
   sudo openssl rsa -pubout -in /etc/webapps/mediawiki/oauth-private.key -out /etc/webapps/mediawiki/oauth-public.key
   sudo chown root:http /etc/webapps/mediawiki/oauth-*.key
   sudo chmod 0640 /etc/webapps/mediawiki/oauth-private.key /etc/webapps/mediawiki/oauth-public.key
   ```

6. Instala el esquema. En una base vacía usa el instalador CLI oficial y luego restaura el `LocalSettings.php` endurecido; en una instalación ya creada solo ejecuta la actualización:

   ```bash
   cd /usr/share/webapps/mediawiki
   sudo -u http php maintenance/run.php update --quick
   ```

La extensión OAuth añade tablas y requiere ese `update`. Comprueba `Special:Version` después de iniciar el servicio.

## OAuth y permisos

No existe un sistema de cuentas previo en este repositorio. MediaWiki es por tanto el proveedor real de identidad y permisos:

1. Crea usuarios desde la administración de MediaWiki; el ejemplo desactiva el registro público.
2. Inicia sesión como `sysop` en `/wiki-engine/index.php?title=Special:UserLogin`.
3. Registra un cliente OAuth 2.0 confidencial en `Special:OAuthConsumerRegistration/propose`.
4. Usa callback exacto `https://www.churroslinux.org/api/wiki/auth/callback`.
5. Habilita `authorization_code` y `refresh_token`, con PKCE.
6. Concede solo `basic`, `editpage` y `createeditmovepage`.
7. Guarda el identificador y secreto en `/etc/churros/wiki-api.env`; nunca en HTML o JavaScript.

OAuth limita los permisos que ya tiene cada usuario: un grant no convierte a un lector en editor. El BFF consulta `userinfo.rights` antes de escribir y MediaWiki vuelve a aplicar sus permisos durante `action=edit`.

## BFF de ChurrOS

```bash
sudo useradd --system --home-dir /srv/http/churros-web --shell /usr/bin/nologin churros-wiki
sudo install -d -o root -g churros-wiki -m 0750 /etc/churros
sudo install -o root -g churros-wiki -m 0640 .env.example /etc/churros/wiki-api.env
sudoedit /etc/churros/wiki-api.env
```

Genera `SESSION_SECRET` con `openssl rand -base64 48`. Valida la configuración sin imprimir secretos:

```bash
cd /srv/http/churros-web
sudo -u churros-wiki /usr/bin/node --env-file=/etc/churros/wiki-api.env server/check-config.js
```

Instala y habilita el servicio:

```bash
sudo install -o root -g root -m 0644 deploy/churros-wiki-api.service /etc/systemd/system/churros-wiki-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now churros-wiki-api.service
sudo systemctl status churros-wiki-api.service
```

El proceso escucha solo en `127.0.0.1:3000`, es stateless y no necesita acceso de escritura al repositorio.

## nginx y PHP-FPM

Revisa `deploy/nginx-churros-wiki.conf` y adapta el bloque público al vhost HTTPS existente. La configuración propuesta:

- sirve el sitio estático desde el vhost actual;
- publica `/api/wiki/` hacia Node en loopback;
- mantiene la Action API fuera de Internet;
- publica solo OAuth, login/consentimiento, ResourceLoader y uploads necesarios;
- mantiene el motor PHP en `127.0.0.1:8081`;
- no habilita CORS.

Prueba antes de recargar:

```bash
sudo nginx -t
sudo php-fpm -t
sudo systemctl enable --now php-fpm.service nginx.service
sudo systemctl reload nginx.service
```

No abras los puertos 3000, 8081 o 3306 en el firewall. El único punto público debe ser el vhost HTTPS de ChurrOS.

## Contenido inicial

El repositorio incluye `wiki-content/` con las páginas base de la wiki en wikitext: portada, primeros pasos, descarga, instalación, ediciones, edición Server, aplicaciones, requisitos, actualizaciones, red, escritorios, rollback, solución de problemas, preguntas frecuentes, comunidad, contribución e historial de versiones. Las categorías iniciales son `Destacados`, `Guías`, `Referencia` y `Comunidad`.

Copia el sitio en `/srv/http/churros-web` y ejecuta el importador como root. El script usa `maintenance/run.php importTextFiles`, conserva el historial, crea entradas en cambios recientes y no vuelve a escribir páginas cuyo contenido no cambió:

```bash
cd /srv/http/churros-web
sudo ./scripts/import-wiki-content.sh
```

El script valida que exista MediaWiki y ejecuta la importación como el usuario `http`:

| Variable | Valor por defecto | Uso |
|---|---|---|
| `MEDIAWIKI_DIR` | `/usr/share/webapps/mediawiki` | Raíz de MediaWiki |
| `WIKI_CONTENT_DIR` | `wiki-content/` del repositorio | Directorio con los `.wiki` |
| `WIKI_RUN_USER` | `http` | Usuario que ejecuta el mantenimiento |
| `WIKI_IMPORT_SUMMARY` | `Contenido inicial de la wiki de ChurrOS` | Resumen de las revisiones |

No se necesitan credenciales de OAuth ni de bot: el script se ejecuta en el servidor y escribe directamente en la base de datos de MediaWiki. No lo ejecutes desde el navegador ni lo expongas por HTTP.

Después de importar, comprueba que la portada y la categoría destacada coinciden con la configuración del BFF:

```bash
curl --fail --silent 'http://127.0.0.1:3000/api/wiki/home'
```

La portada debe ser `Página principal` y la categoría destacada debe contener artículos en `Destacados`.

## Comprobaciones

```bash
curl --fail --silent http://127.0.0.1:3000/api/wiki/health
curl --fail --silent 'http://127.0.0.1:3000/api/wiki/search?q=ChurrOS'
curl --fail --silent 'http://127.0.0.1:3000/api/wiki/article?title=Página%20principal'
curl --fail --silent https://www.churroslinux.org/api/wiki/health
```

En navegador comprueba búsqueda, categorías, recientes, inicio de sesión, edición, conflicto de revisión, historial y diferencias. Confirma además que DevTools no muestra tokens en respuestas, almacenamiento local ni JavaScript.

## Copias de seguridad y restauración

Una copia consistente incluye base, uploads, configuración y claves:

```bash
sudo mariadb-dump --single-transaction --routines --triggers churros_wiki | gzip > churros_wiki.sql.gz
sudo tar -C / -czf churros_wiki-files.tar.gz \
  var/lib/mediawiki/uploads \
  etc/webapps/mediawiki \
  etc/churros/wiki-api.env \
  usr/share/webapps/mediawiki/LocalSettings.php
```

Guarda esos archivos cifrados y fuera del servidor. Para restaurar, detén Node/PHP-FPM, restaura DB y archivos con propietarios/permisos correctos, ejecuta `maintenance/run.php update --quick`, inicia servicios y realiza los smoke tests. No restaures una clave privada en un host no confiable.

## Actualización

1. Lee `RELEASE-NOTES-1.46` y `UPGRADE` en `/usr/share/webapps/mediawiki`.
2. Haz y verifica una copia de seguridad.
3. Actualiza paquetes con `pacman -Syu`.
4. Actualiza OAuth a la rama compatible con la versión instalada y ejecuta `composer install --no-dev`.
5. Ejecuta `sudo -u http php /usr/share/webapps/mediawiki/maintenance/run.php update --quick`.
6. Reinicia `php-fpm`, `churros-wiki-api` y recarga nginx.
7. Ejecuta pruebas de lectura, OAuth, permisos, escritura, historial y respaldo.

No saltes varias versiones antiguas directamente: sigue la ruta soportada por la [guía oficial de actualización](https://www.mediawiki.org/wiki/Manual:Upgrading).

## Desarrollo local sin MediaWiki

```bash
npm test
npm run check
npm run check:config
```

Las pruebas usan un transporte MediaWiki simulado. Validan contratos, seguridad, permisos y errores, pero no prueban una base persistente, OAuth real, PHP-FPM ni la indexación de búsqueda. Esas comprobaciones requieren el despliegue descrito arriba.
