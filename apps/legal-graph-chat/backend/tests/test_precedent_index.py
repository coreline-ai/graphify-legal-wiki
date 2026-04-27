from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from app.db import database_url_from_env
from app.precedent_index import FilesystemPrecedentIndex, SQLitePrecedentIndex, create_precedent_index


def make_precedent_fixture(root: Path) -> Path:
    civil = root / "민사" / "대법원"
    criminal = root / "형사" / "하급심"
    civil.mkdir(parents=True)
    criminal.mkdir(parents=True)
    (civil / "2020다12345.md").write_text(
        """---
판례일련번호: '1'
사건번호: 2020다12345
사건명: 손해배상
법원명: 대법원
법원등급: 대법원
사건종류: 민사
출처: https://example.test/precedent/1
선고일자: 2020-01-02
---

# 손해배상

## 판결요지

민법상 계약 책임과 손해배상 범위를 판단한 사례입니다.
""",
        encoding="utf-8",
    )
    (criminal / "2021고단9.md").write_text(
        """---
판례일련번호: '2'
사건번호: 2021고단9
사건명: 개인정보보호법위반
법원명: 서울중앙지방법원
법원등급: 하급심
사건종류: 형사
출처: https://example.test/precedent/2
선고일자: 2021-03-04
---

# 개인정보보호법위반

## 판례내용

개인정보 처리와 보호 조치에 관한 사례입니다.
""",
        encoding="utf-8",
    )
    return root


def load_index_script():
    script = Path(__file__).resolve().parents[2] / "scripts" / "index_precedents.py"
    spec = importlib.util.spec_from_file_location("index_precedents_script", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_filesystem_precedent_index_search_health_and_source(tmp_path: Path):
    root = make_precedent_fixture(tmp_path / "data" / "precedent-kr")
    index = FilesystemPrecedentIndex(root)

    health = index.health()
    search = index.search("민법 손해배상", limit=5)
    source = index.source("민사/대법원/2020다12345.md")

    assert health.ok is True
    assert health.file_count == 2
    assert health.categories == ["민사", "형사"]
    assert search.results
    assert search.results[0].path == "민사/대법원/2020다12345.md"
    assert "민법상 계약 책임" in (search.results[0].snippet or "")
    assert "손해배상" in source.content


def test_sqlite_indexing_script_and_search_fixture(tmp_path: Path):
    root = make_precedent_fixture(tmp_path / "data" / "precedent-kr")
    db_path = tmp_path / "precedents.sqlite"
    index_script = load_index_script()

    stats = index_script.index_sqlite(root=root, database_path=db_path, dry_run=False, limit=1)
    dry_run_stats = index_script.index_sqlite(root=root, database_path=db_path, dry_run=True, limit=1)
    index = SQLitePrecedentIndex(db_path, root=root)
    search = index.search("민법", limit=5)

    assert stats.scanned == 1
    assert stats.inserted == 1
    assert db_path.exists()
    assert dry_run_stats.skipped == 1
    assert search.results
    assert search.results[0].path == "민사/대법원/2020다12345.md"
    assert index.source("민사/대법원/2020다12345.md").path == "민사/대법원/2020다12345.md"


def test_postgres_unavailable_falls_back_to_filesystem(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = make_precedent_fixture(tmp_path / "data" / "precedent-kr")
    monkeypatch.setenv("LEGAL_GRAPH_INDEX_BACKEND", "postgres")
    monkeypatch.delenv("LEGAL_GRAPH_DATABASE_URL", raising=False)

    index = create_precedent_index(root)
    health = index.health()
    search = index.search("개인정보", limit=5)

    assert isinstance(index, FilesystemPrecedentIndex)
    assert health.ok is True
    assert any("postgres_unavailable" in warning for warning in health.warnings)
    assert search.results
    assert search.results[0].path == "형사/하급심/2021고단9.md"


def test_database_url_can_be_loaded_from_secret_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    secret = tmp_path / "database_url"
    secret.write_text("postgresql://legal_graph:secret@postgres:5432/legal_graph\n", encoding="utf-8")
    monkeypatch.delenv("LEGAL_GRAPH_DATABASE_URL", raising=False)
    monkeypatch.setenv("LEGAL_GRAPH_DATABASE_URL_FILE", str(secret))

    assert database_url_from_env() == "postgresql://legal_graph:secret@postgres:5432/legal_graph"


def test_precedent_source_path_traversal_blocked_for_filesystem_and_sqlite(tmp_path: Path):
    root = make_precedent_fixture(tmp_path / "data" / "precedent-kr")
    db_path = tmp_path / "precedents.sqlite"
    index_script = load_index_script()
    index_script.index_sqlite(root=root, database_path=db_path, dry_run=False, limit=None)

    filesystem = FilesystemPrecedentIndex(root)
    sqlite_index = SQLitePrecedentIndex(db_path, root=root)

    for index in (filesystem, sqlite_index):
        with pytest.raises(PermissionError):
            index.source("../secret.md")
        with pytest.raises(PermissionError):
            index.source(str(root / "민사" / "대법원" / "2020다12345.md"))
        with pytest.raises(PermissionError):
            index.source("민사/.hidden/secret.md")
