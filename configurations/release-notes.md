# Release Notes

## v0.2.3

This version builds on v0.2.2 with a SeedVR2 video-upscaling pass, a dedicated resize mode in the image editor, a MiniMax-H3 Image diffusion type, per-type prompt gating, and a set of targeted fixes around ADetailer model resolution, the resize inputs, and the reference-image button.

### Added

- **SeedVR2 video upscaling** — the new `seedvr_upscale` app mode maps to sd-cli's `-M vid_upscale`. Upscale a single image or a video input (a video is extracted to frames via the bundled ffmpeg before generation). New per-session rows expose the upscale factor and temporal-chunk-size, and frame extraction reports progress.
- **Resize mode** — the image editor gained a "Resize" mode that scales the entire image to a target width/height (the crop box is disabled in this mode), with an optional aspect-ratio lock and a live preview thumbnail, alongside the existing crop-only and custom-size modes.
- **MiniMax-H3 Image diffusion type** — an image-generation variant of the MiniMax-H3 family is now available, with its own sampling configuration.
- **Hub encoder path scan restriction** — encoder entries may carry an optional `path` that limits the hub scan to that folder's direct files (so every `.gguf` in it becomes a downloadable / set-default row), with `path: '/'` restricting the scan to the repo root's direct files.
- **Optional positive prompt** — types that don't need a positive prompt can now leave it blank; per-type positive-prompt gating was added to the sampling config.
- **Use generated image as input/reference** — chat previews and the lightbox gained buttons to feed a just-generated image back into the composer as an input image or a reference image.

### Improved

- **Performance flags and extra args for video upscale** — the SeedVR2 upscale branch now applies Settings → Performance flags and the free-form universal args row, which were previously dropped for those runs.
- **ADetailer model resolution** — the ADetailer detector model is now resolved correctly from disk, with a self-heal download offered when it's missing.
- **VAE folder scanning** — VAE folder scanning and frame-extraction progress were added to support the SeedVR2 upscale flow.

### Fixed

- **Resize inputs no longer fight typing** — the width/height number inputs in the resize mode no longer reset on each keystroke.
- **Image reference button** — the reference-image button's enable/disable state is now correct.
- **Preserved resize scratch files** — the `data/tmp/resize` directory is no longer wiped on every launch, so in-progress resize work survives between runs.
