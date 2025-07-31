let twitchUserId = null;
let selectedColor = 'blue';
let blobColor = null;

window.Twitch.ext.onAuthorized(function(auth) {
  twitchUserId = auth.userId;
  connectWebSocket();
});

function connectWebSocket() {
  const socket = new WebSocket('wss://gelly-server.onrender.com/?user=' + twitchUserId);
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'update') updateUI(msg.state);
    else if (msg.type === 'leaderboard') {
      const list = document.getElementById('leaderboard-list');
      list.innerHTML = '';
      msg.entries.forEach(entry => {
        const li = document.createElement('li');
        li.innerText = `${entry.user}: ${entry.mood} mood`;
        list.appendChild(li);
      });
    }
  });
}

function updateUI(state) {
  document.getElementById('energy').innerText = state.energy;
  document.getElementById('mood').innerText = state.mood;
  document.getElementById('cleanliness').innerText = state.cleanliness;

  const img = document.getElementById('gelly-image');

  if (state.stage === 'egg') {
    img.src = `egg.png`;
    blobColor = null;
  } else if (state.stage === 'blob') {
    img.src = `blob-${selectedColor}.png`;
    blobColor = selectedColor;
  } else {
    const finalColor = blobColor || selectedColor;
    img.src = `gelly-${finalColor}.png`;
  }
}

function showMessage(msg) {
  const el = document.getElementById('message');
  el.innerText = msg;
  setTimeout(() => el.innerText = '', 3000);
}

function showHelp() {
  const box = document.getElementById('help-box');
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

function interact(action) {
  if (!twitchUserId) return showMessage("User not authenticated.");
  fetch('https://gelly-server.onrender.com/interact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, user: twitchUserId })
  })
  .then(res => res.json())
  .then(data => {
    if (!data.success) showMessage(data.message);
  });
}

function changeColor(color) {
  selectedColor = color;
  interact('color:' + color);
}
