# Yozora Anime Player — TypeScript

A local web player for video files stored on your computer and authorized online direct-video/HLS streams. The server uses Node.js built-in modules only; **no Express or other runtime package is required**.

## Requirements

- Node.js 22.6.0 or newer (Node.js 22 LTS or newer recommended)
- npm (included with Node.js)

Node 22.6+ can run this TypeScript server directly using Node's built-in type stripping.

## Start it (Windows / macOS / Linux)

1. Extract the ZIP file.
2. Open the extracted `yozora-anime-player` folder in VS Code.
3. Open a terminal in that exact folder (the one containing `server.ts`).
4. Run:

   ```bash
   npm start
   ```

5. Open **http://127.0.0.1:3001**.

On Windows, you can also double-click `START-WINDOWS.bat`. Keep the terminal window open while using the player; closing it stops the server.

You do not need `npm install` to run the app: the runtime server uses only Node.js built-ins. The first start creates the `media/` and `data/` folders and the `data/online-sources.json` file if missing.

## Upload and play downloaded video files

1. Start Yozora and open `http://127.0.0.1:3001`.
2. In the right-hand panel, find **Import downloaded videos**.
3. Click **Choose files** and select one or several video files from your computer.
4. Click **Upload to local library**. The upload progress is shown on screen.
5. After upload, Yozora refreshes the library and automatically loads the first uploaded video. You can select any other episode under **All** or **Local**.

Files are copied into the project's `media/` folder, so they remain available after you close and reopen Yozora. Each file can be up to 20 GiB. The upload is streamed directly to disk rather than buffered fully in memory. If a filename already exists, Yozora adds a number such as `(2)` instead of overwriting the existing file.

**Playback compatibility:** MP4 with H.264 video and AAC audio is recommended for Chrome. MKV and AVI files may upload and appear in the library, but browsers often cannot decode them; convert those to MP4 (H.264/AAC) if they do not play.

You can also copy your own or otherwise authorized files directly into `media/`. Nested folders are scanned automatically:

```text
media/
  Naruto/
    Season 1/
      episode-01.mp4
      episode-02.mp4
  Your Movie.mp4
```

Click **Refresh** in the app. The server supports HTTP byte-range requests, so seeking through local video files works. MP4 encoded with H.264 video and AAC audio is the most browser-compatible format. MKV/AVI may show in the list but may not decode in your browser; convert them to a browser-compatible format if necessary.

## Player controls

Select an item in your library to load it. Use the player controls to play or pause, seek, skip 10 seconds, adjust volume, change playback speed, and enter fullscreen. Previous and next move through the currently visible library items.

Keyboard shortcuts work when you are not typing in a text field:

- **Space** or **K** — play / pause
- **Left / Right** — seek back / forward 10 seconds
- **Up / Down** — increase / decrease volume
- **M** — mute / unmute
- **F** — toggle fullscreen

## Add an online stream

Use the **Add an online stream** form and enter a name plus an authorized direct video URL (for example, `.mp4`) or HLS playlist URL ending in `.m3u8`. The list persists in `data/online-sources.json` after restart.

HLS playback uses hls.js from jsDelivr when the browser does not support HLS natively, so the browser needs internet access for that library. The remote provider must permit browser playback and CORS. A normal watch-page URL is not a direct media URL. This app does not bypass logins, DRM, paywalls, or provider restrictions.

## Commands

```bash
npm start          # Start TypeScript server
npm run dev        # Restart server automatically when server.ts changes
npm run typecheck  # Optional: requires npm install first
npm run build      # Optional: compile TypeScript (requires npm install first)
npm run start:prod # Run the compiled dist/server.js build
```

The optional TypeScript compiler and Node type definitions are development dependencies. They are not needed to run `npm start`.

## Change port / LAN access

The server defaults to port `3001`. To use a different port, set `PORT`:

```powershell
$env:PORT=3002; npm start
```

macOS/Linux:

```bash
PORT=3002 npm start
```

By default, the server listens only on your computer (`127.0.0.1`). To use it from another device on your private network, set `HOST=0.0.0.0` and use the computer's LAN IP in the browser. Only do this on a trusted network.

## Troubleshooting

- **Node says `bad option: --experimental-strip-types`:** update Node.js to 22.6 or newer. Check with `node -v`.
- **The browser says it cannot connect:** check that the terminal still shows Yozora running, then open `http://127.0.0.1:3001`. Do not open `index.html` directly from File Explorer.
- **The ZIP download fails in ChatGPT:** use the fresh ZIP attachment link provided with this project, or download the individual source files from the links in the response. Extract the ZIP before running it.
- **Port 3001 is already in use:** choose another port, e.g. `PORT=3002 npm start` (PowerShell syntax shown above).
- **The page does not open:** confirm the terminal printed `YOZORA Anime Player is running`, then use the exact URL printed there.
- **A local file does not play:** try MP4 (H.264 + AAC). Browser support for MKV and AVI varies.
- **An online stream does not play:** it must be a direct video/HLS URL, must not be expired, and its host must allow browser playback/CORS.

## API

- `GET /health` — server health
- `GET /api/library` — local file list and saved online streams
- `POST /api/upload?name=episode.mp4` — upload one raw video file body into `media/` (20 GiB maximum per file)
- `POST /api/streams` — save `{ "title": "Episode 1", "url": "https://example.com/video.m3u8" }`
- `DELETE /api/streams/:id` — remove a saved stream
- `/media/*` — serve local media with HTTP range support
