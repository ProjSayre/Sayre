from datetime import datetime, timezone

from fastapi import FastAPI

app = FastAPI(title="Sayre Workers")


@app.get("/")
def root() -> dict:
    return {"message": "Sayre worker fleet"}


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "workers",
        "version": "0.1.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
