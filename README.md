# Audius plugin for MusicFree

A [MusicFree](https://musicfree.catcat.work) plugin that adds **Audius** as a music
source: search, trending charts, playlists, artists and playback.

Audio is served by Audius' own public API — nothing is scraped from
copyrighted catalogues.

## Install

Copy `plugin.js` into the MusicFree plugin folder under the name `audius.js`:

```
Windows : %APPDATA%\MusicFree\musicfree-plugins\audius.js
Android : Android/data/fun.upup.musicfree/files/plugins/audius.js
```

Restart MusicFree. The source appears in **插件管理 / Plugin manager** as `Audius`
and in the search type selector once you pick "Audius".

Alternatively use *Install from URL* in the plugin manager and point it at a raw
copy of `plugin.js`.

## Features

| Protocol method | Implemented | Notes |
|---|---|---|
| `search` (music) | yes | `/tracks/search`, filters to streamable tracks |
| `search` (album) | yes | maps to Audius playlists |
| `search` (artist) | yes | `/users/search` |
| `getMediaSource` | yes | `/tracks/{id}/stream` (302 → CDN, real mp3) |
| `getTopLists` / `getTopListDetail` | yes | Trending + Underground Trending |
| `getMusicSheetInfo` | yes | playlist detail |
| `getArtistWorks` | yes | artist tracks and playlists |
| `importMusicItem` / `importMusicSheet` | yes | `audius.co/<user>/<track>`, `audius.co/<user>/playlist/<id>` |
| `getLyric` | **no** | Audius has no lyrics endpoint (verified `404`) |

## Verified behaviour

`node test/verify.js` runs against the live API — 21 checks, all passing:

```
===== 21 passed, 0 failed =====
```

Playback was verified by fetching real bytes and checking the `ID3` magic
header: responses are `audio/mpeg` and range from 7 MB to 437 MB.

## API quirks worth knowing

These were found empirically and are the reason the code looks the way it does:

1. **`/playlists/search` returns an empty `tracks: []`.** It reports `track_count`
   but the track ids only exist in `playlist_contents[].track_id`. Only
   `/playlists/{id}` is populated.
2. **`/playlists/{id}` returns `data` as an array of one playlist**, while
   `/playlists/search` returns `data` as an array of playlists directly. Both
   shapes are normalised in `fetchPlaylistTracks()`.
3. **`/tracks?id=a,b` silently returns an empty list.** The fallback path
   resolves ids one at a time instead.
4. **`is_streamable` is not always honoured.** Some tracks report
   `is_streamable: true` (and pass the `access.stream` check) yet `/stream`
   answers `200` with `0` bytes — a CDN-side gap that metadata cannot predict.
   Around 1 in 8 tracks is affected; the test therefore requires ≥7/8 rather
   than 100%.

## Known limitations

- **No lyrics.** Audius exposes no lyrics endpoint. Pair this plugin with a
  lyrics-only plugin (e.g. 歌词网 / 歌词千寻) if you want them.
- **Catalogue is mostly Western/independent music.** Chinese-language tracks
  are rare — this is not a replacement for domestic streaming services.
- **MP3 only, no lossless.** Audius streams are MP3.

## Layout

```
plugin.js         the plugin (single CommonJS file, no build step)
test/verify.js    live-API verification, run with `node test/verify.js`
```

The plugin runs inside MusicFree's plugin sandbox, whose `require` is limited to
pure-JS packages. This plugin needs no dependency at all — it uses the global
`fetch` available in the host runtime.
