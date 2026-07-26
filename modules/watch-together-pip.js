(() => {
  function showPiP() {
    const shell = document.getElementById('watch-together-pip-shell');
    const bar = document.getElementById('watch-together-pip-bar');
    const video = document.getElementById('watch-together-video');
    const body = document.getElementById('watch-together-pip-body');
    const placeholder = document.getElementById('watch-together-pip-placeholder');
    const modal = document.getElementById('watch-together-modal');

    if (!shell || !bar || !video || !body || !modal) {
      console.error('[一起看电影] 悬浮播放器缺少页面元素');
      return false;
    }

    if (video.parentElement !== body) body.insertBefore(video, placeholder);

    shell.style.cssText = 'position:fixed!important;top:58px!important;left:50%!important;z-index:2147483647!important;display:block!important;width:min(92vw,420px)!important;transform:translateX(-50%)!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;';
    shell.classList.add('is-visible');
    shell.classList.remove('is-collapsed');
    bar.classList.remove('is-visible', 'is-left', 'is-right');
    modal.classList.remove('visible');
    console.log('[一起看电影] 悬浮播放器已打开');
    return false;
  }

  function collapsePiP() {
    const shell = document.getElementById('watch-together-pip-shell');
    const bar = document.getElementById('watch-together-pip-bar');
    if (!shell || !bar) return;
    shell.style.display = 'none';
    shell.classList.remove('is-visible');
    bar.classList.add('is-visible', 'is-right');
  }

  function restoreWatchTogether() {
    const shell = document.getElementById('watch-together-pip-shell');
    const bar = document.getElementById('watch-together-pip-bar');
    const video = document.getElementById('watch-together-video');
    const videoContainer = document.getElementById('watch-together-video-container');
    const placeholder = document.getElementById('watch-together-placeholder');
    const modal = document.getElementById('watch-together-modal');
    if (!shell || !bar || !video || !videoContainer || !modal) return;
    videoContainer.insertBefore(video, placeholder);
    shell.style.display = 'none';
    shell.classList.remove('is-visible');
    bar.classList.remove('is-visible', 'is-left', 'is-right');
    modal.classList.add('visible');
  }

  window.showWatchTogetherPiP = showPiP;

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('watch-together-pip-collapse-btn')?.addEventListener('click', collapsePiP);
    document.getElementById('watch-together-pip-bar')?.addEventListener('click', showPiP);
    document.getElementById('watch-together-pip-back-btn')?.addEventListener('click', restoreWatchTogether);
  });
})();
