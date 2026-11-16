// The agent's side of the tricks: the section of its prompt that says how it uses the web, with agent-browser on its
// computer, and how a browser task becomes a trick. The person sees the tricks in the app (tricks.ts).
import { defineExtension, section } from "@earendil-works/pi-durable";

const BROWSER =
  'To use the web, drive the browser on your computer with the agent-browser CLI in bash: it opens Chrome on your computer\'s screen, where the user can watch you and sign in to sites for you. Before your first browser task, read `agent-browser skills get core`. Every browser session is recorded, so a task you did once can become a trick (agent-browser calls it a saved flow) that later runs in a second without the page. When `open` or `agent-browser flow list` shows a trick that fits the task, run it with `agent-browser flow run`, and use the page only if that fails. After a browser task the user may ask for again, keep it as a trick: if it only read, save it yourself with `agent-browser flow save <name> --description "<what it does, such as Search Hacker News>" --param <name>=<each value you typed>` and say so in one short sentence; if it changed something (sent, bought, booked, posted, deleted), ask the user before saving it. The user sees your tricks in the app; call them tricks.';

/** How the imp uses the web, and keeps what it did there as tricks. */
export const tricksExtension = defineExtension({
  name: "tricks",
  sections: [section("browser", () => BROWSER, { tag: false })],
});
