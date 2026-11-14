# Release Notes

## v0.2.2

This version adds two new ways to steer image generation — Control Net conditioning and IP-Adapter image prompts — along with an ESRGAN image upscaler, an ADetailer detail-repair pass, a large wave of new model families (SD 1.5, Chroma, HiDream O1, Boogu Image, MiniMax-H3 video, and more), and quality-of-life improvements like session search, accessibility settings, and inline model downloads in the upscale dialog.

### Added

- **Control Net support** — attach control images to a generation so pose, edges, or other structural cues steer the result. ControlNet models are downloadable from the Hub (Settings → Models).
- **IP-Adapter** — condition a generation on one of your reference images so its subject and style influence the output, with adjustable strength.
- **Image upscaler (ESRGAN)** — upscale generated images in-app with an ESRGAN model. The Upscale dialog has inline download buttons so you can fetch upscaler models without leaving it.
- **ADetailer repair pass** — an optional YOLOv8 object-detector pass that re-renders detected faces and bodies to fix common detail artifacts. Toggle it from the composer and sampling settings, with detector options in a dedicated dialog.
- **New diffusion types** — SD 1.5, Chroma, HiDream O1 (image_unified), Boogu Image, and Ming Image are now available as generation families, each with their own sampling defaults and resolutions.
- **MiniMax-H3 video family** — the MiniMax-H3 video + stereo-audio model family is in the catalog, including repeatable reference audio/video channels for Ref2VA prompts.
- **New models in the Hub** — Ideogram 4, Iris 3B, Fibo 2.0 (Dev / Edit Turbo), Qwen3 VL 4B Instruct encoder/vision, Hunyuan Video 1.5, Qwen2.5-VL/byn5 glyph encoders, ERNIE Image, Mistral-3-3B-Instruct, Abiray/ideogram-4-GGUF, and nine CivitAI models.
- **Accessibility settings** — a new Settings section with font and icon size controls plus additional themes.
- **Session search** — a search box in the Sidebar filters your sessions; the Settings dialog also gained its own search.
- **Extra sd-cli arguments** — the sampling dialog has a session-only free-form row for passing extra sd-cli arguments, and model entries support a free-form model-args override.

### Improved

- **Latest sd-cli runtime** — new stable-diffusion.cpp runtime releases are available for download from Settings → Runtime.
- **Performance backend defaults** — the Performance settings' backend option now supports a custom default value.
- **Busy state across session switches** — each session now tracks its own generation busy state, so switching sessions no longer sticks or drops the in-progress indicator.
- **Generation time and resolution on preview** — image previews show total generation time, and both chat previews and the lightbox display the image's resolution.
- **Audio / latent upscaler sections** — model management surfaces audio and latent-upscaler model sections when the hub config declares them.
- **Multi-encoder families** — model families that require more than one text encoder are now supported (array-form `requires.encoder`).
- **Hub scan progress** — model dialogs show progress while the hub catalog is being scanned.
- **Toolbar icons** — toolbar buttons now use semantic SVG icons.

### Fixed

- **Overlay search clear buttons** — the clear buttons in overlay search inputs now sit inside the input itself, with accessibility fixes.
- **Prompt box during enhancement** — the prompt text area is disabled while an AI enhancement runs, so edits can't be lost mid-run.
- **Adetailer dialog layout** — checkbox labels in the ADetailer dialog no longer wrap awkwardly.
- **Upscale dialog layering** — raised the Upscale dialog's z-index so it stays above other overlays.


