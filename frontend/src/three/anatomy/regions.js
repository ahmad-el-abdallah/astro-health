// The 7 body regions the app tracks (config/content.json body_parts) and which named
// nodes of public/models/anatomy.glb draw each one. `immune` is drawn as the lungs --
// the same stand-in the old procedural twin used.
export const REGIONS = ["brain", "eyes", "heart", "immune", "stomach", "skeleton", "muscles"];

export const REGION_NODES = {
  brain: ["brain"],
  eyes: ["eyes"],
  heart: ["heart"],
  immune: ["immune"],
  stomach: ["stomach"],
  skeleton: ["skeleton"],
  muscles: ["muscles"],
};

// Which layer toggle hides each node.
export const NODE_LAYER = {
  skin: "skin",
  muscles: "muscles",
  skeleton: "bones",
  skeleton_wire: "bones",
  brain: "organs",
  eyes: "organs",
  heart: "organs",
  immune: "organs",
  stomach: "organs",
};

// Whole-body regions get a full-body camera shot instead of a close-up.
export const WHOLE_BODY = new Set(["skeleton", "muscles"]);

// Click/tap priority when several regions are under the pointer (organs sit inside the
// rib cage, so a click on the chest should pick the heart/lungs, not the ribs).
export const PICK_PRIORITY = ["eyes", "heart", "brain", "stomach", "immune", "skeleton", "muscles"];

// Free-text keyword → region, for the consultation chat's offline fallback (ported from
// static/js/tabs/body.js; eyes has no keyword there either).
export const REGION_KEYWORDS = [
  ["brain", /head|migraine|dizz|sleep|insomnia|stress|anxi|mood|focus/i],
  ["heart", /heart|chest|pulse|palpit|pressure/i],
  ["immune", /fever|temperature|cough|breath|cold|chill/i],
  ["stomach", /stomach|nausea|hungry|thirst|sugar|glucose|abdomen/i],
  ["skeleton", /back|bone|joint|knee|spine/i],
  ["muscles", /muscle|leg|arm|shoulder|cramp|sore/i],
];
