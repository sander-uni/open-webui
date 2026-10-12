"""Fork-specific display settings, isolated from upstream inference configuration."""

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError

from open_webui.models.config import Config
from open_webui.utils.auth import get_admin_user, get_verified_user

router = APIRouter()
log = logging.getLogger(__name__)
TOOL_CHAIN_DISPLAY_KEY = 'custom.tool_chain_display'


class ToolChainDisplaySettings(BaseModel):
    model_config = ConfigDict(extra='forbid')

    enabled: StrictBool = True
    page_size: int = Field(default=50, ge=10, le=500, strict=True)
    auto_load: StrictBool = True


class CustomSettingsForm(BaseModel):
    model_config = ConfigDict(extra='forbid')

    tool_chain_display: ToolChainDisplaySettings = Field(default_factory=ToolChainDisplaySettings)


async def get_custom_settings_values() -> dict:
    value = await Config.get(TOOL_CHAIN_DISPLAY_KEY, {})
    try:
        settings = ToolChainDisplaySettings.model_validate(value)
    except ValidationError:
        # An invalid imported value must not prevent chats or admin settings loading.
        log.warning('Invalid tool-chain display settings; using defaults')
        settings = ToolChainDisplaySettings()
    return {'tool_chain_display': settings.model_dump()}


@router.get('', response_model=CustomSettingsForm)
async def get_custom_settings(user=Depends(get_verified_user)):
    return await get_custom_settings_values()


@router.post('', response_model=CustomSettingsForm)
async def set_custom_settings(form_data: CustomSettingsForm, user=Depends(get_admin_user)):
    # One namespaced key per subcategory preserves unrelated custom settings.
    await Config.upsert({TOOL_CHAIN_DISPLAY_KEY: form_data.tool_chain_display.model_dump()})
    return form_data
