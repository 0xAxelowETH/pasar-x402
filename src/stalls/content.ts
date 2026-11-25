// Stall 6 — pay-per-item content. Items are Markdown files in content/ with a small front matter.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";

export type ContentItem = {
  id: string;
  title: string;
  price: string;
  excerpt: string;
  body: string;
};

const CONTENT_DIR = resolve(ROOT, "content");

function parse(id: string, raw: string): ContentItem {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`content/${id}.md is missing its --- front matter ---`);
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!meta.title || !meta.price) throw new Error(`content/${id}.md needs "title" and "price"`);
  return { id, title: meta.title, price: meta.price, excerpt: meta.excerpt ?? "", body: match[2].trim() };
}

let items: Map<string, ContentItem> | undefined;

export function contentItems(): Map<string, ContentItem> {
  if (!items) {
    items = new Map(
      readdirSync(CONTENT_DIR)
        .filter((file) => file.endsWith(".md"))
        .map((file) => {
          const id = file.replace(/\.md$/, "");
          return [id, parse(id, readFileSync(resolve(CONTENT_DIR, file), "utf8"))] as const;
        }),
    );
  }
  return items;
}

export function contentIdFromPath(path: string) {
  return decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
}

export function publicListing() {
  return [...contentItems().values()].map(({ id, title, price, excerpt }) => ({ id, title, price, excerpt }));
}
