# Generated brand assets

Generated with the built-in image generation tool, then resized and encoded using cwebp. The transparent logo is used in the panel header, sign-in screen, and favicon. The banner is embedded at the top of the root README.

| Asset                                  | Dimensions                 | Size         |
| -------------------------------------- | -------------------------- | ------------ |
| `apps/web/public/mineserver-logo.webp` | 128 × 128, alpha preserved | 3,740 bytes  |
| `docs/assets/readme-banner.webp`       | 1600 × 534                 | 62,538 bytes |

## Logo prompt

Use case: logo-brand. Create a single polished logo mark for Mineserver, a Minecraft server management dashboard. A chunky isometric voxel grass-and-stone cube fused with a compact server rack motif: forest green grass top, slate stone sides, two tiny warm amber status lights. Crisp simplified silhouette, deliberate pixel-inspired stepped edges, subtle dimensional shading, readable at 36px. Centered square composition with small even padding. No lettering, no wordmark, no watermark, no extra objects. Transparent background. Intended for the top-left brand mark of a dark slate admin dashboard.

## README banner prompt

Use case: logo-brand. Asset type: wide horizontal GitHub README header banner, approximately 3:1 landscape. Create a polished cinematic voxel illustration for a Minecraft server management app: a compact grass-and-slate-stone server tower with two small glowing amber status lights in a miniature block-built Minecraft landscape, dark deep-slate background, forest-green grass, tasteful soft lighting, crisp voxel edges. Tower and landscape concentrated at the right side with clean uncluttered darker space on the left for lettering. Large exceptionally clear attractive white block-inspired but legible title reading exactly "Minecraft Server Manager" over two balanced lines on the left. Small readable credit reading exactly "by kodin00" located in the bottom-left corner with generous inset. Title and credit must be spelled exactly, no other text, no watermark. Keep all content comfortably inside the frame. Premium restrained composition, subtle depth and natural voxel materials, no UI screenshot or frame.

## Optimization

Logo: `cwebp -q 82 -m 6 -resize 128 128 source.png -o apps/web/public/mineserver-logo.webp`.

Banner: `cwebp -q 82 -m 6 -resize 1600 0 source.png -o docs/assets/readme-banner.webp`.
