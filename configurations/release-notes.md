# Release Notes

## v0.2.1

This version adds an AI prompt enhancer and a built-in image editor. You can now have a local language model rewrite your prompt into something richer with one click, and resize or crop images right before adding them to a session — without ever touching the original file.

### Added

- **Enhance prompts with AI** — a new Enhance button in the chat composer rewrites your current prompt into a richer, more detailed one using a local AI language model. The model and its runtime download automatically on first launch, and you can manage the model catalog, system prompt, and inference settings in Settings (Language Models and Language Inference). While an enhancement runs, the button pulses — click it again to cancel.
- **Resize and crop before adding** — when you add input or reference images, you can now edit them first in a full-screen editor: crop to any region, zoom, rotate, and pan (middle-click), pick a resolution preset, or set a custom size. Your original file is never modified, and multi-image picks are processed one at a time (Save & Next / Skip).

### Improved

- **Latest sd-cli runtime** — the bundled generation runtime is updated to the newest stable-diffusion.cpp builds (1054–1056).
- **LTX-2.5 GGUF models** — the Vantage with AI LTX-2.5 GGUF models are now correctly listed as video generation models in the catalog.
- **Enhance button feedback** — the busy indicator now uses a calmer pulse animation instead of a spinner.

### Fixed

- **Prompt box sizing** — the composer text box now resizes correctly when the prompt is changed by the app (for example, after using Enhance), so the full text is no longer clipped.