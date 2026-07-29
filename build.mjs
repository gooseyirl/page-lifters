#!/usr/bin/env node
// Reads books/*.md and writes index.html. No dependencies — `node build.mjs`.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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

// Members' scores, pulled from Goodreads by fetch-ratings.mjs. Entries arrive
// anonymous and shuffled; nothing here reintroduces a name.
function loadRatings() {
  const path = join(root, "ratings.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")).books ?? {};
  } catch {
    console.warn("ratings.json couldn't be read — building without scores.");
    return {};
  }
}

// Publisher blurbs run long; the panel wants a paragraph, not a page. The full
// text still ships — the panel keeps it a "See more" away.
function shorten(text, limit = 420) {
  if (!text || text.length <= limit) return text ?? "";
  const cut = text.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (stop > limit * 0.6 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
}

function goodreadsId(url) {
  const m = String(url ?? "").match(/\/book\/show\/(\d+)/);
  return m ? m[1] : null;
}

// How many members gave each score — 5 down to 1, always all five rows so the
// shape of the club's opinion is visible at a glance.
function breakdown(entries) {
  const counts = [5, 4, 3, 2, 1].map((star) => ({
    star,
    count: entries.filter((e) => Math.round(e.rating) === star).length,
  }));
  const most = Math.max(1, ...counts.map((c) => c.count));
  return counts.map((c) => ({ ...c, share: (c.count / most) * 100 }));
}

function averageRating(entries, data) {
  const scores = entries.map((e) => e.rating).filter((n) => typeof n === "number");
  if (scores.length) {
    return { value: scores.reduce((a, b) => a + b, 0) / scores.length, count: scores.length };
  }
  // Manual fallback for a book nobody logged on Goodreads.
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
  const allRatings = loadRatings();

  const books = files.map((file) => {
    const { data, body } = parseFrontMatter(readFileSync(join(BOOKS_DIR, file), "utf8"));
    const record = allRatings[goodreadsId(data.goodreads)] ?? {};
    const entries = record.entries ?? [];
    const rating = averageRating(entries, data);
    const status = data.read ? "read" : data.reading ? "reading" : "shelf";
    const synopsis = String(data.synopsis ?? record.synopsis ?? "");
    return {
      file,
      id: `book-${file.replace(/\.md$/, "").replace(/[^a-z0-9-]/gi, "")}`,
      synopsis,
      synopsisShort: shorten(synopsis),
      breakdown: breakdown(entries),
      title: data.title || file.replace(/\.md$/, ""),
      author: data.author || "Unknown",
      year: data.year,
      order: typeof data.order === "number" ? data.order : null,
      goodreads: data.goodreads,
      cover: coverUrl(data),
      chosenBy: data.chosen_by,
      note: renderNote(body),
      readDate: typeof data.read === "string" ? data.read : null,
      reviews: entries.map((e) => e.review).filter(Boolean),
      rating,
      status,
    };
  });

  // Catalogue numbers follow the order the club read them, so a book's number
  // is a fact about the club rather than an artefact of sorting. Anything
  // without an explicit order falls in behind, alphabetically.
  const numbered = [...books].sort((a, b) => {
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return a.title.localeCompare(b.title);
  });
  numbered.forEach((book, i) => {
    book.no = String(book.order ?? i + 1).padStart(3, "0");
  });

  return books;
}

// The slide-out for one book. Rendered inert into the page and revealed by
// the small script at the foot — no data duplicated into JavaScript.
function bookPanel(book) {
  const cover = book.cover
    ? `<img src="${esc(book.cover)}" alt="Cover of ${esc(book.title)}" loading="lazy">`
    : `<span class="cover-fallback" style="display:flex">${esc(book.title)}</span>`;

  const rated = book.breakdown.some((row) => row.count);
  const bars = book.breakdown
    .map(
      (row) =>
        `<li${row.count ? "" : ' class="empty"'}>` +
        `<span class="bd-star">${row.star}<i aria-hidden="true">★</i></span>` +
        `<span class="bd-track"><span class="bd-fill" style="width:${row.share}%"></span></span>` +
        `<span class="bd-count">${row.count}</span></li>`
    )
    .join("");

  const reviews = book.reviews.map((text) => `<li>${renderNote(text)}</li>`).join("");

  // A trimmed blurb by default; the rest sits alongside it, one tap away.
  const clipped = book.synopsisShort !== book.synopsis;
  const synopsis = book.synopsis
    ? `<div class="panel-block"><h3>Synopsis</h3>` +
      `<div class="panel-prose">${renderNote(clipped ? book.synopsisShort : book.synopsis)}</div>` +
      (clipped
        ? `<div class="panel-prose panel-prose-full" hidden>${renderNote(book.synopsis)}</div>` +
          `<button class="see-more" type="button" data-more aria-expanded="false">See more</button>`
        : "") +
      `</div>`
    : "";

  return `
    <aside class="panel" id="${esc(book.id)}" role="dialog" aria-modal="true" aria-label="${esc(book.title)}" hidden>
      <button class="panel-close" type="button" data-close aria-label="Close">&#10005;</button>
      <div class="panel-scroll">
        <div class="panel-cover">${cover}</div>
        <h2 class="panel-title">${esc(book.title)}</h2>
        <p class="panel-author">${esc(book.author)}${book.year ? ` &middot; ${esc(book.year)}` : ""}</p>

        ${
          book.rating
            ? `<div class="panel-score">${stars(book.rating.value)}<b>${book.rating.value.toFixed(1)}</b><span>/ 5</span></div>` +
              (rated
                ? `<p class="panel-label">${book.rating.count} rating${book.rating.count === 1 ? "" : "s"}</p>
                   <ul class="breakdown">${bars}</ul>`
                : "")
            : `<p class="panel-label">${book.status === "read" ? "Ratings still coming in" : "Not rated yet"}</p>`
        }

        ${synopsis}
        ${book.note ? `<div class="panel-block"><h3>Club note</h3><div class="panel-prose">${book.note}</div></div>` : ""}
        ${
          reviews
            ? `<div class="panel-block"><h3>Reviews</h3><ul class="panel-reviews">${reviews}</ul></div>`
            : book.rating
            ? `<div class="panel-block"><h3>Reviews</h3><p class="panel-label">Nobody's written one yet</p></div>`
            : ""
        }
        ${book.goodreads ? `<a class="goodreads" href="${esc(book.goodreads)}" target="_blank" rel="noopener">Goodreads <span aria-hidden="true">↗</span></a>` : ""}
      </div>
    </aside>`;
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

  // Scores belong to the club, not to named people — no attribution anywhere
  // in the markup, and the reviews are already shuffled by fetch-ratings.mjs.
  let verdict = "";
  if (book.status === "read") {
    if (book.rating) {
      // The breakdown and reviews live in the panel; the card stays a card.
      verdict =
        `<div class="verdict">` +
        `<div class="score">${stars(book.rating.value)}<b>${book.rating.value.toFixed(1)}</b><span>/ 5</span></div>` +
        (book.rating.count
          ? `<p class="tally-label">${book.rating.count} rating${book.rating.count === 1 ? "" : "s"}` +
            (book.reviews.length ? ` &middot; ${book.reviews.length} review${book.reviews.length === 1 ? "" : "s"}` : "") +
            `</p>`
          : "") +
        `</div>`;
    } else {
      verdict = `<div class="verdict"><p class="pending">Ratings still coming in</p></div>`;
    }
  }

  const stamp =
    book.status === "read"
      ? `<div class="stamp stamp-read">Read</div>`
      : book.status === "reading"
      ? `<div class="stamp stamp-reading">Reading<br><span>now</span></div>`
      : "";

  return `
    <article class="card card-${book.status}" data-panel="${esc(book.id)}"
             role="button" tabindex="0" aria-label="Details for ${esc(book.title)}"
             style="--tilt:${tilt}deg;--delay:${index * 60}ms">
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
        ${blurb ? `<p>${esc(blurb)}</p>` : ""}
      </div>
      <div class="cards">${books.map((b, i) => bookCard(b, startIndex + i)).join("")}</div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// GitHub Pages serves the stylesheet with a four-hour cache and no version, so
// a design change can sit invisible behind a stale copy. Stamping the content
// hash onto the URL makes every change a new URL.
function assetVersion(file) {
  const path = join(root, file);
  if (!existsSync(path)) return "";
  return "?v=" + createHash("sha1").update(readFileSync(path)).digest("hex").slice(0, 8);
}

function build() {
  const books = loadBooks();

  const reading = books.filter((b) => b.status === "reading");
  const shelf = books.filter((b) => b.status === "shelf");
  // Most recently read first: by reading order where the club recorded one,
  // otherwise by the date it was finished.
  const read = books
    .filter((b) => b.status === "read")
    .sort((a, b) => {
      if (a.order != null && b.order != null) return b.order - a.order;
      return (b.readDate || "").localeCompare(a.readDate || "");
    });

  const rated = read.filter((b) => b.rating);
  const clubAverage = rated.length
    ? rated.reduce((sum, b) => sum + b.rating.value, 0) / rated.length
    : null;

  const stats = [
    { value: books.length, label: books.length === 1 ? "book" : "books" },
    { value: read.length, label: "read" },
    clubAverage ? { value: clubAverage.toFixed(1), label: "club average" } : null,
  ].filter(Boolean);

  const sections = [
    section("Currently reading", "", reading, 0),
    section("On the shelf", "Chosen, waiting their turn.", shelf, reading.length),
    section("Read", "Finished, argued about, scored.", read, reading.length + shelf.length),
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
<link rel="stylesheet" href="style.css${assetVersion("style.css")}">
</head>
<body>
<div class="grain" aria-hidden="true"></div>

<header class="masthead">
  <p class="kicker">Est. 2026</p>
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

<div class="panel-overlay" data-close hidden></div>
${books.map(bookPanel).join("")}

<script>
(function () {
  var overlay = document.querySelector('.panel-overlay');
  var open = null;
  var lastFocus = null;

  // A hash only counts if it names one of the panels.
  function isPanel(id) {
    var el = id && document.getElementById(id);
    return !!el && el.classList.contains('panel');
  }

  // An open panel is a place in the history, so the back button leaves it and
  // a copied URL opens straight onto the book. A replayed call is one the
  // history itself asked for, and must not push a fresh entry.
  function show(id, replayed) {
    var panel = document.getElementById(id);
    if (!panel || panel === open) return;
    var swapping = !!open;
    hide();
    lastFocus = document.activeElement;
    panel.hidden = false;
    overlay.hidden = false;
    // Flush layout so the transition has a closed state to start from. A
    // requestAnimationFrame would be the usual trick, but it never fires while
    // the document is hidden, which would leave the panel open yet off-screen.
    void panel.offsetWidth;
    panel.classList.add('open');
    overlay.classList.add('open');
    document.body.classList.add('panel-is-open');
    open = panel;
    panel.querySelector('[data-close]').focus();
    if (replayed) return;
    // One entry per visit to the panels, not one per book looked at.
    history[swapping ? 'replaceState' : 'pushState']({ panel: id }, '', '#' + id);
  }

  // Leaving is a navigation; the popstate handler does the closing.
  function dismiss() {
    if (open) history.back();
  }

  function hide() {
    if (!open) return;
    var panel = open;
    open = null;
    panel.classList.remove('open');
    overlay.classList.remove('open');
    document.body.classList.remove('panel-is-open');
    window.setTimeout(function () {
      if (!panel.classList.contains('open')) { panel.hidden = true; overlay.hidden = true; }
    }, 320);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // Swap the trimmed blurb for the whole thing, and back again.
  function toggle(btn) {
    var block = btn.parentNode;
    var full = block.querySelector('.panel-prose-full');
    var brief = block.querySelector('.panel-prose:not(.panel-prose-full)');
    var expanded = btn.getAttribute('aria-expanded') === 'true';
    brief.hidden = !expanded;
    full.hidden = expanded;
    btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    btn.textContent = expanded ? 'See more' : 'See less';
  }

  window.addEventListener('popstate', function (e) {
    var id = (e.state && e.state.panel) || location.hash.slice(1);
    if (id && isPanel(id)) show(id, true); else hide();
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) { dismiss(); return; }
    var more = e.target.closest('[data-more]');
    if (more) { toggle(more); return; }
    // Anywhere on a card counts, except the links inside it.
    var card = e.target.closest('.card[data-panel]');
    if (card && !e.target.closest('a')) show(card.getAttribute('data-panel'));
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { dismiss(); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target.closest && e.target.closest('.card[data-panel]');
    if (!card || e.target.closest('a')) return;
    e.preventDefault();
    show(card.getAttribute('data-panel'));
  });

  // Landing on a book's URL opens it. The bare page is slipped in underneath
  // first, so back lands on the shelves instead of leaving the site.
  var landed = location.hash.slice(1);
  if (isPanel(landed)) {
    history.replaceState(null, '', location.pathname + location.search);
    show(landed);
    // Put the book's card behind the panel, so closing it leaves the reader at
    // the book they followed the link to.
    var card = document.querySelector('.card[data-panel="' + landed + '"]');
    if (card) card.scrollIntoView({ block: 'center' });
  }
})();
</script>
</body>
</html>
`;

  writeFileSync(join(root, "index.html"), html);
  console.log(`Built index.html — ${books.length} books (${read.length} read, ${reading.length} reading, ${shelf.length} on the shelf)`);
}

build();
