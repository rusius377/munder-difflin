// Runs before the shared i18n module reads the saved language: the standalone
// desk starts in Korean (the office app starts in English). Picking another
// language in the bottom bar is remembered as usual.
try {
  if (!window.localStorage.getItem('cth.language')) window.localStorage.setItem('cth.language', 'ko');
} catch { /* storage unavailable: the shared default applies */ }
export {};
