# CS2 audio and UI resources

These are the original CS2 samples and Panorama weapon silhouettes referenced
by the user-requested [ETO-ze/dust2-web](https://github.com/ETO-ze/dust2-web)
project. The publicly accessible mirror is https://cs2.duskrain.cn/.

Valve and the original respective creators retain the rights to this game
audio and imagery. A GitHub repository, public download URL, or hash manifest
does **not** relicense these assets. They are **not MIT, CC0, or a newly recorded
sound-alike**, and are kept separate from this project's independently authored
code and the older CC0 firearm recordings.

`freight-manifest.json` records the selected banks, original paths, SHA-256
hashes, mirror URLs and reference lock version. `scripts/fetch-cs2-feedback.py`
recovers only these selected resources and verifies sizes and hashes. MP3 and
SVG bytes are unchanged; runtime playback mixes and schedules locally.

The M4A1-S, AK-47, AWP, USP-S, draw/reload/bolt, light/heavy knife, hit,
headshot and kill-confirmation banks match their CS2 weapon families. No
remote asset request is needed while playing.
