# Release Notes

## v0.2.0

This version adds support for the newest generation of models and adds powerful new ways to create video. You can now generate short AI videos with the WAN family, produce high-quality video with LTX 2.5, and expand a picture's borders. Video output is now converted to a modern format that plays directly in the app, and the model library is organized more cleanly so files never get mixed up. A new resolution picker makes it faster to pick the right size.

### Added

- **Generate AI videos** — a new video mode (WAN support) creates short video clips from a text prompt or an image. It supports companion "expert" models for higher quality, audio tracks, control-video input, and end-image frames, with adjustable length and speed.
- **Play videos in the app** — generated videos are converted to a modern MP4 format and played inline with native controls (play, seek, volume), so you no longer have to open an external player.
- **LTX 2.5 video** — support for the LTX 2.5 video model family, which turns a text prompt or image into a high-quality video clip. It can use a companion audio model for synced sound and a latent upscaler for sharper, higher-resolution output.
- **Pick a resolution in a dialog** — a new unified resolution picker replaces the small dropdown, making it easier to browse and choose a size.

### Improved

- **Cleaner model organization** — models are now stored in a family-scoped layout with a resolution chain that checks the right file first, so different models can never overwrite or confuse each other.
- **Better model naming** — models show clear, human-readable names (including MOSS-Image-SFT), and catalog entries are matched more reliably.
- **Smaller, faster videos** — video output is automatically converted to H.264 MP4 with fast startup, so playback is smooth.

### Fixed

- **Reliable model resolution** — a wrong-family or wrong-source file can no longer be silently loaded in place of the correct model.