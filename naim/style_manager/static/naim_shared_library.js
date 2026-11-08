/* The embedded shared-style tab presents the native source collector. */
(() => {
  const tab = document.querySelector('[data-tab="arca-style-collector"]');
  const view = document.getElementById('arca-style-collector-tab');
  if (!tab || !view) return;
  tab.textContent = '공유 그림체';
  view.classList.add('naim-common-library-view');
})();
