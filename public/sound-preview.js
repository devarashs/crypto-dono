/*
 * Preview buttons on the soundboard pads. One sound at a time: pressing a pad's
 * button plays its sound, pressing it again (or another pad's) stops it.
 * Without this script the buttons stay hidden and the page works as a form.
 */
let playing = null;

function stop() {
  if (playing === null) return;
  playing.audio.pause();
  playing.button.setAttribute('aria-pressed', 'false');
  playing = null;
}

for (const button of document.querySelectorAll('[data-preview]')) {
  button.hidden = false;
  button.addEventListener('click', () => {
    const wasThisOne = playing?.button === button;
    stop();
    if (wasThisOne) return;
    const audio = new Audio(button.dataset.preview);
    playing = { audio, button };
    button.setAttribute('aria-pressed', 'true');
    const finished = () => {
      if (playing?.audio === audio) stop();
    };
    audio.addEventListener('ended', finished, { once: true });
    audio.addEventListener('error', finished, { once: true });
    audio.play().catch(finished);
  });
}
