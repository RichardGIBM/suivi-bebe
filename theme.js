/* Thème horaire, appliqué avant le premier rendu pour éviter un flash blanc. */
(() => {
  let timer;
  function updateTheme() {
    clearTimeout(timer);
    const now = new Date();
    const hour = now.getHours();
    const dark = hour >= 22 || hour < 6;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#14151a' : '#ffffff';
    // Réévaluer à la prochaine minute et à chaque retour de veille.
    timer = setTimeout(updateTheme, 60000 - now.getSeconds() * 1000 - now.getMilliseconds());
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateTheme();
  });
  window.addEventListener('pageshow', updateTheme);
  updateTheme();
})();
