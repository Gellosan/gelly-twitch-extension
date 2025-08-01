let twitchUserId = null;
let selectedColor = 'blue';

// Get auth from Twitch
window.Twitch.ext.onAuthorized((auth) => {
  twitchUserId = auth.userId;
  connectWebSocket();

  // Button events
  document.getElementById('feedBtn')?.addEventListener('click', () => interact('feed'));
  document.getElementById('playBtn')?.addEventListener('click', () => interact('play'));
  document.getElementById('cleanBtn')?.addEventListener('click', () => interact('clean'));
  document.getElementById('helpBtn')?.addEventListener('click', showHelp);
});

function connectWebSocket() {
  if (!twitchUserId) return;
  const socket = new WebSocket(`wss://gelly-server.onrender.com/?user=${twitchUserId}`);

  socket.addEventListener('open', () => console.log('WebSocket connected'));
  socket.addEventListener('error', () => console.error('WebSocket error'));

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'update') updateUI(msg.state);
    else if (msg.type === 'leaderboard') updateLeaderboard(msg.entries);
  });
}

function updateLeaderboard(entries) {
  const list = document.getElementById('leaderboard-list');
  if (!list) return;

  const sorted = [...entries].sort((a, b) => {
    if (b.mood !== a.mood) return b.mood - a.mood;
    if (b.energy !== a.energy) return b.energy - a.energy;
    return b.cleanliness - a.cleanliness;
  });

  const topTen = sorted.slice(0, 10);
  list.innerHTML = '';

  topTen.forEach((entry, index) => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>#${index + 1}</strong> ${entry.user} 
      <span> - Mood: ${entry.mood} | Energy: ${entry.energy} | Cleanliness: ${entry.cleanliness}</span>`;
    list.appendChild(li);
  });
}

function updateUI(state) {
  document.getElementById('energy').innerText = state.energy;
  document.getElementById('mood').innerText = state.mood;
  document.getElementById('cleanliness').innerText = state.cleanliness;

  const gellyImage = document.getElementById('gelly-image');
  const stage = state.stage || 'egg';
  const color = state.color || 'blue';

  if (stage === 'egg') {
    gellyImage.src = 'assets/egg.png';
  } else if (stage === 'blob') {
    gellyImage.src = `assets/blob-${color}.png`;
  } else if (stage === 'gelly') {
    gellyImage.src = `assets/gelly-${color}.png`;
  }
}

function showMessage(msg) {
  const el = document.getElementById('message');
  el.innerText = msg;
  setTimeout(() => el.innerText = '', 3000);
}

function showHelp() {
  const box = document.getElementById('help-box');
  if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

function interact(action) {
  if (!twitchUserId) return showMessage("User not authenticated.");

  fetch('https://gelly-server.onrender.com/v1/interact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, user: twitchUserId })
  })
  .then(res => res.json())
  .then(data => {
    if (!data.success) showMessage(data.message);
  })
  .catch(err => {
    console.error(err);
    showMessage('Network error');
  });
}
