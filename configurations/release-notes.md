# Release Notes

## v0.1.2

This version adds several new model families, lets each session remember its own model and resolution, and lets you build images from your last result. It also adds finer control over how images are generated — choose your sampler and scheduler, write a negative prompt, and override sampling per session.

### Added

- **More model families** — the app now ships support for SD3.5, Krea 2, SDXL, and Anima models alongside the existing ones, so you can work across a wider range of diffusion types.
- **More models to choose from** — the built-in model catalog is expanded, adding new SD3.5, Krea 2, SDXL, and Anima options from additional providers, so there are more quantizations and sizes to pick from.
- **Reference image from your last generation** — when a model supports image-to-image, you can start a new image from the one you just generated. This is available only for models that opt in, and controls how much the original is changed.
- **SD3.5 multi-encoder support** — SD3.5-style models that bundle several text encoders are now handled automatically, resolving and passing each encoder file instead of a single one.
- **Sampler and scheduler selection** — choose from a set of samplers and schedulers in Settings → Sampling instead of relying on the default. The chosen scheduler is only sent to the runtime when it is explicitly set, so models that prefer their own default keep working out of the box.
- **Negative prompt** — enter a negative prompt in Settings → Sampling, or override it per session from the chat composer. It is only sent when you actually type something.
- **Per-session sampling override** — each chat session can now keep its own sampling settings (steps, CFG, strength, sampler, scheduler) on top of the model defaults, so you can fine-tune one session without affecting the others. The current override shows in the session summary.
- **Remember model and resolution per session** — each chat session now keeps the model and resolution you last chose. Switching to a session restores those inputs, so you don't have to re-pick them every time.
- **App logging** — Settings → Logs shows the latest application log on demand, which helps diagnose problems. Logs are written and rolled automatically so they don't grow without limit.
- **Save image-as with a quick open-folder action** — after saving a generated image, a toast offers to open the folder containing it.
- **Resume downloads** — pause, cancel, or retry a download anytime. Interrupted downloads won't leave broken or incomplete files behind.
- **Update models and settings from the app** — Settings → Runtime and Settings → Models now have **Check** and **Reset** buttons. **Check** downloads the latest available models and settings from the internet, so you don't need to reinstall the app to get new options. **Reset** restores the original built-in options.
- **Better model selection** — a new searchable list replaces the old dropdown, showing a short description for each model so you can pick the right one.
- **Search models** — a search box is now available in the Settings dialog for models, VAE, text encoder, and vision models.
- **Full-width image preview** — click any generated image in the chat to view it larger.

### Improved

- The model browser now scans model repositories more precisely, so only the files relevant to a model show up instead of unrelated files from other folders.
- Model selection is more reliable when pausing, cancelling, or resuming a download.
- The app renders more smoothly while downloading. Progress updates are now throttled so the interface stays responsive during large downloads instead of stuttering or lagging.
- After checking for new models, the app automatically refreshes the available list.
- Model and settings options are organized more cleanly.
- Session sampling overrides are now resolved before width/height, so per-session sampling changes take precedence over the model's defaults.
- The negative-prompt dialog now prefills with the session's existing prompt so editing is smoother.
- Downloaded models are excluded from the model selector when they are VAE or LoRA variants, so only full diffusion models show up for selection.
- The app menu (File, Edit, View, …) is now hidden in the window to give the image-generation interface a cleaner look.
