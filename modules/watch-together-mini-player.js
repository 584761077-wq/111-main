(() => {
  const modal = document.getElementById('watch-together-modal');
  const sourceVideo = document.getElementById('watch-together-video');
  const miniPlayer = document.getElementById('watch-together-mini-player');
  const miniVideo = document.getElementById('watch-together-mini-video');
  const emptyState = miniPlayer.querySelector('.watch-together-mini-player__empty');
  const toggleButton = document.getElementById('watch-together-mini-toggle');
  const collapseButton = document.getElementById('watch-together-mini-collapse');
  const collapsedBar = document.getElementById('watch-together-mini-bar');
  const title = document.getElementById('watch-together-mini-title');
  const collapsedTitle = document.getElementById('watch-together-mini-bar-title');
  const chatHeader = document.querySelector('.header .default-controls');

  let syncing = false;

  function hasVideo() {
    return Boolean(sourceVideo.currentSrc || sourceVideo.src);
  }

  function setTitle() {
    const videoTitle = sourceVideo.dataset.title || '一起看电影';
    title.textContent = videoTitle;
    collapsedTitle.textContent = `正在一起看：${videoTitle}`;
  }

  function syncPlayback(source, target) {
    if (syncing || !hasVideo()) return;
    syncing = true;
    const delta = Math.abs((source.currentTime || 0) - (target.currentTime || 0));
    if (delta > 0.75) target.currentTime = source.currentTime || 0;
    target.muted = source.muted;
    target.volume = source.volume;
    if (source.paused) target.pause();
    else target.play().catch(() => {});
    syncing = false;
  }

  function showMiniPlayer() {
    if (!hasVideo()) return;
    miniPlayer.classList.add('is-visible');
    miniPlayer.classList.remove('is-collapsed');
    collapsedBar.classList.remove('is-visible');
    setTitle();
    miniVideo.src = sourceVideo.currentSrc || sourceVideo.src;
    miniVideo.load();
    miniVideo.currentTime = sourceVideo.currentTime || 0;
    emptyState.hidden = true;
    syncPlayback(sourceVideo, miniVideo);
  }

  function collapseMiniPlayer() {
    if (!miniPlayer.classList.contains('is-visible')) return;
    syncPlayback(miniVideo, sourceVideo);
    miniPlayer.classList.add('is-collapsed');
    collapsedBar.classList.add('is-visible');
  }

  function expandMiniPlayer() {
    miniPlayer.classList.remove('is-collapsed');
    collapsedBar.classList.remove('is-visible');
    syncPlayback(sourceVideo, miniVideo);
  }

  sourceVideo.addEventListener('loadedmetadata', showMiniPlayer);
  sourceVideo.addEventListener('play', () => {
    showMiniPlayer();
    toggleButton.textContent = 'Ⅱ';
    syncPlayback(sourceVideo, miniVideo);
  });
  sourceVideo.addEventListener('pause', () => {
    toggleButton.textContent = '▶';
    if (!syncing) miniVideo.pause();
  });
  sourceVideo.addEventListener('timeupdate', () => syncPlayback(sourceVideo, miniVideo));
  miniVideo.addEventListener('play', () => {
    toggleButton.textContent = 'Ⅱ';
    syncPlayback(miniVideo, sourceVideo);
  });
  miniVideo.addEventListener('pause', () => {
    toggleButton.textContent = '▶';
    if (!syncing) sourceVideo.pause();
  });
  miniVideo.addEventListener('timeupdate', () => syncPlayback(miniVideo, sourceVideo));

  toggleButton.addEventListener('click', () => {
    if (!hasVideo()) return;
    if (miniVideo.paused) miniVideo.play().catch(() => {});
    else miniVideo.pause();
  });

  collapseButton.addEventListener('click', collapseMiniPlayer);
  collapsedBar.addEventListener('click', expandMiniPlayer);
  chatHeader?.addEventListener('click', () => {
    if (miniPlayer.classList.contains('is-visible') && !miniPlayer.classList.contains('is-collapsed')) {
      collapseMiniPlayer();
    }
  });

  document.getElementById('close-watch-together-btn')?.addEventListener('click', () => {
    if (hasVideo()) showMiniPlayer();
  });

  const observer = new MutationObserver(() => {
    if (!modal.classList.contains('visible') && hasVideo()) showMiniPlayer();
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });

  window.watchTogetherMiniPlayer = { show: showMiniPlayer };
})();
