/*
 * On-stream chat Browser Source: Twitch and Kick chat, no box, each message
 * fading after a while. Settings come from the page (?fade=, ?max=).
 */
import { connectLiveStream } from './live-stream.js';
import { createStreamChat } from './stream-widgets.js';

const settings = document.body.dataset;
const chat = createStreamChat(document.getElementById('chat'), {
  maxMessages: Number(settings.maxMessages) || 12,
  fadeSeconds: Number(settings.fadeSeconds),
});

connectLiveStream(settings.streamUrl, {
  chatSnapshot: chat.snapshot,
  chat: chat.add,
  chatRemove: chat.remove,
});
