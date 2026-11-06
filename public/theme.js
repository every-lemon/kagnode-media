(() => {
  try {
    const theme = localStorage.getItem("kagnode.theme");
    document.documentElement.dataset.theme = ["dark", "light"].includes(theme)
      ? theme
      : matchMedia("(prefers-color-scheme:light)").matches
        ? "light"
        : "dark";
  } catch {}
})();
