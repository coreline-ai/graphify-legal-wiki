from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    limit: int
    remaining: int
    retry_after_seconds: int
    route_key: str | None = None


@dataclass(frozen=True)
class TokenBucketConfig:
    route_key: str
    capacity: int
    refill_per_second: float


@dataclass
class _Bucket:
    tokens: float
    updated_at: float


class InProcessTokenBucketRateLimiter:
    """Small endpoint-scoped in-process token bucket.

    This is intentionally process-local; production deployments should keep the
    defaults generous or put a shared limiter at the trusted proxy layer.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._buckets: dict[tuple[str, str], _Bucket] = {}

    def reset(self) -> None:
        self._buckets.clear()

    def check(self, path: str, identity: str) -> RateLimitDecision:
        if not _env_bool("LEGAL_GRAPH_RATE_LIMIT_ENABLED", default=False):
            return RateLimitDecision(allowed=True, limit=0, remaining=0, retry_after_seconds=0)
        config = config_for_path(path)
        if config is None:
            return RateLimitDecision(allowed=True, limit=0, remaining=0, retry_after_seconds=0)
        now = self._clock()
        key = (config.route_key, identity or "anonymous")
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _Bucket(tokens=float(config.capacity), updated_at=now)
            self._buckets[key] = bucket
        elapsed = max(0.0, now - bucket.updated_at)
        if config.refill_per_second > 0:
            bucket.tokens = min(float(config.capacity), bucket.tokens + elapsed * config.refill_per_second)
        bucket.updated_at = now
        if bucket.tokens >= 1.0:
            bucket.tokens -= 1.0
            return RateLimitDecision(
                allowed=True,
                limit=config.capacity,
                remaining=max(0, int(bucket.tokens)),
                retry_after_seconds=0,
                route_key=config.route_key,
            )
        retry_after = 60 if config.refill_per_second <= 0 else max(1, int((1.0 - bucket.tokens) / config.refill_per_second))
        return RateLimitDecision(
            allowed=False,
            limit=config.capacity,
            remaining=0,
            retry_after_seconds=retry_after,
            route_key=config.route_key,
        )


def config_for_path(path: str) -> TokenBucketConfig | None:
    route_key = {
        "/answer": "ANSWER",
        "/source": "SOURCE",
        "/precedents/source": "PRECEDENTS_SOURCE",
        "/graph/full-3d": "GRAPH_FULL_3D",
    }.get(path)
    if route_key is None:
        return None
    defaults = {
        "ANSWER": (30, 60.0),
        "SOURCE": (120, 240.0),
        "PRECEDENTS_SOURCE": (120, 240.0),
        "GRAPH_FULL_3D": (10, 30.0),
    }
    default_burst, default_per_minute = defaults[route_key]
    burst = _env_int(f"LEGAL_GRAPH_RATE_LIMIT_{route_key}_BURST", default_burst, minimum=1, maximum=10_000)
    per_minute = _env_float(f"LEGAL_GRAPH_RATE_LIMIT_{route_key}_PER_MINUTE", default_per_minute, minimum=0.0, maximum=1_000_000.0)
    return TokenBucketConfig(route_key=route_key.lower(), capacity=burst, refill_per_second=per_minute / 60.0)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def _env_float(name: str, default: float, *, minimum: float, maximum: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))
