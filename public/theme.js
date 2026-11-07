// Runs before first paint so the page doesn't flash the wrong theme.
(function () {
  try {
    var saved = localStorage.getItem('ishare:theme');
    var dark = saved
      ? saved === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
  }
})();
