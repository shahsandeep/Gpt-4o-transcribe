"""Application configuration.

Values come from environment variables. In Docker they are injected via
`env_file: .env` (see docker-compose.yml). For local development we additionally
try to load a repo-root `../.env` and a local `.env` through python-dotenv before
pydantic-settings reads the environment.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Load .env files for local dev *before* Settings reads os.environ.
# Docker relies on env_file instead, so a missing file here is a no-op.
# Order matters: the repo-root .env is the shared source of truth, so load it
# first; a backend-local .env may override for local experiments.
_HERE = Path(__file__).resolve().parent
_REPO_ROOT_ENV = _HERE.parent.parent / ".env"  # backend-python/../.env == repo root
_LOCAL_ENV = _HERE.parent / ".env"  # backend-python/.env

load_dotenv(_REPO_ROOT_ENV, override=False)
load_dotenv(_LOCAL_ENV, override=False)


class Settings(BaseSettings):
    """Typed application settings, sourced from environment variables."""

    model_config = SettingsConfigDict(
        env_file=None,  # dotenv already loaded above; avoid double-parsing
        case_sensitive=False,
        extra="ignore",
    )

    # --- Azure OpenAI resource ---
    azure_openai_endpoint: str = Field(
        default="https://your-resource.openai.azure.com",
        alias="AZURE_OPENAI_ENDPOINT",
    )
    azure_openai_api_key: str = Field(default="", alias="AZURE_OPENAI_API_KEY")

    # --- Realtime transcription deployment ---
    azure_transcribe_deployment: str = Field(
        default="gpt-4o-transcribe", alias="AZURE_TRANSCRIBE_DEPLOYMENT"
    )
    azure_realtime_api_version: str = Field(
        default="2025-04-01-preview", alias="AZURE_REALTIME_API_VERSION"
    )
    azure_transcribe_rest_api_version: str = Field(
        default="2025-04-01-preview", alias="AZURE_TRANSCRIBE_REST_API_VERSION"
    )

    # --- Chat deployment used for translation ---
    azure_chat_deployment: str = Field(default="gpt-4o", alias="AZURE_CHAT_DEPLOYMENT")
    azure_chat_api_version: str = Field(
        default="2024-10-21", alias="AZURE_CHAT_API_VERSION"
    )

    # --- Server-side voice activity detection tuning ---
    vad_threshold: float = Field(default=0.5, alias="VAD_THRESHOLD")
    vad_prefix_padding_ms: int = Field(default=300, alias="VAD_PREFIX_PADDING_MS")
    vad_silence_duration_ms: int = Field(default=500, alias="VAD_SILENCE_DURATION_MS")

    # --- Server ---
    python_port: int = Field(default=8000, alias="PYTHON_PORT")

    # ---- Derived URLs ----

    @property
    def _endpoint_host(self) -> str:
        """Endpoint with any scheme and trailing slash stripped."""
        ep = self.azure_openai_endpoint.strip().rstrip("/")
        for scheme in ("https://", "http://", "wss://", "ws://"):
            if ep.startswith(scheme):
                ep = ep[len(scheme) :]
                break
        return ep

    @property
    def realtime_ws_url(self) -> str:
        """Upstream Azure Realtime transcription WebSocket URL.

        `https://x.openai.azure.com` -> `wss://x.openai.azure.com/openai/realtime
        ?api-version=<ver>&intent=transcription`
        """
        return (
            f"wss://{self._endpoint_host}/openai/realtime"
            f"?api-version={self.azure_realtime_api_version}"
            f"&intent=transcription"
        )

    @property
    def rest_transcribe_url(self) -> str:
        """Azure REST audio transcription URL.

        `https://x.openai.azure.com/openai/deployments/<transcribe>/audio/
        transcriptions?api-version=<restver>`
        """
        return (
            f"https://{self._endpoint_host}/openai/deployments/"
            f"{self.azure_transcribe_deployment}/audio/transcriptions"
            f"?api-version={self.azure_transcribe_rest_api_version}"
        )

    @property
    def translation_url(self) -> str:
        """Azure chat completions REST URL used for translation.

        `https://x.openai.azure.com/openai/deployments/<chat>/chat/completions
        ?api-version=<chatver>`
        """
        return (
            f"https://{self._endpoint_host}/openai/deployments/"
            f"{self.azure_chat_deployment}/chat/completions"
            f"?api-version={self.azure_chat_api_version}"
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
