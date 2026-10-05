const overlay = document.getElementById('stream-status');
const message = document.getElementById('stream-message');
window.addEventListener('observer-stream-state', event => {
  const connected = event.detail === 'connected';
  overlay.hidden = connected;
  if (!connected) message.textContent = '3D stream stopped. The image is stale. Refresh after a dimension change, respawn or connection loss.';
});
