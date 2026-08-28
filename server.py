from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
from fsrs import Rating

app = FastAPI()

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ReviewIn(BaseModel):
    rating: int
    elapsed_seconds: int | None = None


class CardIn(BaseModel):
    url: str
    insight: str
    title: str | None = None


class CardUpdateIn(BaseModel):
    url: str | None = None
    insight: str | None = None
    title: str | None = None


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/queue")
def queue() -> list[dict]:
    conn = db.connect()
    try:
        rows = db.get_due_queue(conn)
        return [
            {
                "id": r["id"],
                "slug": r["slug"],
                "url": r["url"],
                "title": r["title"],
                "insight": r["insight"],
                "due": r["due"],
            }
            for r in rows
        ]
    finally:
        conn.close()


@app.post("/api/cards")
def create_card(body: CardIn) -> dict:
    url = body.url.strip()
    insight = body.insight.strip()
    title = body.title.strip() if body.title else None
    if not url:
        raise HTTPException(status_code=422, detail="url is required")
    if not insight:
        raise HTTPException(status_code=422, detail="insight is required")

    conn = db.connect()
    try:
        result = db.create_card(conn, url=url, insight=insight, title=title)
        if not result.created:
            raise HTTPException(status_code=409, detail=result.warning)
        return {"ok": True, "id": result.card_id}
    finally:
        conn.close()


@app.patch("/api/cards/{card_id}")
def update_card(card_id: int, body: CardUpdateIn) -> dict:
    url = body.url.strip() if body.url is not None else None
    title = body.title.strip() if body.title is not None else None
    insight = body.insight.strip() if body.insight is not None else None
    if url == "":
        raise HTTPException(status_code=422, detail="url cannot be empty")
    if insight == "":
        raise HTTPException(status_code=422, detail="insight cannot be empty")

    conn = db.connect()
    try:
        ok = db.update_card(conn, card_id=card_id, url=url, title=title, insight=insight)
        if not ok:
            raise HTTPException(status_code=404, detail=f"no card with id {card_id}")
        return {"ok": True}
    finally:
        conn.close()


@app.post("/api/reviews/{card_id}")
def submit_review(card_id: int, body: ReviewIn) -> dict:
    if body.rating not in (1, 2, 3, 4):
        raise HTTPException(status_code=422, detail="rating must be 1-4 (Again/Hard/Good/Easy)")

    conn = db.connect()
    try:
        try:
            db.record_review(
                conn,
                card_id=card_id,
                rating=Rating(body.rating),
                elapsed_seconds=body.elapsed_seconds,
            )
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
    finally:
        conn.close()
    return {"ok": True}
