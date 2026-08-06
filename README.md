# FC Event Calendar

An in-game event calendar for Final Fantasy XIV Free Companies. Members can create events, sign up with their current character, receive reminders, and see the full FC schedule directly in Dalamud.

## Features

- Shared events and attendance lists for all connected FC members.
- Monthly calendar view with day filtering.
- Event creator can edit or delete their own events.
- Configurable reminders with an optional Windows notification sound.
- Automatic cleanup: events and registrations are removed 24 hours after the event start time.
- FC access code; the code is stored only as a Cloudflare Worker secret.

## For FC members: install through Dalamud

1. In game, open the Dalamud Plugin Installer with `/xlplugins`.
2. Open **Settings** and find **Custom Plugin Repositories**.
3. Add this URL:

   `https://raw.githubusercontent.com/NyxStormborn/fc-event-calendar/main/pluginmaster.json`

4. Return to the Available Plugins list, find **FC Event Calendar**, and click **Install**.
5. Open the plugin with `/fcevents` and enter the FC access code once.

The configured server address is included by default. You only need to change it if your FC administrator gives you a new address. Updates will appear through the normal Dalamud installer.

## For FC administrators: Worker deployment

The `worker/` folder contains the Cloudflare Worker and D1 database. The FC access code must never be committed to GitHub.

```powershell
cd worker
npm.cmd install
npx.cmd wrangler types
npx.cmd wrangler deploy
```

Set or replace the access code securely through Cloudflare:

```powershell
npx.cmd wrangler secret put FC_ACCESS_CODE
```

## Building from source

Requirements: .NET 10 SDK, XIVLauncher/Dalamud, Node.js (only for Worker changes), and a Cloudflare account (only for Worker changes).

```powershell
cd plugin
dotnet build
```

The plugin DLL is created at `plugin\bin\Debug\FcEventCalendar.dll`.

## Project structure

- `plugin/` — Dalamud plugin written in C#.
- `worker/` — Cloudflare Worker and D1 database API.

## Security

- Never commit `.dev.vars`, `FC_ACCESS_CODE`, device tokens, or your local Dalamud configuration.
- The D1 database ID and Worker URL are not secrets; the FC access code is.
