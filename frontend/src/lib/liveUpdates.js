// Wires server broadcasts to cached data: when the backend says something changed, the
// matching queries refetch in the background and on-screen numbers/charts tween to the
// new values. Imported once from main.jsx.
import { queryClient } from "./queries.js";
import { EVENT_INVALIDATIONS, socket } from "./socket.js";

Object.entries(EVENT_INVALIDATIONS).forEach(([event, keys]) => {
  socket.on(event, () => keys.forEach((queryKey) => queryClient.invalidateQueries({ queryKey })));
});

// "Reset demo data" replaces everything.
socket.on("data_reset", () => queryClient.invalidateQueries());
