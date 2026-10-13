/*
 * On-stream viewer count Browser Source: total watching on Twitch and Kick,
 * and each platform's share. Hidden while offline everywhere.
 */
import { connectLiveStream } from './live-stream.js';
import { renderViewerCount } from './stream-widgets.js';

const pill = document.getElementById('viewers');
connectLiveStream(document.body.dataset.streamUrl, {
  status: (statuses) => renderViewerCount(pill, statuses),
});
