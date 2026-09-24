import os
import tempfile

# Must be set before the app package is imported: the engine is built at import time.
_TMP = tempfile.mkdtemp(prefix="arena-test-")
os.environ["ARENA_DATABASE_URL"] = f"sqlite+aiosqlite:///{_TMP}/test.db"
os.environ["ARENA_SECRET_KEY"] = "test-secret"

import pytest
from fastapi.testclient import TestClient

from app.auth import hash_token, new_device_token
from app.db import Base, SessionLocal, engine
from app.main import app
from app.models import Device, User


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
async def clean_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield


async def make_user(handle: str, github_id: int) -> tuple[str, str]:
    """Create a user with a paired device. Returns (user_id, device_token)."""
    token = new_device_token()
    async with SessionLocal() as db:
        user = User(
            github_id=github_id, handle=handle,
            display_name=handle.title(), avatar_url="",
        )
        db.add(user)
        await db.flush()
        db.add(Device(user_id=user.id, token_hash=hash_token(token), label="test"))
        await db.commit()
        return user.id, token


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}
