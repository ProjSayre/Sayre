import React from "react";
import * as ReactDOMExports from "react-dom";
import { createRoot } from "react-dom/client";

window.React = React;
window.ReactDOM = { ...ReactDOMExports, createRoot };
window.TWEAK_DEFAULTS = {
  motionEditor: false,
  fps: 12,
  boil: false,
};
window.OM_SCENES = '[{"name":"Star Falls","dur":1.45},{"name":"Roots Grow","dur":4.1},{"name":"Blueprint","dur":4.65}]';
window.OM_PLAYBACK = '{"mode":"times","count":1}';

await import("../../design/handoffs/anime-hero-animation/project/filetree-data.js");
await import("../../design/handoffs/anime-hero-animation/project/animations-v2.jsx");
await import("../../design/handoffs/anime-hero-animation/project/tweaks-panel.jsx");
await import("../../design/handoffs/anime-hero-animation/project/hero-anime-scene.jsx");

const HeroAnimeAnimation = window.HeroAnimeAnimation;
createRoot(document.getElementById("root")).render(<HeroAnimeAnimation />);

requestAnimationFrame(() => {
  window.__ANIME_HERO_READY__ = true;
});
