Z-Image Turbo supports native resolutions ranging from 512×512 to 2048×2048 pixels, with core presets typically operating around 1024px, 1280px, and 1536px grids. Width and height dimensions are generally required to be divisible by 16. [1] (https://github.com/SaTaNoob/ComfyUI-Z-Image-Turbo-Resolutions), [2] (https://www.alibabacloud.com/help/en/model-studio/z-image-api-reference), [3] (https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/discussions/28)

Resolution Presets & Aspect Ratios

• 1024 Resolution Grid (1:1 & Widescreen/Portrait):
	• 1024×1024 (1:1)
	• 1152×896 (9:7), 896×1152 (7:9)
	• 1152×864 (4:3), 864×1152 (3:4)
	• 1248×832 (3:2), 832×1248 (2:3)
	• 1280×720 (16:9), 720×1280 (9:16)
	• 1344×576 (21:9), 576×1344 (9:21) [1] (https://github.com/SaTaNoob/ComfyUI-Z-Image-Turbo-Resolutions)
• 1280 Resolution Grid:
	• 1280×1280 (1:1)
	• 1440×1120 (9:7), 1120×1440 (7:9)
	• 1472×1104 (4:3), 1104×1472 (3:4)
	• 1536×1024 (3:2), 1024×1536 (2:3)
	• 1536×864 (16:9), 864×1536 (9:16)
	• 1680×720 (21:9), 720×1680 (9:21) [1] (https://github.com/SaTaNoob/ComfyUI-Z-Image-Turbo-Resolutions)
• 1536 Resolution Grid:
	• 1536×1536 (1:1)
	• 1728×1344 (9:7), 1344×1728 (7:9)
	• 1728×1296 (4:3), 1296×1728 (3:4)
	• 1872×1248 (3:2), 1248×1872 (2:3)
	• 2048×1152 (16:9), 1152×2048 (9:16)
	• 2016×864 (21:9), 864×2016 (9:21) [1] (https://github.com/SaTaNoob/ComfyUI-Z-Image-Turbo-Resolutions)

Hardware & VRAM Guidelines

• Standard (1024×1024 / default workflows): Runs smoothly on consumer GPUs with around 16 GB of VRAM (such as the RTX 4080 or A4000) using native bf16 weights, or down to 6–8 GB VRAM using GGUF/fp8 quantizations. [1] (https://www.runpod.io/articles/guides/comfyui-z-image-runpod)
• Higher Resolutions (up to 2048×2048): Require additional VRAM headroom, memory optimization (such as attention slicing) in tools like ComfyUI, or multi-stage upscaling workflows. [1] (https://www.reddit.com/r/StableDiffusion/comments/1p8xtln/zimage_best_practices_for_maximum_detail_clarity/), [2] (https://zimageturbo.com/blog/z-image-turbo-comfyui-workflow-guide), [3] (https://zimage.run/blog/best-upscaler-for-z-image-turbo)
Are you running Z-Image Turbo locally (e.g., in ComfyUI or Diffusers) or via an API, and what GPU VRAM are you working with? I can help pick the best resolution or optimization settings for your setup.
