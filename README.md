# Page-Lifters Book Club

A card-catalogue reading list. One markdown file per book in `books/`, one
command to rebuild the page.

```bash
node build.mjs      # writes index.html
open index.html     # or: python3 -m http.server 8830
```

No dependencies, no framework. Node 18+.

## Adding a book

Create `books/some-title.md`. Everything except `title` is optional.

```markdown
---
title: Piranesi
author: Susanna Clarke
year: 2020
isbn: "9781635575637"
goodreads: https://www.goodreads.com/book/show/50202953-piranesi
chosen_by: Paul
read: 2026-02-11
ratings:
  Paul: 5
  Aoife: 4.5
  Dave: 4
  Niamh: 5
---
Anything below the front matter is a free-text note shown on the card.
Supports **bold**, *italic* and [links](https://example.com).
```

### Fields

| Field | What it does |
|---|---|
| `title` | Book title. The only required field. |
| `author` | Shown under the title. |
| `year` | First published. |
| `isbn` | Fetches the cover from Open Library. **Keep the quotes.** |
| `cover` | A local image path, if you'd rather not use the ISBN. Wins over `isbn`. |
| `goodreads` | Adds the Goodreads link. |
| `chosen_by` | Whose pick it was. |
| `read` | The date you finished it (`YYYY-MM-DD`). Its presence is what marks a book as read. |
| `reading` | `true` while you're partway through. |
| `ratings` | One line per member, indented two spaces. Averaged for the score. |
| `rating` | A single number, if you'd rather not record everyone separately. |

### Which shelf a book lands on

- `read:` set → **Read**, with its score
- `reading: true` → **Currently reading**
- neither → **On the shelf**

A book with `read:` but no ratings shows "Ratings still coming in", so you can
log it the night of and score it later.

## Covers

With an `isbn`, covers come from Open Library:
`https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg`. If they don't have that
edition the card falls back to the title on a plain board — try a different
edition's ISBN, or drop a file in and point `cover:` at it.

## Layout

```
books/*.md      one file per book — the only thing you edit
build.mjs       reads books/, writes index.html
style.css       the whole design
index.html      generated — don't edit by hand
```
