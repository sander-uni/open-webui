"""API tests use real configuration storage with the existing isolated fixture."""

import asyncio
import importlib.util
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

path = Path(__file__).parents[1] / 'tool-chain/backend_fixture.py'
spec = importlib.util.spec_from_file_location('tool_chain_backend_fixture', path)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

ROOT = Path(__file__).resolve().parents[2]
ADMIN = {'Authorization': 'Bearer fixture-admin'}
USER = {'Authorization': 'Bearer fixture-user'}
URL = '/api/v1/custom-settings'
SORT_KEY = 'custom.filesystem_sort_default'


def app_for(database):
    return fixture.create_fixture(database, static_directory=Path(__file__).parent)


def test_default_is_newest_first_and_preserves_tool_chain_defaults(tmp_path):
    with TestClient(app_for(tmp_path / 'config.db')) as client:
        result = client.get(URL, headers=USER).json()
        assert result['filesystem_sort_default'] == 'date_desc'
        assert result['tool_chain_display'] == {'enabled': True, 'page_size': 50, 'auto_load': True}
        assert client.post(URL, json={'filesystem_sort_default': 'name_asc'}, headers=USER).status_code == 403


@pytest.mark.parametrize('value', ['date_desc', 'date_asc', 'name_asc', 'name_desc', 'size_desc', 'size_asc'])
def test_sort_choice_persists_across_application_recreation(tmp_path, value):
    database = tmp_path / 'config.db'
    with TestClient(app_for(database)) as client:
        saved = client.post(URL, json={'filesystem_sort_default': value}, headers=ADMIN)
        assert saved.status_code == 200
        assert saved.json()['filesystem_sort_default'] == value
    with TestClient(app_for(database)) as restarted:
        assert restarted.get(URL, headers=USER).json()['filesystem_sort_default'] == value


def test_partial_updates_do_not_reset_other_categories_or_old_clients(tmp_path):
    app = app_for(tmp_path / 'config.db')
    with TestClient(app) as client:
        tools = {'enabled': False, 'page_size': 100, 'auto_load': False}
        client.post(URL, json={'tool_chain_display': tools}, headers=ADMIN).raise_for_status()
        saved = client.post(URL, json={'filesystem_sort_default': 'name_asc'}, headers=ADMIN).json()
        assert saved['tool_chain_display'] == tools
        assert saved['filesystem_sort_default'] == 'name_asc'
        # The older tool-chain UI sends only its own field; it must preserve the new preference.
        saved = client.post(URL, json={'tool_chain_display': {**tools, 'page_size': 200}}, headers=ADMIN).json()
        assert saved['filesystem_sort_default'] == 'name_asc'
        assert saved['tool_chain_display']['page_size'] == 200


@pytest.mark.parametrize('value', ['mtime', 'DATE_DESC', '', None, 1, True, [], {}])
def test_invalid_sort_is_rejected_without_writing_other_settings(tmp_path, value):
    with TestClient(app_for(tmp_path / 'config.db')) as client:
        before = client.get(URL, headers=USER).json()
        response = client.post(URL, json={
            'filesystem_sort_default': value,
            'tool_chain_display': {'enabled': False, 'page_size': 200, 'auto_load': False},
        }, headers=ADMIN)
        assert response.status_code == 422
        assert client.get(URL, headers=USER).json() == before


def test_invalid_import_uses_newest_first_without_losing_tool_settings(tmp_path):
    app = app_for(tmp_path / 'config.db')
    tools = {'enabled': False, 'page_size': 100, 'auto_load': False}
    with TestClient(app) as client:
        asyncio.run(app.state.config_model.upsert({SORT_KEY: ['not-a-sort'], 'custom.tool_chain_display': tools}))
        value = client.get(URL, headers=USER).json()
        assert value['filesystem_sort_default'] == 'date_desc'
        assert value['tool_chain_display'] == tools
