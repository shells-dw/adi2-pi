#!/usr/bin/env node
'use strict';
/**
 * Called by the streaming receivers; passes volume changes and track events to ADI-2-Pi
 * (POST /api/hook on this Pi, URL from ADI2PI_HOOK_URL).
 *
 *   shairport-sync: adi2-pi-hook.js airplay <volume −30…0, −144 = mute>
 *   librespot (--onevent): environment PLAYER_EVENT = volume_set | volume_changed (VOLUME 0…65535),
 *                          track_changed (NAME, ARTISTS, ALBUM, DURATION_MS, COVERS), playing /
 *                          paused (POSITION_MS), stopped, end_of_track; librespot 0.4: changed,
 *                          started, playing, paused, stopped (TRACK_ID only)
 */
const http = require('http');

const url = process.env.ADI2PI_HOOK_URL;
const env = process.env;
let body = null;
if (env.PLAYER_EVENT !== undefined) {
  const ev = env.PLAYER_EVENT;
  if (/^volume_(set|changed)$/.test(ev)) body = { receiver: 'spotify', value: Number(env.VOLUME) };
  else if (/^(track_changed|changed|playing|started|paused|stopped|end_of_track|session_disconnected)$/.test(ev)) {
    body = {
      receiver: 'spotify', event: ev,
      name: env.NAME, artists: env.ARTISTS ? env.ARTISTS.split('\n').join(', ') : undefined, album: env.ALBUM,
      durationMs: env.DURATION_MS ? Number(env.DURATION_MS) : undefined, positionMs: env.POSITION_MS ? Number(env.POSITION_MS) : undefined,
      coverUrl: env.COVERS ? env.COVERS.split('\n')[0] : undefined,
    };
  }
} else if (process.argv[2] && process.argv[3] !== undefined) {
  body = { receiver: process.argv[2], value: Number(process.argv[3]) };
}
if (!url || !body) process.exit(0);

const data = JSON.stringify(body);
const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 2000 }, (res) => {
  res.resume();
  res.on('end', () => process.exit(0));
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(0));
req.end(data);
