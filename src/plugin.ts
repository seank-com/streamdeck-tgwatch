import streamDeck from "@elgato/streamdeck";

import { ChatWatch } from "./actions/chat-watch.js";
import { telegram } from "./telegram.js";

// Don't use "trace": it would log the login code and session traffic.
streamDeck.logger.setLevel("info");

const chatWatch = new ChatWatch();
streamDeck.actions.registerAction(chatWatch);

// Keep an open property inspector in sync with login state and the chat list.
const isOurPI = () => streamDeck.ui.action?.manifestId === chatWatch.manifestId;
telegram.on("status", (s) => {
	if (isOurPI()) void streamDeck.ui.sendToPropertyInspector({ event: "status", ...s });
});
telegram.on("picker", () => {
	if (isOurPI()) void streamDeck.ui.sendToPropertyInspector({ event: "getChats", items: telegram.pickerItems() });
});

await streamDeck.connect();
void telegram.init();
