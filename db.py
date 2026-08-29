"""SQLite persistence for cards and review history."""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
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


def get_all_cards(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, slug, url, title, insight, due FROM cards ORDER BY due ASC"
    ).fetchall()


def delete_card(conn: sqlite3.Connection, *, card_id: int) -> bool:
    cursor = conn.execute("DELETE FROM cards WHERE id = ?", (card_id,))
    conn.commit()
    return cursor.rowcount > 0


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


def get_review_heatmap(conn: sqlite3.Connection, *, year: int | None = None) -> dict:
    """Per-day review counts for one calendar year, on a Sunday-aligned grid.

    The grid starts on the Sunday on or before Jan 1, so the first and last columns
    can hold cells belonging to the neighbouring years; the client draws those empty.
    """
    today = datetime.now(timezone.utc).date()
    year = year or today.year
    range_start = date(year, 1, 1)
    range_end = date(year, 12, 31)
    grid_start = range_start - timedelta(days=(range_start.weekday() + 1) % 7)
    weeks = (range_end - grid_start).days // 7 + 1

    rows = conn.execute(
        """
        SELECT date(reviewed_at) AS d, COUNT(*) AS c
        FROM review_log
        WHERE date(reviewed_at) BETWEEN ? AND ?
        GROUP BY d
        """,
        (range_start.isoformat(), range_end.isoformat()),
    ).fetchall()

    counts = {r["d"]: r["c"] for r in rows}
    return {
        "year": year,
        "grid_start": grid_start.isoformat(),
        "range_start": range_start.isoformat(),
        "range_end": range_end.isoformat(),
        "today": today.isoformat(),
        "weeks": weeks,
        "counts": counts,
        "total": sum(counts.values()),
        "max": max(counts.values(), default=0),
    }


def get_streak_stats(conn: sqlite3.Connection) -> dict:
    rows = conn.execute(
        "SELECT DISTINCT date(reviewed_at) AS d FROM review_log ORDER BY d DESC"
    ).fetchall()
    dates = [datetime.strptime(r["d"], "%Y-%m-%d").date() for r in rows]
    total_reviews = conn.execute("SELECT COUNT(*) AS c FROM review_log").fetchone()["c"]

    if not dates:
        return {
            "current_streak": 0,
            "longest_streak": 0,
            "reviewed_today": False,
            "total_reviews": 0,
        }

    today = datetime.now(timezone.utc).date()
    date_set = set(dates)
    reviewed_today = today in date_set

    cursor = today if reviewed_today else today - timedelta(days=1)
    current_streak = 0
    while cursor in date_set:
        current_streak += 1
        cursor -= timedelta(days=1)

    ascending = sorted(dates)
    longest_streak = run = 1
    for prev, curr in zip(ascending, ascending[1:]):
        run = run + 1 if (curr - prev).days == 1 else 1
        longest_streak = max(longest_streak, run)
    longest_streak = max(longest_streak, current_streak)

    return {
        "current_streak": current_streak,
        "longest_streak": longest_streak,
        "reviewed_today": reviewed_today,
        "total_reviews": total_reviews,
    }
