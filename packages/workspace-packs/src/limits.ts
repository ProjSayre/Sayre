export const WORKSPACE_PACK_LIMITS = Object.freeze({
  bytes: 262_144,
  depth: 20,
  layouts: 8,
  views: 16,
  regions: 32,
  inspectorModules: 64,
  settings: 64,
  tags: 64,
  operations: 128,
  propKeys: 128,
});

export const WORKSPACE_ID = /^[a-z0-9][a-z0-9.-]{2,63}$/;
export const COMPONENT_ID = /^[a-z][a-z0-9.-]{2,95}$/;
export const SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/;
export const UNSAFE_KEY = /^(?:__proto__|prototype|constructor)$/;
export const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
