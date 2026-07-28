#!/usr/bin/env node
// Polls each member's Goodreads shelf and writes ratings.json.
//
//   node fetch-ratings.mjs
//
// Goodreads shut its API in 2020, but per-user review RSS still works for
// public profiles and carries user_rating and user_review. This reads that.
//
// Nothing identifying is written out. ratings.json holds only anonymous
// entries, shuffled, so neither the page nor the repo says who gave what —
// members.json maps names to profiles, and that is the only link.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const BOOKS_DIR = join(root, "books");
const OUT = join(root, "ratings.json");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const MAX_PAGES = 10; // 100 items a page — far more shelf than anyone here has

// ---------------------------------------------------------------------------

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

function field(item, tag) {
  const m = item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]).trim() : "";
}

// Goodreads review bodies are HTML. Keep the paragraph breaks, drop the rest;
// build.mjs escapes whatever comes out of here.
function reviewText(html) {
  return decode(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const normalise = (s) =>
  s.toLowerCase().replace(/\s*[:(\[].*$/, "").replace(/[^a-z0-9]/g, "");

// Which Goodreads book each club entry refers to, from its goodreads: link.
function clubBooks() {
  const books = [];
  for (const file of readdirSync(BOOKS_DIR).filter((f) => f.endsWith(".md"))) {
    const raw = readFileSync(join(BOOKS_DIR, file), "utf8");
    const link = raw.match(/^goodreads:\s*(\S+)/m);
    const title = raw.match(/^title:\s*(.+)$/m);
    if (!link || !title) continue;
    const id = link[1].match(/\/book\/show\/(\d+)/);
    if (!id) continue;
    books.push({ file, id: id[1], title: title[1].trim() });
  }
  return books;
}

async function fetchShelf(userId) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://www.goodreads.com/review/list_rss/${userId}?shelf=%23ALL%23&page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for user ${userId}`);
    const xml = await res.text();
    const found = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    items.push(...found);
    if (found.length < 100) break;
    await new Promise((r) => setTimeout(r, 1000)); // be a polite guest
  }
  return items;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ---------------------------------------------------------------------------

async function main() {
  const { members } = JSON.parse(readFileSync(join(root, "members.json"), "utf8"));
  const books = clubBooks();
  const byId = new Map(books.map((b) => [b.id, b]));
  const byTitle = new Map(books.map((b) => [normalise(b.title), b]));

  const collected = new Map(books.map((b) => [b.id, []]));
  // The feed carries the publisher blurb too. It's about the book, not the
  // member, so there's nothing to anonymise — first one wins.
  const synopses = new Map();
  let matched = 0;

  for (const member of members) {
    let items;
    try {
      items = await fetchShelf(member.goodreads_id);
    } catch (err) {
      // Partial data would silently drop somebody's ratings, so keep the last
      // good ratings.json instead of overwriting it with a half-answer.
      console.error(`\n${member.name}: ${err.message}`);
      console.error("Aborting — ratings.json left untouched.");
      process.exit(1);
    }

    let hits = 0;
    for (const item of items) {
      const book = byId.get(field(item, "book_id")) ?? byTitle.get(normalise(field(item, "title")));
      if (!book) continue;

      if (!synopses.has(book.id)) {
        const blurb = reviewText(field(item, "book_description"));
        if (blurb) synopses.set(book.id, blurb);
      }

      const rating = Number(field(item, "user_rating"));
      const review = reviewText(field(item, "user_review"));
      // rating 0 means shelved but not scored — not a zero-star verdict.
      if (!rating && !review) continue;

      collected.get(book.id).push({
        ...(rating ? { rating } : {}),
        ...(review ? { review } : {}),
      });
      hits++;
      matched++;
    }
    console.log(`${member.name.padEnd(6)} ${String(items.length).padStart(4)} shelf items, ${hits} club books`);
  }

  const out = {};
  for (const [id, entries] of collected) {
    const synopsis = synopses.get(id);
    if (!entries.length && !synopsis) continue;
    out[id] = {
      ...(synopsis ? { synopsis } : {}),
      entries: shuffle(entries),
    };
  }

  writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), books: out }, null, 2) + "\n");

  const all = Object.values(out).flatMap((b) => b.entries);
  const reviews = all.filter((e) => e.review).length;
  const withSynopsis = Object.values(out).filter((b) => b.synopsis).length;
  console.log(`\nWrote ratings.json — ${matched} entries across ${Object.keys(out).length} books, ${reviews} with a written review, ${withSynopsis} with a synopsis.`);
  if (!existsSync(join(root, "index.html"))) return;
  console.log("Run `node build.mjs` to fold them into the page.");
}

main();
