# eulr music assets

eulr does not bundle audio files. The default `remote` source obtains the CC0
station catalog and live playback position from:

```text
https://eulr-music-service.vercel.app/api/v1/catalog
https://eulr-music-service.vercel.app/api/v1/now-playing
```

The returned audio URL is streamed directly by mpv. Override the service with
`EULR_MUSIC_SERVICE_URL` or `music.serviceUrl` in `~/.eulr/config.json`.

Personal audio remains outside the repository and can be selected with
`/music library <path>`. Do not recreate `assets/music/tracks`; npm packages are
tested to exclude that directory and all MP3/WAV files.
