# Blackmagic Enhanced Router

Local web app for controlling a single Blackmagic Videohub with a matrix-style routing UI.

## Requirements

- Node.js 20+
- `pnpm` 10+
- Network access to the target Videohub on TCP port `9990`

## Run Locally

1. Install dependencies:

```bash
pnpm install
```

2. Start the app:

```bash
pnpm dev
```

3. Open the UI:

```text
http://localhost:3000
```

4. Enter your Videohub `Host`, confirm `Port` is `9990` unless your device is different, then click `Save and connect`.

## Local Ports

- Web UI: `http://localhost:3000`
- API server: `http://localhost:3001`
- Live updates WebSocket in development: `ws://localhost:3001/ws`

## Useful Commands

Run the full build:

```bash
pnpm build
```

Run all tests:

```bash
pnpm test
```

Run linting:

```bash
pnpm lint
```

## Notes

- Device config is persisted locally, so the app will try to reconnect to the last saved Videohub on startup.
- The app is currently scoped to one device at a time.
- The routing experience is best on a tablet in portrait mode, where the compact matrix layout has the most usable vertical space.
