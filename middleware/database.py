from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import AsyncGenerator, Optional

import asyncpg


logger = logging.getLogger(__name__)
_pool: Optional[asyncpg.Pool] = None


def database_config() -> dict:
    return {
        "user": os.getenv("POSTGRES_USER", "kaspi"),
        "password": os.getenv("POSTGRES_PASSWORD", "kaspi123"),
        "database": os.getenv("POSTGRES_DB", "kaspi"),
        "host": os.getenv("POSTGRES_HOST", "postgres"),
        "port": int(os.getenv("POSTGRES_PORT", "5432")),
    }


async def _init_connection(connection: asyncpg.Connection) -> None:
    for type_name in ("json", "jsonb"):
        await connection.set_type_codec(
            type_name,
            encoder=json.dumps,
            decoder=json.loads,
            schema="pg_catalog",
            format="text",
        )


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        try:
            _pool = await asyncpg.create_pool(
                **database_config(),
                min_size=1,
                max_size=10,
                init=_init_connection,
            )
        except Exception:
            logger.exception("Could not create PostgreSQL connection pool")
            raise
    return _pool


async def get_db() -> AsyncGenerator[asyncpg.Connection, None]:
    pool = await get_pool()
    try:
        async with pool.acquire() as connection:
            yield connection
    except Exception:
        logger.exception("Database dependency failed")
        raise


async def init_db() -> None:
    pool = await get_pool()
    schema_path = Path(__file__).with_name("schema.sql")
    schema_sql = schema_path.read_text(encoding="utf-8")
    try:
        async with pool.acquire() as connection:
            await connection.execute(schema_sql)
    except Exception:
        logger.exception("Database schema initialization failed")
        raise


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
