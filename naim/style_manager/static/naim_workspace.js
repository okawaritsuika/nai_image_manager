/* Move the existing controls so their listeners and feature state stay intact. */
(() => {
  const destination = document.getElementById("naimStyleNavigation");
  const navigation = document.querySelector(".topbar .tabs");
  if (!destination || !navigation) return;

  const groups = [
    ["작가 탐색", ["pick", "ratings", "nai-artist-test", "style-group"]],
    ["그림체 작업", ["style-maker", "style-manager", "comparison"]],
    ["공유와 분석", ["arca-style-collector", "style-worldcup", "arca-style-statistics"]],
  ];
  navigation.setAttribute("aria-label", "그림체 기능");
  for (const [label, tabs] of groups) {
    const heading = document.createElement("span");
    heading.className = "naim-navigation-heading";
    heading.textContent = label;
    navigation.appendChild(heading);
    for (const name of tabs) {
      const button = navigation.querySelector(`[data-tab="${name}"]`);
      if (!button) continue;
      if (name === "style-manager") button.textContent = "확정 그림체";
      button.setAttribute("aria-controls", `${name}-tab`);
      navigation.appendChild(button);
    }
  }
  const settings = navigation.querySelector("#openSettings");
  if (settings) {
    settings.textContent = "그림체 관리 설정";
    settings.classList.add("naim-settings-entry");
    navigation.appendChild(settings);
  }
  destination.appendChild(navigation);

  const refreshCurrent = () => {
    for (const button of navigation.querySelectorAll(".tab")) {
      if (button.classList.contains("active")) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  };
  navigation.addEventListener("click", refreshCurrent);
  refreshCurrent();
  const sharedStyle = document.createElement("link");
  sharedStyle.rel = "stylesheet";
  sharedStyle.href = "/style-workspace/static/naim_shared_library.css";
  document.head.appendChild(sharedStyle);
  const sharedScript = document.createElement("script");
  sharedScript.src = "/style-workspace/static/naim_shared_library.js";
  document.body.appendChild(sharedScript);
  const settingsScript = document.createElement('script');
  settingsScript.src = '/style-workspace/static/naim_shared_settings.js';
  document.body.appendChild(settingsScript);
})();
