# Simple SSH Client

A small SSH/SFTP client I built for myself. Tauri 2 + Svelte 5.

Not a polished product — just something I use day to day. Sharing the source in case it's useful to anyone.

## Features

- Multi-tab terminal with split panes
- Detach tabs into separate windows / drag back to merge
- Key auth and password auth (with OS keyring storage)
- Jump host support
- SFTP file manager with parallel downloads
- Falls back to `scp.exe` for large files when available

## Build

```sh
npm install
npm run tauri:dev      # dev
npm run tauri:build    # release
```

Releases are published on the GitHub releases page.

## License

MIT.
