// One-off wrapper: kicks off the Seedance generator for the face-inpainting
// 00-intro background, bypassing the upstream script's broken Windows CLI guard
// (`import.meta.url === \`file://${process.argv[1]}\`` is always false on
// Windows because forward vs back slashes never align). Calls the exported
// `generateSeedanceAstria` directly. Safe to delete once the upstream guard
// is patched.
import "dotenv/config";
import { generateSeedanceAstria } from "../pipeline/generate-seedance-astria.ts";

process.env.WORKSPACE_ID ??= "6";
process.env.GEMINI_TUNE_ID ??= "4180298";

const out = await generateSeedanceAstria({
  output: "assets/avatars/face-inpainting/00-intro-seedance.mp4",
  firstFrame: "assets/avatars/video-style-transfer/intro-fullbody.jpg",
  lastFrame:  "assets/avatars/video-style-transfer/intro-last-frame-preferred.jpg",
  duration: 5,
  aspectRatio: "16:9",
  prompt:
    "Slow editorial portrait energy. Subtle head turn toward the lens, " +
    "soft confident eye contact, gentle micro smile forming. No hand " +
    "gestures. Camera holds steady. Quiet, premium atelier mood.",
});

console.log("[done] ->", out);
