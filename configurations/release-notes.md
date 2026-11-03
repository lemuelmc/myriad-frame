# Release Notes

## v0.1.3

This version expands the kinds of models you can use and adds powerful new ways to edit images. You can now paint over a photo to change it, mask an area to replace just that part, or gently expand the edges of a picture. New model sources bring more choices, and you can control your images even more precisely by locking in the random seed for the same result every time. It also checks for new models automatically when you open the app.

### Added

- **Paint directly onto a photo** — a new brush tool lets you draw over an image to change or cover parts of it, then send it along with your request.
- **Edit a part of an image** — you can now mask (highlight) a section of a photo so only that area gets redrawn, or expand the edges of a picture to make it larger. This works for models that support it.
- **LoRA support** — LoRA files are small add-ons that teach a model a new style, look, or character. You can pick them from a gallery and apply them per chat session, so you don't have to re-choose them each time.
- **More model sources** — the app now pulls models from CivitAI, a popular site for sharing AI models, in addition to the existing source. This gives you access to a much wider library of models.
- **See model sizes at a glance** — each model now shows how much space it takes up, so you can tell a small file from a large one without guessing.
- **Control the random seed** — each image starts from a random number. You can now pin that number (the "seed") so a good result can be repeated later, or roll a fresh one with a single click.
- **New model types** — support for additional model families such as Flux and Moss has been added, along with a new "edit" mode tuned for changing existing images.
- **Tokenizer support** — some models need an extra helper file to read your words correctly. The app can now download and use these files automatically.
- **Flow-shift setting** — a new quality slider (available on supported models) that helps the model produce cleaner, more detailed images.
- **Automatic update check** — when you open the app, it quietly checks for newer model and runtime settings and gently reminds you when something new is available, so you can keep your options up to date without extra effort.
- **Manage private-model access** — a new section in Settings lets you add, edit, or remove access tokens for private or paid model sources, so you can download models that need a login. Tokens can be given broad or narrow access with simple wildcards.
- **Search tokens** — managing access tokens is easier with a dedicated, searchable list in Settings → Tokens.

### Improved

- **Better model organization** — the model browser was reworked so it can support many different model sites cleanly, and models now show clear, human-readable names instead of long file-style codes.
- **Clearer error messages** — when a generation fails, the app now records the details in the log and shows a simple reminder, instead of dumping confusing technical text into your chat.
- **Cross-platform builds** — the app can now be built for Linux and macOS as well as Windows, bringing it to more computers.
- **New website** — a landing page now showcases the app's features, screenshots, and a video demo, making it easier to learn what it can do.
- **Smoother downloads** — background checks for new settings run quietly at startup without interrupting your work, and failed checks are treated as "nothing new" rather than an error.
- **More models to choose from** — the built-in catalog grew with new providers and model variants, so there are more styles and sizes to pick from.

