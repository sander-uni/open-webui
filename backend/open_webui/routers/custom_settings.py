"""Fork-specific display settings, isolated from upstream inference configuration."""

import logging
from typing import Literal, get_args

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError

from open_webui.models.config import Config
from open_webui.utils.auth import get_admin_user, get_verified_user

router = APIRouter()
log = logging.getLogger(__name__)
TOOL_CHAIN_DISPLAY_KEY = 'custom.tool_chain_display'
FILESYSTEM_SORT_KEY = 'custom.filesystem_sort_default'
FilesystemSortDefault = Literal['date_desc', 'date_asc', 'name_asc', 'name_desc', 'size_desc', 'size_asc']
DEFAULT_FILESYSTEM_SORT: FilesystemSortDefault = 'date_desc'


class ToolChainDisplaySettings(BaseModel):
    model_config = ConfigDict(extra='forbid')

    enabled: StrictBool = True
    page_size: int = Field(default=50, ge=10, le=500, strict=True)
    auto_load: StrictBool = True


class CustomSettingsForm(BaseModel):
    model_config = ConfigDict(extra='forbid')

    tool_chain_display: ToolChainDisplaySettings = Field(default_factory=ToolChainDisplaySettings)
    filesystem_sort_default: FilesystemSortDefault = DEFAULT_FILESYSTEM_SORT


async def get_custom_settings_values() -> dict:
    values = await Config.get_many(TOOL_CHAIN_DISPLAY_KEY, FILESYSTEM_SORT_KEY)
    value = values.get(TOOL_CHAIN_DISPLAY_KEY, {})
    try:
        settings = ToolChainDisplaySettings.model_validate(value)
    except ValidationError:
        # An invalid imported value must not prevent chats or admin settings loading.
        log.warning('Invalid tool-chain display settings; using defaults')
        settings = ToolChainDisplaySettings()
    filesystem_sort = values.get(FILESYSTEM_SORT_KEY, DEFAULT_FILESYSTEM_SORT)
    if filesystem_sort not in get_args(FilesystemSortDefault):
        log.warning('Invalid filesystem sort default; using newest first')
        filesystem_sort = DEFAULT_FILESYSTEM_SORT
    return {'tool_chain_display': settings.model_dump(), 'filesystem_sort_default': filesystem_sort}


@router.get('', response_model=CustomSettingsForm)
async def get_custom_settings(user=Depends(get_verified_user)):
    return await get_custom_settings_values()


@router.post('', response_model=CustomSettingsForm)
async def set_custom_settings(form_data: CustomSettingsForm, user=Depends(get_admin_user)):
    # One namespaced key per subcategory preserves unrelated custom settings.
    updates = {}
    if 'tool_chain_display' in form_data.model_fields_set:
        updates[TOOL_CHAIN_DISPLAY_KEY] = form_data.tool_chain_display.model_dump()
    if 'filesystem_sort_default' in form_data.model_fields_set:
        updates[FILESYSTEM_SORT_KEY] = form_data.filesystem_sort_default
    await Config.upsert(updates)
    return await get_custom_settings_values()
