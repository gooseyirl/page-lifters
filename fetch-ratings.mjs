#!/usr/bin/env node
// Polls each member's Hardcover and Goodreads shelves and writes ratings.json.
//
//   HARDCOVER_TOKEN=... node fetch-ratings.mjs
//
// Each member can list a Hardcover username, a Goodreads id, or both
// (members.json). For every club book a member gets exactly one entry:
// Hardcover's if they rated or reviewed it there, otherwise Goodreads'. So a
// book logged on both sites is never counted twice.
//
// Hardcover has a real GraphQL API (token from hardcover.app/account/api).
// Goodreads shut its API in 2020 and its review RSS in October 2026, and its
// shelf pages now want a sign-in, so it is read best effort: RSS first, then
// the shelf page, in case either comes back.
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
const HARDCOVER_API = "https://api.hardcover.app/v1/graphql";
const MAX_PAGES = 10; // 100 items a page — far more shelf than anyone here has

const pause = () => new Promise((r) => setTimeout(r, 1000)); // be a polite guest

// ---------------------------------------------------------------------------
// Text helpers

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

function tag(item, name) {
  const m = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : "";
}

// Review bodies are HTML. Keep the paragraph breaks, drop the rest;
// build.mjs escapes whatever comes out of here.
function reviewText(html) {
  return decode(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const normalise = (s) =>
  (s ?? "").toLowerCase().replace(/\s*[:(\[].*$/, "").replace(/[^a-z0-9]/g, "");

const digits = (s) => String(s ?? "").replace(/[^0-9Xx]/g, "").toUpperCase();

// ---------------------------------------------------------------------------
// The club's books, from books/*.md

function clubBooks() {
  const books = [];
  for (const file of readdirSync(BOOKS_DIR).filter((f) => f.endsWith(".md"))) {
    const raw = readFileSync(join(BOOKS_DIR, file), "utf8");
    const link = raw.match(/^goodreads:\s*(\S+)/m);
    const title = raw.match(/^title:\s*(.+)$/m);
    const isbn = raw.match(/^isbn:\s*"?([0-9Xx-]+)"?/m);
    if (!link || !title) continue;
    const id = link[1].match(/\/book\/show\/(\d+)/);
    if (!id) continue;
    books.push({
      file,
      id: id[1],
      title: title[1].trim().replace(/^["']|["']$/g, ""),
      isbn: isbn ? digits(isbn[1]) : "",
    });
  }
  return books;
}

// Every source hands back shelf rows in the same shape:
//   { goodreadsId?, isbns: [], title, rating, review, description? }
// and this finds the club book a row is about.
function matcher(books) {
  const byId = new Map(books.map((b) => [b.id, b]));
  const byIsbn = new Map(books.filter((b) => b.isbn).map((b) => [b.isbn, b]));
  const byTitle = new Map(books.map((b) => [normalise(b.title), b]));
  return (row) =>
    (row.goodreadsId && byId.get(row.goodreadsId)) ||
    row.isbns.map((i) => byIsbn.get(digits(i))).find(Boolean) ||
    byTitle.get(normalise(row.title));
}

// ---------------------------------------------------------------------------
// Hardcover

function hardcoverToken() {
  const raw = (process.env.HARDCOVER_TOKEN ?? "").trim();
  if (!raw) return "";
  return raw.toLowerCase().startsWith("bearer ") ? raw : `Bearer ${raw}`;
}

async function fetchHardcover(handle) {
  const username = handle.replace(/^@/, ""); // "@name" as shown on profiles
  const token = hardcoverToken();
  if (!token) throw new Error("HARDCOVER_TOKEN is not set");

  // Inlined rather than a variable: username is citext in Hardcover's schema.
  const query = `{
    users(where: {username: {_eq: ${JSON.stringify(username)}}}, limit: 1) {
      user_books(where: {_or: [{rating: {_is_null: false}}, {has_review: {_eq: true}}]}) {
        rating
        review_raw
        book { title description }
        edition { isbn_13 isbn_10 }
      }
    }
  }`;

  const res = await fetch(HARDCOVER_API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token, "user-agent": "page-lifters ratings" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Hardcover HTTP ${res.status} for ${username}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Hardcover: ${body.errors.map((e) => e.message).join("; ")}`);
  const user = body.data?.users?.[0];
  if (!user) throw new Error(`Hardcover has no user "${username}" (or their library is private)`);

  return user.user_books.map((ub) => ({
    isbns: [ub.edition?.isbn_13, ub.edition?.isbn_10].filter(Boolean),
    title: ub.book?.title ?? "",
    rating: Number(ub.rating) || 0,
    review: reviewText(ub.review_raw),
    description: reviewText(ub.book?.description),
  }));
}

// ---------------------------------------------------------------------------
// Goodreads: review RSS (gone since Oct 2026), then the shelf page (needs a
// sign-in since Oct 2026). Kept so either starts working again by itself.

async function goodreadsRss(userId, shelf) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://www.goodreads.com/review/list_rss/${userId}?shelf=${shelf}&page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
    const found = (await res.text()).match(/<item>[\s\S]*?<\/item>/g) ?? [];
    rows.push(
      ...found.map((item) => ({
        goodreadsId: tag(item, "book_id"),
        isbns: [tag(item, "isbn")].filter(Boolean),
        title: tag(item, "title"),
        rating: Number(tag(item, "user_rating")) || 0,
        review: reviewText(tag(item, "user_review")),
        description: reviewText(tag(item, "book_description")),
      })),
    );
    if (found.length < 100) break;
    await pause();
  }
  return rows;
}

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

export function parseShelf(html, url) {
  if (!html.includes('id="booksBody"')) {
    const title = (html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1]?.trim() ?? "(no title)";
    throw new Error(`shelf page has no book table — served ${url}, title "${title}"`);
  }
  return html
    .split(/<tr id="review_\d+"/)
    .slice(1)
    .map((row) => {
      const titleCell = cell(row, "title");
      const stars = (cell(row, "rating").match(/staticStars[^>]*title="([^"]*)"/) ?? [])[1] ?? "";
      // Long reviews come twice: a clipped copy and the full text in a hidden span.
      const reviewCell = cell(row, "review");
      const full = reviewCell.match(/<span id="freeTextreview\d+"[^>]*>([\s\S]*?)<\/span>/);
      const short = reviewCell.match(/<span id="freeTextContainerreview\d+"[^>]*>([\s\S]*?)<\/span>/);
      return {
        goodreadsId: (titleCell.match(/\/book\/show\/(\d+)/) ?? row.match(/\/book\/show\/(\d+)/) ?? [])[1] ?? "",
        isbns: [],
        title: decode((titleCell.match(/<a[^>]*title="([^"]*)"/) ?? [])[1] ?? "").trim(),
        rating: STARS[stars.trim().toLowerCase()] ?? 0,
        review: reviewText(full?.[1] ?? short?.[1] ?? ""),
      };
    });
}

async function goodreadsShelfPage(userId, shelf) {
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://www.goodreads.com/review/list/${userId}?shelf=${shelf}&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`shelf page HTTP ${res.status}`);
    const found = parseShelf(await res.text(), res.url).filter((r) => r.goodreadsId && !seen.has(r.goodreadsId));
    if (!found.length) break; // past the last page, or it served page 1 again
    found.forEach((r) => seen.add(r.goodreadsId));
    rows.push(...found);
    await pause();
  }
  return rows;
}

async function fetchGoodreads(userId) {
  const errors = [];
  for (const read of [goodreadsRss, goodreadsShelfPage]) {
    try {
      // Read shelf first so its copy of a book wins (the all-shelves RSS
      // blanks reviews), then all shelves for anything rated elsewhere.
      return [...(await read(userId, "read")), ...(await read(userId, "%23ALL%23"))];
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(`Goodreads unavailable for ${userId}: ${errors.join("; ")}`);
}

// ---------------------------------------------------------------------------
// Merge

// One verdict per club book from one source's rows; the first row for a book wins.
function verdicts(rows, match) {
  const out = new Map();
  for (const row of rows) {
    const book = match(row);
    if (!book || out.has(book.id)) continue;
    // rating 0 means shelved but not scored — not a zero-star verdict.
    if (!row.rating && !row.review) continue;
    out.set(book.id, {
      ...(row.rating ? { rating: row.rating } : {}),
      ...(row.review ? { review: row.review } : {}),
    });
  }
  return out;
}

// Hardcover wins book by book; Goodreads only fills books Hardcover has
// nothing for. Never both, so nobody is counted twice.
export function mergeMember(hardcover, goodreads) {
  const merged = new Map(hardcover);
  for (const [id, v] of goodreads) if (!merged.has(id)) merged.set(id, v);
  return merged;
}

// Sorted by score, then review text, so the order says nothing about whose
// shelf an entry came from — and ratings.json only changes when a score does.
const byScore = (a, b) =>
  (b.rating ?? 0) - (a.rating ?? 0) || (a.review ?? "").localeCompare(b.review ?? "");

// Synopses are about the book, not the member, so there's nothing to
// anonymise. Keep what ratings.json already has.
function knownSynopses() {
  try {
    const { books } = JSON.parse(readFileSync(OUT, "utf8"));
    return new Map(Object.entries(books).filter(([, b]) => b.synopsis).map(([id, b]) => [id, b.synopsis]));
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const { members } = JSON.parse(readFileSync(join(root, "members.json"), "utf8"));
  const books = clubBooks();
  const match = matcher(books);
  const collected = new Map(books.map((b) => [b.id, []]));
  const synopses = knownSynopses();
  let matched = 0;

  for (const member of members) {
    const sources = { hardcover: [], goodreads: [] };
    const failures = [];

    if (member.hardcover_username) {
      try {
        sources.hardcover = await fetchHardcover(member.hardcover_username);
      } catch (err) {
        failures.push(`hardcover: ${err.message}`);
      }
    }
    if (member.goodreads_id) {
      try {
        sources.goodreads = await fetchGoodreads(member.goodreads_id);
      } catch (err) {
        failures.push(`goodreads: ${err.message}`);
      }
    }

    const tried = Number(Boolean(member.hardcover_username)) + Number(Boolean(member.goodreads_id));
    if (failures.length === tried) {
      // Nothing at all for this member. Writing now would silently drop their
      // ratings, so keep the last good ratings.json instead.
      console.error(`\n${member.name}: no source could be read`);
      failures.forEach((f) => console.error(`  ${f}`));
      console.error("Aborting — ratings.json left untouched.");
      process.exit(1);
    }
    failures.forEach((f) => console.warn(`${member.name}: skipped ${f}`));

    for (const row of [...sources.hardcover, ...sources.goodreads]) {
      const book = match(row);
      if (book && row.description && !synopses.has(book.id)) synopses.set(book.id, row.description);
    }

    const hc = verdicts(sources.hardcover, match);
    const gr = verdicts(sources.goodreads, match);
    const merged = mergeMember(hc, gr);
    for (const [id, v] of merged) collected.get(id).push(v);
    matched += merged.size;

    const fromGr = merged.size - hc.size;
    console.log(`${member.name.padEnd(6)} ${String(merged.size).padStart(3)} club books (${hc.size} Hardcover, ${fromGr} Goodreads)`);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
