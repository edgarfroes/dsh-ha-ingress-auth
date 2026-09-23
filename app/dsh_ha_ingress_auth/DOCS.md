# DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) inside
Home Assistant, opened from the sidebar, with Home Assistant's own users and
roles:

- **Every Home Assistant user gets their own dsh.** Chats, workspaces and
  approvals are private to the user who created them.
- **Administrators** (members of the Home Assistant *Administrators* group)
  get all of dsh: Settings → Models, Built-in plugins, Agent presets, General →
  Permission, API keys, custom model providers, the plugin manager and shell
  tools. What one admin configures applies to everyone, including the default
  model: when an admin picks a model in the chat, it becomes everyone's default.
- **Users** (members of *Users*) get Settings → General with Language,
  Appearance, Font size and "Send behavior while busy", each saved for them
  alone. Their sessions are shown in one list, without workspaces. They chat
  with the models the admins configured, pick among the admins' agent presets,
  and cannot run shell, file or terminal tools.
- **Read-only** Home Assistant users are refused.

## First setup

1. Install and start the app, then turn on **Show in sidebar**.
2. As a Home Assistant administrator, open **DeepSeek Harness** from the
   sidebar. dsh asks for an API key: enter it, or choose **Configure later**
   and add providers in **Settings → Models** (including custom
   OpenAI- or Anthropic-compatible endpoints).
3. Other users open the same sidebar entry. They see the models you set up.

## Options

| Option | Default | Meaning |
|---|---|---|
| `idle_timeout_minutes` | `30` | Stop a user's dsh after this many minutes with no open browser and no reply running (`0` = never). Admins' dsh is never stopped, so scheduled work keeps running. The next visit starts it again with its history. |

## How it works

The app runs a small gateway behind Home Assistant ingress. It accepts
connections only from Supervisor's ingress address and reads the Home
Assistant user from the headers Supervisor sets. It looks up the user's
groups through Home Assistant (this is why the app asks for Home Assistant
API access), then forwards the request to that user's own `dsh web` process,
started on first use. Each user's process runs under its own system user and
keeps its data in `/data/users/<user id>/`. The Home Assistant token never
reaches a dsh process.

The app publishes no network port: it is reachable only through Home
Assistant.

## Data and backups

Everything lives in the app's `/data` and is included in Home Assistant
backups: shared settings and API keys (`/data/shared/`), every user's chats,
workspaces and preferences (`/data/users/`). When a Home Assistant user is
deleted, their data is moved to `/data/archive/`, not deleted.

## Known limits

- dsh is pinned to `0.1.7-alpha.2`, an alpha release.
- Settings persistence behind a proxy relies on a dsh page setting meant for
  dsh's own apps (`ownsHost`) until dsh ships an official option.
- A user's dsh receives the admins' API keys as environment variables. Users
  have no shell, file or terminal tools, which is what keeps the key values
  out of their reach.
