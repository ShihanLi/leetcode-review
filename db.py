"""SQLite persistence for cards and review history."""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fsrs import Card, Rating

from scheduler import get_scheduler

DB_PATH = Path(__file__).parent / "data" / "review.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    insight TEXT NOT NULL,
    fsrs_state TEXT NOT NULL,
    due TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);

CREATE TABLE IF NOT EXISTS review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id),
    rating INTEGER NOT NULL,
    reviewed_at TEXT NOT NULL,
    elapsed_seconds INTEGER
);
"""

SLUG_FROM_URL_RE = re.compile(r"/problems/([a-z0-9-]+)")
NON_SLUG_CHARS_RE = re.compile(r"[^a-z0-9]+")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def derive_slug(url: str) -> str:
    match = SLUG_FROM_URL_RE.search(url)
    if match:
        return match.group(1)
    stripped = re.sub(r"^https?://", "", url.lower()).rstrip("/")
    return NON_SLUG_CHARS_RE.sub("-", stripped).strip("-")


def derive_title(slug: str) -> str:
    return slug.replace("-", " ").title()


@dataclass
class CreateResult:
    card_id: int | None
    created: bool
    warning: str | None = None


def create_card(
    conn: sqlite3.Connection,
    *,
    url: str,
    insight: str,
    title: str | None = None,
) -> CreateResult:
    slug = derive_slug(url)
    title = title or derive_title(slug)

    existing = conn.execute("SELECT id FROM cards WHERE slug = ?", (slug,)).fetchone()
    if existing is not None:
        return CreateResult(
            card_id=None,
            created=False,
            warning=f"a card for '{slug}' already exists",
        )

    card = Card()
    now = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        """
        INSERT INTO cards (slug, url, title, insight, fsrs_state, due, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            slug,
            url,
            title,
            insight,
            json.dumps(card.to_dict()),
            card.due.isoformat(),
            now,
        ),
    )
    conn.commit()
    return CreateResult(card_id=cursor.lastrowid, created=True)


def update_card(
    conn: sqlite3.Connection,
    *,
    card_id: int,
    url: str | None = None,
    title: str | None = None,
    insight: str | None = None,
) -> bool:
    row = conn.execute("SELECT id FROM cards WHERE id = ?", (card_id,)).fetchone()
    if row is None:
        return False

    fields, values = [], []
    for column, value in (("url", url), ("title", title), ("insight", insight)):
        if value is not None:
            fields.append(f"{column} = ?")
            values.append(value)
    if fields:
        values.append(card_id)
        conn.execute(f"UPDATE cards SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
    return True


def get_due_queue(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    now = datetime.now(timezone.utc).isoformat()
    return conn.execute(
        "SELECT id, slug, url, title, insight, due FROM cards WHERE due <= ? ORDER BY due ASC",
        (now,),
    ).fetchall()


def record_review(
    conn: sqlite3.Connection,
    *,
    card_id: int,
    rating: Rating,
    elapsed_seconds: int | None,
) -> None:
    row = conn.execute(
        "SELECT fsrs_state FROM cards WHERE id = ?", (card_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"no card with id {card_id}")

    card = Card.from_dict(json.loads(row["fsrs_state"]))
    scheduler = get_scheduler()
    review_duration_ms = elapsed_seconds * 1000 if elapsed_seconds is not None else None
    updated_card, _review_log = scheduler.review_card(
        card, rating, review_duration=review_duration_ms
    )

    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "UPDATE cards SET fsrs_state = ?, due = ? WHERE id = ?",
        (json.dumps(updated_card.to_dict()), updated_card.due.isoformat(), card_id),
    )
    conn.execute(
        """
        INSERT INTO review_log (card_id, rating, reviewed_at, elapsed_seconds)
        VALUES (?, ?, ?, ?)
        """,
        (card_id, int(rating), now, elapsed_seconds),
    )
    conn.commit()
