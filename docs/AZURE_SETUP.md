# Azure setup

You need one **Azure OpenAI** resource with two model deployments:

| Deployment | Model | Used for |
|------------|-------|----------|
| transcription | `gpt-4o-transcribe` (or `gpt-4o-mini-transcribe`) | realtime speech → text |
| chat | `gpt-4o` (or `gpt-4o-mini`) | translating each finalized segment |

## 1. Create the resource

1. In the Azure Portal, create an **Azure OpenAI** resource in a region that
   offers the realtime transcription models (e.g. `eastus2`, `swedencentral`).
2. Open **Azure AI Foundry** → **Deployments** → **Deploy model**.
3. Deploy `gpt-4o-transcribe`. Note the **deployment name** you choose.
4. Deploy `gpt-4o` (chat) for translation. Note that deployment name too.

## 2. Collect credentials

From the resource's **Keys and Endpoint** page:

- **Endpoint** — `https://<your-resource>.openai.azure.com`
- **Key** — either KEY 1 or KEY 2

## 3. Fill in `.env`

Copy `.env.example` to `.env` at the repo root and fill in:

```dotenv
AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com
AZURE_OPENAI_API_KEY=<your-key>

# Realtime transcription
AZURE_TRANSCRIBE_DEPLOYMENT=gpt-4o-transcribe
AZURE_REALTIME_API_VERSION=2025-04-01-preview

# Chat model used for translation
AZURE_CHAT_DEPLOYMENT=gpt-4o
AZURE_CHAT_API_VERSION=2024-10-21
```

> **Azure quirk:** in the realtime `input_audio_transcription.model` field, Azure
> wants the **deployment name**, not the base model id. That is why we send
> `AZURE_TRANSCRIBE_DEPLOYMENT`, not the literal string `gpt-4o-transcribe`,
> unless you named your deployment that.

## 4. How the backends reach Azure

**Realtime transcription (WebSocket):**

```
wss://<resource>.openai.azure.com/openai/realtime?api-version=<AZURE_REALTIME_API_VERSION>&intent=transcription
Header: api-key: <AZURE_OPENAI_API_KEY>
```

On connect the backend sends `transcription_session.update`:

```json
{
  "type": "transcription_session.update",
  "session": {
    "input_audio_format": "pcm16",
    "input_audio_transcription": {
      "model": "<AZURE_TRANSCRIBE_DEPLOYMENT>",
      "language": "en",
      "prompt": ""
    },
    "turn_detection": {
      "type": "server_vad",
      "threshold": 0.5,
      "prefix_padding_ms": 300,
      "silence_duration_ms": 500
    },
    "input_audio_noise_reduction": { "type": "near_field" }
  }
}
```

**Translation (REST chat completions):**

```
POST https://<resource>.openai.azure.com/openai/deployments/<AZURE_CHAT_DEPLOYMENT>/chat/completions?api-version=<AZURE_CHAT_API_VERSION>
Header: api-key: <AZURE_OPENAI_API_KEY>
Body: { "messages": [ {system: "translate to <lang>, output only the translation"}, {user: "<transcript>"} ], "temperature": 0 }
```

## API version notes

The realtime transcription surface is still preview and Microsoft revises the
`api-version` periodically (`2025-04-01-preview` is the version this project was
built against). If Azure rejects the connection, check the current value in the
[Realtime API reference](https://learn.microsoft.com/azure/ai-foundry/openai/realtime-audio-reference)
and update `AZURE_REALTIME_API_VERSION`. Everything else is driven from env, so
no code change is needed.
