#!/usr/bin/env node
// Reads books/*.md and writes index.html. No dependencies — `node build.mjs`.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const BOOKS_DIR = join(root, "books");

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

// Quoted values stay strings, so ISBNs keep their leading digits intact.
function coerce(raw) {
  const trimmed = raw.trim();
  const quoted = /^(["']).*\1$/.test(trimmed);
  const value = quoted ? trimmed.slice(1, -1) : trimmed;
  if (quoted) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

// A deliberately small YAML subset: `key: value`, plus one level of indented
// keys underneath a bare `key:` (used for per-member ratings).
function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw.trim() };

  const data = {};
  let nested = null;

  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const child = line.match(/^\s+([^:]+):\s*(.*)$/);
    if (child && nested) {
      nested[child[1].trim()] = coerce(child[2]);
      continue;
    }
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) continue;

    const [, key, value] = top;
    if (value.trim() === "") {
      nested = {};
      data[key] = nested;
    } else {
      data[key] = coerce(value);
      nested = null;
    }
  }
  return { data, body: match[2].trim() };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Just enough markdown for a note: paragraphs, bold, italic, links.
function renderNote(body) {
  if (!body) return "";
  return body
    .split(/\n\s*\n/)
    .map((para) => {
      const html = esc(para.trim())
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\n/g, "<br>");
      return `<p>${html}</p>`;
    })
    .join("");
}

function averageRating(data) {
  if (data.ratings && typeof data.ratings === "object") {
    const scores = Object.values(data.ratings).filter((n) => typeof n === "number");
    if (scores.length) {
      return { value: scores.reduce((a, b) => a + b, 0) / scores.length, count: scores.length };
    }
  }
  if (typeof data.rating === "number") return { value: data.rating, count: null };
  return null;
}

function coverUrl(data) {
  if (data.cover) return data.cover;
  if (data.isbn) return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(data.isbn)}-L.jpg?default=false`;
  return null;
}

function formatDate(value) {
  if (typeof value !== "string") return "";
  const d = new Date(value);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-IE", { month: "long", year: "numeric" });
}

function stars(value) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    `<span class="stars" role="img" aria-label="${value.toFixed(1)} out of 5">` +
    `<span class="stars-empty">★★★★★</span>` +
    `<span class="stars-full" style="width:${pct.toFixed(1)}%">★★★★★</span>` +
    `</span>`
  );
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

function loadBooks() {
  const files = readdirSync(BOOKS_DIR).filter((f) => f.endsWith(".md")).sort();

  const books = files.map((file) => {
    const { data, body } = parseFrontMatter(readFileSync(join(BOOKS_DIR, file), "utf8"));
    const rating = averageRating(data);
    const status = data.read ? "read" : data.reading ? "reading" : "shelf";
    return {
      file,
      title: data.title || file.replace(/\.md$/, ""),
      author: data.author || "Unknown",
      year: data.year,
      goodreads: data.goodreads,
      cover: coverUrl(data),
      chosenBy: data.chosen_by,
      note: renderNote(body),
      readDate: typeof data.read === "string" ? data.read : null,
      ratings: data.ratings && typeof data.ratings === "object" ? data.ratings : null,
      rating,
      status,
    };
  });

  // Catalogue numbers follow the shelf, so a book keeps its number as the
  // club grows.
  [...books]
    .sort((a, b) => a.title.localeCompare(b.title))
    .forEach((book, i) => { book.no = String(i + 1).padStart(3, "0"); });

  return books;
}

function bookCard(book, index) {
  const tilt = ((index % 5) - 2) * 0.35;
  const cover = book.cover
    ? `<img src="${esc(book.cover)}" alt="Cover of ${esc(book.title)}" loading="lazy"
         onerror="this.closest('.cover').classList.add('cover-missing');this.remove()">`
    : "";

  const meta = [];
  if (book.year) meta.push(esc(book.year));
  if (book.status === "read" && book.readDate) meta.push(`Read ${esc(formatDate(book.readDate))}`);
  if (book.chosenBy) meta.push(`Chosen by ${esc(book.chosenBy)}`);

  let verdict = "";
  if (book.rating) {
    const tally = book.ratings
      ? Object.entries(book.ratings)
          .map(([who, score]) => `<li><span>${esc(who)}</span><b>${esc(score)}</b></li>`)
          .join("")
      : "";
    verdict =
      `<div class="verdict">` +
      `<div class="score">${stars(book.rating.value)}<b>${book.rating.value.toFixed(1)}</b><span>/ 5</span></div>` +
      (book.rating.count ? `<p class="tally-label">${book.rating.count} member${book.rating.count === 1 ? "" : "s"} rated</p>` : "") +
      (tally ? `<ul class="tally">${tally}</ul>` : "") +
      `</div>`;
  } else if (book.status === "read") {
    verdict = `<div class="verdict"><p class="pending">Ratings still coming in</p></div>`;
  }

  const stamp =
    book.status === "read"
      ? `<div class="stamp stamp-read">Read</div>`
      : book.status === "reading"
      ? `<div class="stamp stamp-reading">Reading<br><span>now</span></div>`
      : "";

  return `
    <article class="card card-${book.status}" style="--tilt:${tilt}deg;--delay:${index * 60}ms">
      <div class="card-no">№ ${esc(book.no)}</div>
      <div class="cover">${cover}<span class="cover-fallback">${esc(book.title)}</span></div>
      <div class="card-body">
        <div class="card-head">
          <h3 class="title">${esc(book.title)}</h3>
          <p class="author">${esc(book.author)}</p>
        </div>
        ${meta.length ? `<p class="meta">${meta.join(" &middot; ")}</p>` : ""}
        ${book.note ? `<div class="note">${book.note}</div>` : ""}
        ${verdict}
        <div class="card-foot">
          ${book.goodreads ? `<a class="goodreads" href="${esc(book.goodreads)}" target="_blank" rel="noopener">Goodreads <span aria-hidden="true">↗</span></a>` : ""}
          ${stamp}
        </div>
      </div>
    </article>`;
}

function section(title, blurb, books, startIndex) {
  if (!books.length) return "";
  return `
    <section class="shelf">
      <div class="shelf-head">
        <h2>${esc(title)}</h2>
        <p>${esc(blurb)}</p>
      </div>
      <div class="cards">${books.map((b, i) => bookCard(b, startIndex + i)).join("")}</div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function build() {
  const books = loadBooks();

  const reading = books.filter((b) => b.status === "reading");
  const shelf = books.filter((b) => b.status === "shelf");
  const read = books
    .filter((b) => b.status === "read")
    .sort((a, b) => (b.readDate || "").localeCompare(a.readDate || ""));

  const rated = read.filter((b) => b.rating);
  const clubAverage = rated.length
    ? rated.reduce((sum, b) => sum + b.rating.value, 0) / rated.length
    : null;

  const stats = [
    { value: books.length, label: books.length === 1 ? "book" : "books" },
    { value: read.length, label: "read" },
    { value: shelf.length + reading.length, label: "to come" },
    clubAverage ? { value: clubAverage.toFixed(1), label: "club average" } : null,
  ].filter(Boolean);

  let index = 0;
  const sections = [
    section("Currently reading", "On the go right now.", reading, (index += 0)),
    section("On the shelf", "Chosen, waiting their turn.", shelf, (index += reading.length)),
    section("Read", "Finished, argued about, scored.", read, (index += shelf.length)),
  ].join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Page-Lifters Book Club</title>
<meta name="description" content="The reading list, the verdicts and the scores from the Page-Lifters Book Club.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📕</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400&family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="style.css">
</head>
<body>
<div class="grain" aria-hidden="true"></div>

<header class="masthead">
  <p class="kicker">Card Catalogue &middot; Est. 2026</p>
  <h1><span>Page-Lifters</span><em>Book Club</em></h1>
  <div class="rule"></div>
  <dl class="stats">
    ${stats.map((s) => `<div><dt>${esc(s.value)}</dt><dd>${esc(s.label)}</dd></div>`).join("")}
  </dl>
</header>

<main>${sections}</main>

<footer>
  <p>Kept by hand in markdown. Covers via Open Library.</p>
</footer>
</body>
</html>
`;

  writeFileSync(join(root, "index.html"), html);
  console.log(`Built index.html — ${books.length} books (${read.length} read, ${reading.length} reading, ${shelf.length} on the shelf)`);
}

build();
