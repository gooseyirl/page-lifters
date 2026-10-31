#!/usr/bin/env node
// Polls each member's Goodreads shelf and writes ratings.json.
//
//   node fetch-ratings.mjs
//
// Goodreads shut its API in 2020 and its per-user review RSS in October 2026,
// so this reads the public shelf pages instead. Profiles must be public.
//
// Nothing identifying is written out. ratings.json holds only anonymous
// entries in a fixed order, so neither the page nor the repo says who gave what —
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

// Goodreads dropped the review RSS feeds in late October 2026, so this reads
// the public shelf pages (the same table you see at goodreads.com/review/list)
// and pulls each row apart. HTML is a less stable contract than RSS was: if
// the layout changes, parseShelf finds no table and the run aborts rather
// than writing an empty ratings.json.
const STARS = {
  "did not like it": 1,
  "it was ok": 2,
  "liked it": 3,
  "really liked it": 4,
  "it was amazing": 5,
};

function cell(row, name) {
  const m = row.match(new RegExp(`<td class="field ${name}"[\\s\\S]*?</td>`));
  return m ? m[0] : "";
}

function parseShelf(html, userId, url) {
  if (!html.includes('id="booksBody"')) {
    // Say what came back instead, so a sign-in wall or redesign is obvious
    // from the Actions log.
    const title = (html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1]?.trim() ?? "(no title)";
    throw new Error(
      `shelf page for user ${userId} has no book table (private, signed-out wall, or a layout change)\n` +
        `  served ${url}, ${html.length} bytes, title "${title}"`,
    );
  }
  const rows = html.split(/<tr id="review_\d+"/).slice(1);
  return rows.map((row) => {
    const titleCell = cell(row, "title");
    const id = (titleCell.match(/\/book\/show\/(\d+)/) ?? row.match(/\/book\/show\/(\d+)/) ?? [])[1] ?? "";
    const title = decode((titleCell.match(/<a[^>]*title="([^"]*)"/) ?? [])[1] ?? "").trim();

    const stars = (cell(row, "rating").match(/staticStars[^>]*title="([^"]*)"/) ?? [])[1] ?? "";
    const rating = STARS[stars.trim().toLowerCase()] ?? 0;

    // Long reviews come twice: a clipped copy and the full text in a hidden
    // span. Take the full one when it's there.
    const reviewCell = cell(row, "review");
    const full = reviewCell.match(/<span id="freeTextreview\d+"[^>]*>([\s\S]*?)<\/span>/);
    const short = reviewCell.match(/<span id="freeTextContainerreview\d+"[^>]*>([\s\S]*?)<\/span>/);
    const review = full?.[1] ?? short?.[1] ?? "";

    return { id, title, rating, review };
  });
}

async function fetchShelf(userId, shelf) {
  const items = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://www.goodreads.com/review/list/${userId}?shelf=${shelf}&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for user ${userId}`);
    const found = parseShelf(await res.text(), userId, res.url).filter((r) => r.id && !seen.has(r.id));
    if (!found.length) break; // past the last page, or it served page 1 again
    found.forEach((r) => seen.add(r.id));
    items.push(...found);
    await new Promise((r) => setTimeout(r, 1000)); // be a polite guest
  }
  return items;
}

// Shelf pages don't carry the publisher blurb, so keep the synopses already in
// ratings.json and only look up books that don't have one yet. Best effort: a
// missing synopsis never fails the run.
function knownSynopses() {
  try {
    const { books } = JSON.parse(readFileSync(OUT, "utf8"));
    return new Map(Object.entries(books).filter(([, b]) => b.synopsis).map(([id, b]) => [id, b.synopsis]));
  } catch {
    return new Map();
  }
}

async function fetchSynopsis(bookId) {
  try {
    const res = await fetch(`https://www.goodreads.com/book/show/${bookId}`, { headers: { "User-Agent": UA } });
    if (!res.ok) return "";
    const html = await res.text();
    const m =
      html.match(/data-testid="description"[\s\S]*?<span class="Formatted">([\s\S]*?)<\/span>/) ??
      html.match(/<meta (?:name|property)="(?:og:)?description" content="([^"]*)"/);
    return m ? reviewText(m[1]) : "";
  } catch {
    return "";
  }
}

// Sorted by score, then review text, so the order says nothing about whose
// shelf an entry came from — and ratings.json only changes when a score does.
const byScore = (a, b) =>
  (b.rating ?? 0) - (a.rating ?? 0) || (a.review ?? "").localeCompare(b.review ?? "");

// ---------------------------------------------------------------------------

async function main() {
  const { members } = JSON.parse(readFileSync(join(root, "members.json"), "utf8"));
  const books = clubBooks();
  const byId = new Map(books.map((b) => [b.id, b]));
  const byTitle = new Map(books.map((b) => [normalise(b.title), b]));

  const collected = new Map(books.map((b) => [b.id, []]));
  // The publisher blurb is about the book, not the member, so there's nothing
  // to anonymise.
  const synopses = knownSynopses();
  let matched = 0;

  for (const member of members) {
    let items;
    try {
      // Read shelf first so its copy of a book wins, then all shelves for
      // anything rated or reviewed elsewhere.
      items = [
        ...(await fetchShelf(member.goodreads_id, "read")),
        ...(await fetchShelf(member.goodreads_id, "%23ALL%23")),
      ];
    } catch (err) {
      // Partial data would silently drop somebody's ratings, so keep the last
      // good ratings.json instead of overwriting it with a half-answer.
      console.error(`\n${member.name}: ${err.message}`);
      console.error("Aborting — ratings.json left untouched.");
      process.exit(1);
    }

    let hits = 0;
    const seen = new Set();
    for (const item of items) {
      const book = byId.get(item.id) ?? byTitle.get(normalise(item.title));
      if (!book || seen.has(book.id)) continue;
      seen.add(book.id);

      const rating = item.rating;
      const review = reviewText(item.review);
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

  for (const book of books) {
    if (synopses.has(book.id)) continue;
    const blurb = await fetchSynopsis(book.id);
    if (blurb) synopses.set(book.id, blurb);
  }

  const out = {};
  for (const [id, entries] of collected) {
    const synopsis = synopses.get(id);
    if (!entries.length && !synopsis) continue;
    out[id] = {
      ...(synopsis ? { synopsis } : {}),
      entries: entries.sort(byScore),
    };
  }

  writeFileSync(OUT, JSON.stringify({ books: out }, null, 2) + "\n");

  const all = Object.values(out).flatMap((b) => b.entries);
  const reviews = all.filter((e) => e.review).length;
  const withSynopsis = Object.values(out).filter((b) => b.synopsis).length;
  console.log(`\nWrote ratings.json — ${matched} entries across ${Object.keys(out).length} books, ${reviews} with a written review, ${withSynopsis} with a synopsis.`);
  if (!existsSync(join(root, "index.html"))) return;
  console.log("Run `node build.mjs` to fold them into the page.");
}

main();
