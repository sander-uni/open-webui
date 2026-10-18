import asyncio

import pytest
from fastapi.testclient import TestClient

from backend_fixture import create_fixture

ADMIN = {'Authorization': 'Bearer fixture-admin'}
USER = {'Authorization': 'Bearer fixture-user'}
URL = '/api/v1/custom-settings'
DEFAULT = {'tool_chain_display': {'enabled': True, 'page_size': 50, 'auto_load': True}, 'filesystem_sort_default': 'date_desc'}


def test_defaults_validation_and_write_dependency(tmp_path):
    app = create_fixture(tmp_path / 'config.db')
    with TestClient(app) as client:
        assert client.get(URL).status_code == 401
        assert client.get(URL, headers=USER).json() == DEFAULT
        assert client.post(URL, json=DEFAULT, headers=USER).status_code == 403
        for value in (9, 501, 20.5, '20', True, None):
            invalid = {'tool_chain_display': {**DEFAULT['tool_chain_display'], 'page_size': value}}
            assert client.post(URL, json=invalid, headers=ADMIN).status_code == 422
        for key in ('enabled', 'auto_load'):
            invalid = {'tool_chain_display': {**DEFAULT['tool_chain_display'], key: 'false'}}
            assert client.post(URL, json=invalid, headers=ADMIN).status_code == 422
        assert client.post(URL, json={**DEFAULT, 'inference': {}}, headers=ADMIN).status_code == 422
        assert client.get(URL, headers=USER).json() == DEFAULT


def test_real_database_persistence_and_namespace_isolation(tmp_path):
    database = tmp_path / 'config.db'
    app = create_fixture(database)
    changed = {'tool_chain_display': {'enabled': False, 'page_size': 20, 'auto_load': False}, 'filesystem_sort_default': 'date_desc'}
    with TestClient(app) as client:
        asyncio.run(app.state.config_model.upsert({'custom.other': {'kept': True}, 'openai.api_key': 'fixture-secret'}))
        assert client.post(URL, json=changed, headers=ADMIN).json() == changed
        assert client.get(URL, headers=USER).json() == changed
        assert asyncio.run(app.state.config_model.get('custom.other')) == {'kept': True}
        assert asyncio.run(app.state.config_model.get('openai.api_key')) == 'fixture-secret'
        assert 'fixture-secret' not in client.get(URL, headers=USER).text
    # New application/session objects read the persisted SQLite rows.
    with TestClient(create_fixture(database)) as restarted:
        assert restarted.get(URL, headers=USER).json() == changed


def test_invalid_import_falls_back_without_breaking_chat(tmp_path):
    app = create_fixture(tmp_path / 'config.db')
    with TestClient(app) as client:
        asyncio.run(app.state.config_model.upsert({'custom.tool_chain_display': {'page_size': 0}}))
        assert client.get(URL, headers=USER).json() == DEFAULT
        assert client.post(URL, json=DEFAULT, headers=ADMIN).status_code == 200
        assert asyncio.run(app.state.config_model.get('custom.tool_chain_display')) == DEFAULT['tool_chain_display']


def test_storage_failure_is_not_reported_as_a_success(tmp_path, monkeypatch):
    app = create_fixture(tmp_path / 'config.db')

    async def fail(*args, **kwargs):
        raise RuntimeError('fixture database unavailable')

    with TestClient(app, raise_server_exceptions=False) as client:
        monkeypatch.setattr(app.state.config_model, 'upsert', fail)
        assert client.post(URL, json=DEFAULT, headers=ADMIN).status_code == 500
