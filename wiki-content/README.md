# Contenido inicial de la wiki

Cada archivo `.wiki` se importa como una página de MediaWiki. El título se obtiene del nombre del archivo sin la extensión y con los guiones bajos convertidos en espacios:

- `Página_principal.wiki` → `Página principal`
- `Crear_un_USB_de_instalación.wiki` → `Crear un USB de instalación`
- `Categoría:Guías.wiki` → `Categoría:Guías`

Las páginas deben usar enlaces internos con el mismo título (`[[Primeros pasos]]`) y terminar con una o más categorías (`[[Categoría:Guías]]`). `npm test` comprueba que no haya enlaces internos rotos, categorías inexistentes ni enlaces externos mal formados.

## Importar

En el servidor de la wiki:

```bash
cd /srv/http/churros-web
sudo ./scripts/import-wiki-content.sh
```

El importador usa `maintenance/run.php importTextFiles` de MediaWiki. No contiene credenciales y no se ejecuta desde el navegador. Consulta `docs/mediawiki-arch-linux.md` para las variables disponibles.
