import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const contentDir = join(dirname(fileURLToPath(import.meta.url)), "..", "wiki-content");
const files = readdirSync(contentDir).filter((name) => name.endsWith(".wiki"));

const titleOf = (file) => file.slice(0, -".wiki".length).replaceAll("_", " ");
const keyOf = (title) => title.trim().replaceAll("_", " ").toLocaleLowerCase("es");
const pages = new Map(
  files.map((file) => {
    const title = titleOf(file);
    return [keyOf(title), { file, title, text: readFileSync(join(contentDir, file), "utf8") }];
  }),
);

function internalLinks(text) {
  return [...text.matchAll(/\[\[([^\]]+)\]\]/g)]
    .map((match) => match[1].split("|")[0].split("#")[0].trim())
    .filter((title) => title && !/^Categoría:/i.test(title));
}

function categoryLinks(text) {
  return [...text.matchAll(/\[\[Categoría:([^\]|]+)/gi)].map((match) => match[1].trim());
}

test("the seed content contains the expected core pages", () => {
  for (const title of [
    "Página principal",
    "Primeros pasos",
    "Descargar ChurrOS",
    "Instalar ChurrOS",
    "Ediciones de ChurrOS",
    "Preguntas frecuentes",
    "Comunidad y soporte",
  ]) {
    assert.ok(pages.has(keyOf(title)), `falta ${title}`);
  }
  assert.ok(pages.size >= 20, `se esperaban al menos 20 páginas, hay ${pages.size}`);
});

test("every page has content and a category, except category pages", () => {
  for (const page of pages.values()) {
    assert.ok(page.text.trim().length > 80, `${page.title} está vacía o es demasiado corta`);
    if (/^Categoría:/i.test(page.title)) continue;
    assert.ok(categoryLinks(page.text).length > 0, `${page.title} no declara una categoría`);
  }
});

test("internal article links resolve to a seed page", () => {
  for (const page of pages.values()) {
    for (const title of internalLinks(page.text)) {
      assert.ok(pages.has(keyOf(title)), `${page.title} enlaza a una página inexistente: ${title}`);
    }
  }
});

test("category links resolve to a seed category page", () => {
  for (const page of pages.values()) {
    for (const category of categoryLinks(page.text)) {
      assert.ok(pages.has(keyOf(`Categoría:${category}`)), `${page.title} usa una categoría inexistente: ${category}`);
    }
  }
});

test("external links use the MediaWiki URL-first syntax", () => {
  for (const page of pages.values()) {
    const prose = page.text.replace(/<(pre|code|nowiki)>[\s\S]*?<\/\1>/gi, "");
    for (const match of prose.matchAll(/(?<!\[)\[(?!\[)([^\]]+)\]/g)) {
      assert.match(match[1], /^https?:\/\//, `${page.title} tiene un enlace externo mal formado: [${match[1]}]`);
    }
  }
});

test("the main page is featured and links to the essential guides", () => {
  const main = pages.get(keyOf("Página principal"));
  assert.ok(main);
  assert.ok(categoryLinks(main.text).includes("Destacados"));
  for (const title of ["Primeros pasos", "Instalar ChurrOS", "Preguntas frecuentes"]) {
    assert.ok(internalLinks(main.text).some((link) => keyOf(link) === keyOf(title)), `la portada no enlaza a ${title}`);
  }
});
