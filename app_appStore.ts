/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { openApps, pinnedApps, setPinnedApps } from "/state.ts";
import { getText } from "/i18n.ts";
import { openApp, spawnClonedWindow, openExternalApp, closeApp, renderTaskbar } from "/windowManager.ts";
import { desktop } from "/dom.ts";
import { updateAllText, updateStartMenuPins, showToast } from "/ui.ts";
import { setupIconInteraction, placeIconInNextSlot } from "/iconManager.ts";
import { PINNED_APPS_STORAGE_KEY } from "/constants.ts";
import { CONFIG } from "/geminiStudio/common.ts";
const GITHUB_BRANCH = "main";
const APPS_PATH = "apps";
const placeholderApps = [];
async function fetchDownloadStats() {
  const user = CONFIG.GITHUB_USER;
  const repo = CONFIG.GITHUB_REPO;
  if (!user || !repo) return {};
  try {
    const response = await fetch(`https://api.github.com/repos/${user}/${repo}/contents/apps/stats.json`, {
      headers: { "Accept": "application/vnd.github.v3.raw" },
      cache: "no-store"
    });
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {
    console.warn("Failed to fetch download stats", e);
  }
  return {};
}
async function updateDownloadStats(appId) {
  const user = CONFIG.GITHUB_USER;
  const repo = CONFIG.GITHUB_REPO;
  const token = CONFIG.GITHUB_TOKEN;
  if (!user || !repo || !token) return;
  try {
    let stats = {};
    let sha = "";
    const getRes = await fetch(`https://api.github.com/repos/${user}/${repo}/contents/apps/stats.json`, {
      headers: {
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github.v3+json"
      },
      cache: "no-store"
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
      stats = JSON.parse(atob(data.content));
    }
    stats[appId] = (stats[appId] || 0) + 1;
    await fetch(`https://api.github.com/repos/${user}/${repo}/contents/apps/stats.json`, {
      method: "PUT",
      headers: {
        "Authorization": `token ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `Update stats for ${appId}`,
        content: btoa(JSON.stringify(stats, null, 2)),
        sha: sha || void 0
      })
    });
  } catch (e) {
    console.error("Failed to update download stats", e);
  }
}
const susApp = {
  id: "susApp",
  name: getText("app_susApp_name"),
  icon: "https://img.icons8.com/fluency/96/virus.png",
  description: getText("app_susApp_desc"),
  category: "all",
  // Special category to only show in all apps
  version: "v1"
};
const loadInstalledApps = () => {
  try {
    const stored = localStorage.getItem("gemini_installed_apps");
    if (stored) {
      return new Map(JSON.parse(stored));
    }
  } catch (e) {
    console.error("Failed to load installed apps:", e);
  }
  return /* @__PURE__ */ new Map();
};
const saveInstalledApps = () => {
  localStorage.setItem("gemini_installed_apps", JSON.stringify(Array.from(storeState.installedApps.entries())));
};
let storeState = {
  untrustedEnabled: false,
  installedApps: loadInstalledApps(),
  // ID -> Version Map
  externalApps: [],
  hasFetched: false
};
function normalizeCategory(rawCategory) {
  if (!rawCategory) return "Utilities";
  const cat = rawCategory.toLowerCase().trim();
  if (["game", "games", "arcade", "puzzle", "action", "rpg", "simulation"].includes(cat)) return "Games";
  if (["utility", "utilities", "tool", "tools", "system", "sys"].includes(cat)) return "Utilities";
  if (["productivity", "office", "work", "writing", "note", "finance"].includes(cat)) return "Productivity";
  if (["entertainment", "media", "music", "video", "fun", "art", "social"].includes(cat)) return "Entertainment";
  if (["education", "learning", "reference", "science", "math"].includes(cat)) return "Education";
  return rawCategory.charAt(0).toUpperCase() + rawCategory.slice(1);
}
export async function fetchExternalApps() {
  if (storeState.hasFetched) return storeState.externalApps;
  const user = CONFIG.GITHUB_USER;
  const repo = CONFIG.GITHUB_REPO;
  if (!user || !repo) {
    console.warn("AppStore: GITHUB_USER or GITHUB_REPO is not set.");
    return [];
  }
  try {
    const headers = {
      "Accept": "application/vnd.github.v3+json"
    };
    if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_TOKEN.trim() !== "") {
      headers["Authorization"] = `token ${CONFIG.GITHUB_TOKEN}`;
    }
    console.log(`AppStore: Fetching apps from https://api.github.com/repos/${user}/${repo}/contents/${APPS_PATH} ...`);
    const response = await fetch(`https://api.github.com/repos/${user}/${repo}/contents/${APPS_PATH}`, {
      headers,
      cache: "no-store"
    });
    if (!response.ok) {
      const errorBody = await response.text();
      console.warn(`AppStore: GitHub API returned ${response.status} for ${APPS_PATH}. Body: ${errorBody}`);
      if (response.status === 403 && errorBody.includes("rate limit")) {
        showToast("GitHub Rate Limit Exceeded. Please add a Token in Settings > System.", "error");
      }
      if (response.status === 404) {
        console.log("Apps directory not found in repo yet.");
        return [];
      }
      return [];
    }
    const files = await response.json();
    console.log(`AppStore: Found ${files.length} items in ${APPS_PATH}`);
    if (!Array.isArray(files)) return [];
    const folders = files.filter((f) => f.type === "dir");
    console.log(`AppStore: Found ${folders.length} app folders`);
    const stats = await fetchDownloadStats();
    const promises = folders.map(async (folder) => {
      const manifestApiUrl = `https://api.github.com/repos/${user}/${repo}/contents/${APPS_PATH}/${folder.name}/manifest.json`;
      try {
        const headers2 = {
          "Accept": "application/vnd.github.v3.raw"
        };
        if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_TOKEN.trim() !== "") {
          headers2["Authorization"] = `token ${CONFIG.GITHUB_TOKEN}`;
        }
        const manifestRes = await fetch(manifestApiUrl, {
          headers: headers2,
          cache: "no-store"
        });
        if (manifestRes.ok) {
          const manifestText = await manifestRes.text();
          let manifest;
          try {
            manifest = JSON.parse(manifestText);
          } catch (e) {
            console.error(`AppStore: Failed to parse manifest for ${folder.name}. Content:`, manifestText);
            return null;
          }
          let iconUrl = manifest.icon || CONFIG.DEFAULT_ICON;
          if (iconUrl && !iconUrl.startsWith("http") && !iconUrl.startsWith("data:")) {
            iconUrl = `https://raw.githubusercontent.com/${user}/${repo}/${GITHUB_BRANCH}/${APPS_PATH}/${folder.name}/${iconUrl}?t=${Date.now()}`;
          }
          const appId = manifest.id || folder.name;
          return {
            ...manifest,
            icon: iconUrl,
            category: normalizeCategory(manifest.category),
            isExternal: true,
            folderName: folder.name,
            id: appId,
            githubUser: user,
            githubRepo: repo,
            githubBranch: GITHUB_BRANCH,
            appsPath: APPS_PATH,
            featured: !!manifest.featured,
            // Capture featured status
            capabilities: manifest.capabilities || [],
            // Capture capabilities
            downloadCount: stats[appId] || 0
          };
        }
      } catch (err) {
        console.warn(`Failed to load manifest from ${folder.name}`, err);
      }
      return null;
    });
    const results = await Promise.all(promises);
    const apps = results.filter((app) => app !== null);
    storeState.externalApps = apps;
    storeState.hasFetched = true;
    return apps;
  } catch (error) {
    console.warn("Failed to connect to GitHub Store:", error);
    return [];
  }
}
function launchMobileVirus() {
  const appStoreWindow = document.getElementById("appStore");
  if (!appStoreWindow) return;
  const overlay = document.createElement("div");
  overlay.className = "mobile-virus-overlay";
  const icon = document.createElement("img");
  icon.src = susApp.icon;
  icon.className = "mobile-virus-icon";
  const text = document.createElement("p");
  text.className = "mobile-virus-text";
  text.textContent = "SYSTEM COMPROMISED";
  overlay.appendChild(icon);
  overlay.appendChild(text);
  appStoreWindow.appendChild(overlay);
  appStoreWindow.classList.add("mobile-virus-active");
  setTimeout(() => {
    if (overlay.parentNode === appStoreWindow) {
      appStoreWindow.removeChild(overlay);
    }
    appStoreWindow.classList.remove("mobile-virus-active");
  }, 4e3);
}
function launchDesktopVirus() {
  let virusCount = 0;
  const maxViruses = 15;
  const originalBgColor = document.getElementById("desktop")?.style.backgroundColor;
  const virusInterval = setInterval(() => {
    if (virusCount >= maxViruses) {
      clearInterval(virusInterval);
      const desktop3 = document.getElementById("desktop");
      if (desktop3 && originalBgColor) {
        desktop3.style.backgroundColor = originalBgColor;
      }
      return;
    }
    spawnClonedWindow("virusWindow", "title_virusWindow");
    const randomColor = "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0");
    const desktop2 = document.getElementById("desktop");
    if (desktop2) {
      desktop2.style.backgroundColor = randomColor;
    }
    virusCount++;
  }, 500);
}
function launchVirus() {
  if (document.body.classList.contains("mobile-mode")) {
    launchMobileVirus();
  } else {
    launchDesktopVirus();
  }
}
function ensureDownloadsFolderIcon() {
  const existing = document.querySelector('.icon[data-app="downloadsFolder"]');
  if (existing) return;
  const iconDiv = document.createElement("div");
  iconDiv.className = "icon";
  iconDiv.dataset.app = "downloadsFolder";
  iconDiv.innerHTML = `
        <img src="https://img.icons8.com/fluency/96/folder-invoices.png" alt="Downloads" style="width: 48px; height: 48px; margin-bottom: 8px;" />
        <span data-i18n-key="icon_downloads">Downloaded Apps</span>
    `;
  iconDiv.addEventListener("click", () => openApp("downloadsFolder"));
  desktop?.appendChild(iconDiv);
  placeIconInNextSlot(iconDiv);
  setupIconInteraction(iconDiv);
  updateAllText();
}
function addAppToDownloadsFolder(app) {
  ensureDownloadsFolderIcon();
  const folderContent = document.getElementById("downloads-content");
  if (!folderContent) return;
  const safeId = app.isExternal ? `ext-${app.id}` : app.id;
  const existingIcon = folderContent.querySelector(`.window-icon[data-app="${safeId}"]`);
  if (existingIcon) {
    existingIcon.remove();
  }
  const iconDiv = document.createElement("div");
  iconDiv.className = "window-icon";
  iconDiv.dataset.app = safeId;
  const img = document.createElement("img");
  img.src = app.icon;
  img.style.width = "32px";
  img.style.height = "32px";
  img.style.marginBottom = "5px";
  const span = document.createElement("span");
  span.textContent = app.name;
  iconDiv.appendChild(img);
  iconDiv.appendChild(span);
  iconDiv.addEventListener("click", () => {
    if (app.isExternal) {
      openExternalApp({
        ...app,
        githubUser: app.githubUser || CONFIG.GITHUB_USER,
        githubRepo: app.githubRepo || CONFIG.GITHUB_REPO,
        githubBranch: app.githubBranch || GITHUB_BRANCH,
        appsPath: app.appsPath || APPS_PATH
      });
    } else if (app.id === "susApp") {
      launchVirus();
    } else if (app.id === "doom") {
      openApp("doom");
    } else {
      showToast(getText("alert_fake_app_open", { appName: app.name }), "warning");
    }
  });
  folderContent.appendChild(iconDiv);
  setupIconInteraction(iconDiv);
}
async function downloadApp(app, button, refreshList) {
  const isUpdate = storeState.installedApps.has(app.id);
  const safeId = app.isExternal ? `ext-${app.id}` : app.id;
  if (isUpdate && openApps.has(safeId)) {
    closeApp(safeId);
  }
  button.disabled = true;
  button.classList.add("downloading");
  const updateProgress = (pct) => {
    button.textContent = `${Math.floor(pct)}%`;
    button.style.setProperty("--progress", `${pct}%`);
  };
  updateProgress(0);
  if (app.isExternal) {
    updateDownloadStats(app.id);
  }
  try {
    let downloadedContent = "";
    if (app.isExternal) {
      const user = app.githubUser || CONFIG.GITHUB_USER;
      const repo = app.githubRepo || CONFIG.GITHUB_REPO;
      const path = app.appsPath || APPS_PATH;
      const apiUrl = `https://api.github.com/repos/${user}/${repo}/contents/${path}/${app.folderName}/index.html`;
      let visualProgress = 0;
      const progressInterval = setInterval(() => {
        visualProgress += (90 - visualProgress) * 0.1;
        updateProgress(visualProgress);
      }, 200);
      const headers = {
        "Accept": "application/vnd.github.v3.raw"
      };
      if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_TOKEN.trim() !== "") {
        headers["Authorization"] = `token ${CONFIG.GITHUB_TOKEN}`;
      }
      const response = await fetch(apiUrl, {
        headers,
        cache: "no-store"
      });
      clearInterval(progressInterval);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder("utf-8");
      if (reader) {
        const contentLength = +(response.headers.get("Content-Length") || 0);
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            downloadedContent += decoder.decode(value, { stream: true });
            received += value.length;
          }
          if (contentLength > 0) {
            const realPct = received / contentLength * 100;
            updateProgress(Math.max(visualProgress, realPct));
          }
        }
        downloadedContent += decoder.decode();
      } else {
        downloadedContent = await response.text();
      }
      localStorage.setItem(`gemini_app_content_${app.id}`, downloadedContent);
      try {
        const widgetApiUrl = `https://api.github.com/repos/${user}/${repo}/contents/${path}/${app.folderName}/widget.html`;
        const widgetResponse = await fetch(widgetApiUrl, { headers, cache: "no-store" });
        if (widgetResponse.ok) {
          const widgetContent = await widgetResponse.text();
          localStorage.setItem(`gemini_app_widget_${app.id}`, widgetContent);
          console.log(`AppStore: Downloaded custom widget for ${app.name}`);
        } else {
          localStorage.removeItem(`gemini_app_widget_${app.id}`);
        }
      } catch (wErr) {
        console.warn("AppStore: Failed to check for widget.html", wErr);
      }
      updateProgress(100);
      await new Promise((r) => setTimeout(r, 200));
    } else {
      for (let i = 0; i <= 100; i += 10) {
        updateProgress(i);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    storeState.installedApps.set(app.id, app.version || "v1");
    saveInstalledApps();
    try {
      const installedAppsStr = localStorage.getItem("gemini96-installed-apps");
      let installedAppsList = installedAppsStr ? JSON.parse(installedAppsStr) : [];
      installedAppsList = installedAppsList.filter((a) => a.id !== app.id);
      installedAppsList.push(app);
      localStorage.setItem("gemini96-installed-apps", JSON.stringify(installedAppsList));
    } catch (e) {
      console.error("Failed to save app metadata for widgets", e);
    }
    button.disabled = false;
    button.classList.remove("downloading");
    button.textContent = getText("btn_launch");
    button.style.removeProperty("--progress");
    addAppToDownloadsFolder(app);
    if (isUpdate) {
      showToast(`"${app.name}" updated to version ${app.version || "latest"}!`, "success");
    } else {
      showToast(getText("appstore_download_complete", { appName: app.name }), "success");
    }
    refreshList();
  } catch (error) {
    console.error("Download failed:", error);
    button.classList.remove("downloading");
    button.style.removeProperty("--progress");
    button.disabled = false;
    button.textContent = getText("btn_get") || "GET";
    showToast(`Download failed: ${error.message || "Network Error"}`, "error");
  }
}
function showAppDetails(app, refreshFn) {
  const installedVersion = storeState.installedApps.get(app.id);
  const currentStoreVersion = app.version || "v1";
  const isInstalled = !!installedVersion;
  const isUpdateAvailable = isInstalled && installedVersion !== currentStoreVersion;
  const author = app.githubUser || CONFIG.GITHUB_USER;
  const repo = app.githubRepo || CONFIG.GITHUB_REPO;
  const repoUrl = `https://github.com/${author}/${repo}`;
  const contentHtml = `
        <div class="store-details-header">
            <img src="${app.icon}" class="store-details-icon" onerror="this.src='https://img.icons8.com/fluency/96/application-window.png'">
            <div class="store-details-title-block">
                <h3>${app.name}</h3>
                <div class="store-details-meta">
                    <span class="store-details-version">${app.version || "v1"}</span>
                    <span class="store-details-category">${app.category}</span>
                    ${app.downloadCount !== void 0 ? `<span class="store-details-downloads" title="Total Downloads">⬇️ ${app.downloadCount}</span>` : ""}
                </div>
                <div class="store-details-author">
                    by <a href="${repoUrl}" target="_blank" rel="noopener noreferrer">@${author}</a>
                </div>
            </div>
        </div>
        <div class="store-details-body">
            <p>${app.description}</p>
        </div>
    `;
  const actions = [];
  if (isInstalled) {
    if (isUpdateAvailable) {
      actions.push({
        label: getText("btn_update"),
        primary: true,
        onClick: () => {
          const btn = document.createElement("button");
          downloadApp(app, btn, refreshFn);
        }
      });
    } else {
      actions.push({
        label: getText("btn_launch"),
        primary: true,
        onClick: () => {
          if (app.isExternal) {
            openExternalApp({
              ...app,
              githubUser: app.githubUser || CONFIG.GITHUB_USER,
              githubRepo: app.githubRepo || CONFIG.GITHUB_REPO,
              githubBranch: app.githubBranch || GITHUB_BRANCH,
              appsPath: app.appsPath || APPS_PATH
            });
          } else if (app.id === "susApp") {
            launchVirus();
          } else if (app.id === "doom") {
            openApp("doom");
          } else {
            showToast(getText("alert_fake_app_open", { appName: app.name }), "warning");
          }
        }
      });
    }
    actions.push({
      label: "Uninstall",
      danger: true,
      onClick: () => handleUninstall(app, refreshFn)
    });
  } else {
    actions.push({
      label: getText("btn_get"),
      primary: true,
      onClick: () => {
        const btn = document.createElement("button");
        downloadApp(app, btn, refreshFn);
      }
    });
  }
  actions.push({ label: "Close", onClick: () => {
  } });
  showStoreModal(app.name, contentHtml, actions);
}
function showStoreModal(title, contentHtml, actions) {
  const appStoreWindow = document.getElementById("appStore");
  if (!appStoreWindow) return;
  const overlay = appStoreWindow.querySelector(".store-modal-overlay");
  const titleEl = appStoreWindow.querySelector(".store-modal-title");
  const contentEl = appStoreWindow.querySelector(".store-modal-content");
  const footerEl = appStoreWindow.querySelector(".store-modal-footer");
  const closeBtn = appStoreWindow.querySelector(".store-modal-close");
  if (!overlay || !titleEl || !contentEl || !footerEl) return;
  titleEl.textContent = title;
  contentEl.innerHTML = contentHtml;
  footerEl.innerHTML = "";
  const hideModal = () => overlay.style.display = "none";
  actions.forEach((action) => {
    const btn = document.createElement("button");
    btn.className = `store-modal-btn ${action.primary ? "primary" : ""} ${action.danger ? "danger" : ""}`;
    btn.textContent = action.label;
    btn.onclick = () => {
      action.onClick();
      if (action.label === "Close" || action.label === "Delete") hideModal();
      if (action.label === getText("btn_launch")) hideModal();
    };
    footerEl.appendChild(btn);
  });
  closeBtn.onclick = hideModal;
  overlay.style.display = "flex";
}
function handleUninstall(app, refreshList) {
  showStoreModal(
    "Uninstall App",
    `<p>Are you sure you want to delete <strong>${app.name}</strong>?</p>
         <p style="font-size:0.8rem; color:#666; margin-top:5px;">This will remove it from your Downloaded Apps folder and taskbar.</p>`,
    [
      { label: "Cancel", onClick: () => {
      } },
      {
        label: "Delete",
        danger: true,
        onClick: () => {
          const safeId = app.isExternal ? `ext-${app.id}` : app.id;
          if (openApps.has(safeId)) {
            closeApp(safeId);
          }
          storeState.installedApps.delete(app.id);
          saveInstalledApps();
          localStorage.removeItem(`gemini_app_content_${app.id}`);
          localStorage.removeItem(`gemini_app_widget_${app.id}`);
          try {
            const installedAppsStr = localStorage.getItem("gemini96-installed-apps");
            if (installedAppsStr) {
              let installedAppsList = JSON.parse(installedAppsStr);
              installedAppsList = installedAppsList.filter((a) => a.id !== app.id);
              localStorage.setItem("gemini96-installed-apps", JSON.stringify(installedAppsList));
            }
          } catch (e) {
            console.error("Failed to remove app metadata for widgets", e);
          }
          const folderContent = document.getElementById("downloads-content");
          if (folderContent) {
            const icon = folderContent.querySelector(`.window-icon[data-app="${safeId}"]`);
            if (icon) icon.remove();
          }
          const desktopIcon = document.querySelector(`#desktop > .icon[data-app="${safeId}"]`);
          if (desktopIcon) desktopIcon.remove();
          if (pinnedApps.includes(safeId)) {
            setPinnedApps(pinnedApps.filter((id) => id !== safeId));
            localStorage.setItem(PINNED_APPS_STORAGE_KEY, JSON.stringify(pinnedApps));
            renderTaskbar();
            updateStartMenuPins();
          }
          refreshList();
        }
      }
    ]
  );
}
export async function initializeAppStore(appId) {
  const windowEl = openApps.get(appId)?.windowEl;
  if (!windowEl) return;
  const listEl = windowEl.querySelector("#app-store-regular-list");
  const featuredListEl = windowEl.querySelector("#app-store-featured-list");
  const featuredSection = windowEl.querySelector("#app-store-featured-section");
  const settingsView = windowEl.querySelector(".app-store-settings-view");
  const categoryList = windowEl.querySelector(".app-store-categories-list");
  const untrustedToggle = windowEl.querySelector("#untrusted-toggle");
  const refreshBtn = windowEl.querySelector("#store-refresh-btn");
  const searchInput = windowEl.querySelector("#store-search-input");
  const sortSelect = windowEl.querySelector("#store-sort-select");
  if (!listEl || !categoryList || !settingsView || !untrustedToggle) return;
  if (!windowEl._hasRefreshListener) {
    windowEl._hasRefreshListener = true;
    window.addEventListener("store:refresh", () => {
      if (document.body.contains(windowEl) && windowEl.style.display !== "none") {
        if (refreshBtn) refreshBtn.click();
      } else {
        storeState.hasFetched = false;
        storeState.externalApps = [];
      }
    });
  }
  windowEl.addEventListener("gemini-os-back", (e) => {
    const overlay = windowEl.querySelector(".store-modal-overlay");
    if (overlay && overlay.style.display !== "none") {
      e.preventDefault();
      overlay.style.display = "none";
    }
  });
  const categoriesToAdd = [
    { id: "Productivity", key: "appstore_cat_prod", label: "Productivity" },
    { id: "Entertainment", key: "appstore_cat_ent", label: "Entertainment" },
    { id: "Education", key: "appstore_cat_edu", label: "Education" },
    { id: "dev", key: "appstore_cat_dev", label: "Developer" }
  ];
  categoriesToAdd.forEach((cat) => {
    if (!categoryList.querySelector(`[data-category="${cat.id}"]`)) {
      const settingsLi = categoryList.querySelector('[data-category="settings"]');
      const newLi = document.createElement("li");
      newLi.dataset.category = cat.id;
      newLi.dataset.i18nKey = cat.key;
      newLi.textContent = getText(cat.key) || cat.label;
      if (settingsLi && cat.id !== "dev") {
        categoryList.insertBefore(newLi, settingsLi);
      } else {
        categoryList.appendChild(newLi);
      }
    }
  });
  let devView = windowEl.querySelector(".app-store-dev-view");
  if (!devView) {
    devView = document.createElement("div");
    devView.className = "app-store-dev-view";
    devView.style.display = "none";
    devView.style.padding = "20px";
    devView.innerHTML = `
            <p style="margin-bottom:15px; font-size:0.9rem;">${getText("dev_intro")}</p>
            <div style="display:flex; flex-direction:column; gap:10px;">
                <label style="font-size:0.8rem;">${getText("dev_user_label")} <input type="text" id="dev-user" class="settings-select" value="${CONFIG.GITHUB_USER}" placeholder="e.g. your-username"></label>
                <label style="font-size:0.8rem;">${getText("dev_repo_label")} <input type="text" id="dev-repo" class="settings-select" value="${CONFIG.GITHUB_REPO}" placeholder="e.g. gemini-os-apps"></label>
                <label style="font-size:0.8rem;">${getText("dev_token_label")} <input type="password" id="dev-token" class="settings-select" value="${CONFIG.GITHUB_TOKEN}" placeholder="ghp_..."></label>
                <button id="dev-update-btn" style="margin-top:10px; padding:8px;" class="app-store-get-btn">${getText("dev_deploy_btn")}</button>
                <p id="dev-status" style="font-size:0.8rem; margin-top:10px;"></p>
            </div>
        `;
    windowEl.querySelector(".app-store-main")?.appendChild(devView);
    const updateBtn = devView.querySelector("#dev-update-btn");
    const statusEl = devView.querySelector("#dev-status");
    const userInput = devView.querySelector("#dev-user");
    const repoInput = devView.querySelector("#dev-repo");
    const tokenInput = devView.querySelector("#dev-token");
    updateBtn?.addEventListener("click", () => {
      const user = userInput.value.trim();
      const repo = repoInput.value.trim();
      const token = tokenInput.value.trim();
      if (user && repo) {
        CONFIG.GITHUB_USER = user;
        CONFIG.GITHUB_REPO = repo;
        if (token) CONFIG.GITHUB_TOKEN = token;
        storeState.hasFetched = false;
        storeState.externalApps = [];
        statusEl.textContent = getText("dev_status_success");
        statusEl.style.color = "green";
        setTimeout(() => statusEl.textContent = "", 3e3);
      } else {
        statusEl.textContent = getText("dev_status_error", { error: "Missing User or Repo" });
        statusEl.style.color = "red";
      }
    });
  }
  const renderAppItem = (app, container, refreshFn, isFeatured = false) => {
    const item = document.createElement("div");
    item.className = `app-store-item ${isFeatured ? "featured" : ""}`;
    const icon = document.createElement("img");
    icon.src = app.icon;
    icon.alt = app.name;
    icon.className = "app-store-item-icon";
    icon.style.cursor = "pointer";
    icon.onerror = () => {
      icon.src = "https://img.icons8.com/fluency/96/application-window.png";
    };
    icon.onclick = () => showAppDetails(app, refreshFn);
    const info = document.createElement("div");
    info.className = "app-store-item-info";
    info.style.cursor = "pointer";
    info.onclick = () => showAppDetails(app, refreshFn);
    const name = document.createElement("h4");
    if (app.isExternal) {
      name.textContent = app.name;
    } else {
      name.textContent = getText(app.id === "susApp" ? "app_susApp_name" : app.id);
      if (!name.textContent || name.textContent.startsWith("[")) name.textContent = app.name;
    }
    if (app.version) {
      const versionSpan = document.createElement("span");
      versionSpan.className = "app-store-version-tag";
      versionSpan.textContent = app.version;
      name.appendChild(versionSpan);
    }
    if (app.downloadCount !== void 0) {
      const dlSpan = document.createElement("span");
      dlSpan.className = "store-details-downloads";
      dlSpan.innerHTML = `⬇️ ${app.downloadCount}`;
      name.appendChild(dlSpan);
    }
    const desc = document.createElement("p");
    if (app.isExternal) {
      desc.textContent = app.description;
    } else {
      desc.textContent = getText(app.id === "susApp" ? "app_susApp_desc" : app.id + "_desc");
      if (!desc.textContent || desc.textContent.startsWith("[")) desc.textContent = app.description;
    }
    info.appendChild(name);
    info.appendChild(desc);
    const actionsContainer = document.createElement("div");
    actionsContainer.className = "app-store-actions";
    const actionBtn = document.createElement("button");
    actionBtn.className = "app-store-get-btn";
    const installedVersion = storeState.installedApps.get(app.id);
    const currentStoreVersion = app.version || "v1";
    if (installedVersion) {
      if (installedVersion !== currentStoreVersion) {
        actionBtn.textContent = getText("btn_update");
        actionBtn.onclick = () => downloadApp(app, actionBtn, refreshFn);
      } else {
        actionBtn.textContent = getText("btn_launch");
        actionBtn.onclick = () => {
          if (app.isExternal) {
            openExternalApp({
              ...app,
              githubUser: app.githubUser || CONFIG.GITHUB_USER,
              githubRepo: app.githubRepo || CONFIG.GITHUB_REPO,
              githubBranch: app.githubBranch || GITHUB_BRANCH,
              appsPath: app.appsPath || APPS_PATH
            });
          } else if (app.id === "susApp") {
            launchVirus();
          } else if (app.id === "doom") {
            openApp("doom");
          } else {
            showToast(getText("alert_fake_app_open", { appName: app.name }), "warning");
          }
        };
      }
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "app-store-delete-btn";
      deleteBtn.title = "Uninstall";
      deleteBtn.innerHTML = "🗑️";
      deleteBtn.onclick = () => handleUninstall(app, refreshFn);
      actionsContainer.appendChild(deleteBtn);
    } else {
      actionBtn.textContent = getText("btn_get");
      actionBtn.onclick = () => {
        downloadApp(app, actionBtn, refreshFn);
      };
    }
    actionsContainer.insertBefore(actionBtn, actionsContainer.firstChild);
    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(actionsContainer);
    container.appendChild(item);
  };
  const styleId = "app-store-vertical-style";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
            .app-store-list, #app-store-featured-list, #app-store-regular-list {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .app-store-item {
                width: 100%;
                display: flex;
                align-items: center;
                padding: 12px;
                border-bottom: 1px solid rgba(0,0,0,0.05);
                background: rgba(255,255,255,0.4);
                border-radius: 8px;
                margin-bottom: 4px;
            }
            .app-store-item:last-child { border-bottom: none; }
            .app-store-item-icon {
                width: 56px;
                height: 56px;
                margin-right: 16px;
                flex-shrink: 0;
            }
            .app-store-item-info {
                flex: 1;
                min-width: 0; /* Text truncation fix */
            }
            .app-store-item-info h4 {
                margin: 0 0 4px 0;
                font-size: 1rem;
            }
            .app-store-item-info p {
                margin: 0;
                font-size: 0.85rem;
                color: #666;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .app-store-actions {
                margin-left: 16px;
                display: flex;
                gap: 8px;
                align-items: center;
            }
            .app-store-load-more {
                width: 100%;
                padding: 12px;
                margin-top: 20px;
                background: rgba(0,0,0,0.05);
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 600;
                color: #555;
            }
            .app-store-load-more:hover {
                background: rgba(0,0,0,0.1);
            }
            .store-details-downloads {
                margin-left: 8px;
                font-size: 0.85rem;
                color: #555;
                background: rgba(0,0,0,0.05);
                padding: 2px 6px;
                border-radius: 4px;
                display: inline-flex;
                align-items: center;
                gap: 4px;
            }
        `;
    document.head.appendChild(style);
  }
  if (sortSelect && !sortSelect.querySelector('option[value="popularity"]')) {
    const popOption = document.createElement("option");
    popOption.value = "popularity";
    popOption.textContent = "Popularity";
    sortSelect.insertBefore(popOption, sortSelect.firstChild);
    sortSelect.value = "popularity";
  }
  let visibleCount = 10;
  const renderApps = (filter) => {
    listEl.style.display = "none";
    featuredSection.style.display = "none";
    settingsView.style.display = "none";
    devView.style.display = "none";
    if (filter === "settings") {
      settingsView.style.display = "block";
      return;
    }
    if (filter === "dev") {
      devView.style.display = "block";
      return;
    }
    listEl.style.display = "flex";
    listEl.innerHTML = "";
    featuredListEl.innerHTML = "";
    let allApps = [...placeholderApps, ...storeState.externalApps];
    console.log(`AppStore: Rendering ${allApps.length} apps (filter: ${filter})`);
    const searchTerm = searchInput.value.toLowerCase().trim();
    if (searchTerm) {
      allApps = allApps.filter(
        (app) => app.name.toLowerCase().includes(searchTerm) || app.description.toLowerCase().includes(searchTerm)
      );
    }
    let appsToRender = filter === "all" ? allApps : allApps.filter((app) => app.category === filter);
    if (storeState.untrustedEnabled && filter === "all" && !searchTerm) {
      appsToRender = [...appsToRender, susApp];
    }
    const sortMode = sortSelect.value;
    if (sortMode === "name-asc") {
      appsToRender.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === "name-desc") {
      appsToRender.sort((a, b) => b.name.localeCompare(a.name));
    } else if (sortMode === "random") {
      appsToRender.sort(() => Math.random() - 0.5);
    } else if (sortMode === "popularity") {
      appsToRender.sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));
    }
    const showFeaturedSeparate = filter === "all" && !searchTerm;
    const featuredApps = showFeaturedSeparate ? appsToRender.filter((app) => app.featured) : [];
    const regularApps = showFeaturedSeparate ? appsToRender.filter((app) => !app.featured) : appsToRender;
    if (featuredApps.length > 0) {
      featuredSection.style.display = "flex";
      featuredApps.forEach((app) => renderAppItem(app, featuredListEl, () => renderApps(filter), true));
    }
    const totalApps = regularApps.length;
    const visibleApps = regularApps.slice(0, visibleCount);
    if (visibleApps.length === 0 && featuredApps.length === 0) {
      listEl.innerHTML = `<div style="padding:20px; text-align:center; color:#666;">No apps found.</div>`;
      return;
    }
    visibleApps.forEach((app) => renderAppItem(app, listEl, () => renderApps(filter)));
    if (totalApps > visibleCount) {
      const loadMoreBtn = document.createElement("button");
      loadMoreBtn.className = "app-store-load-more";
      loadMoreBtn.textContent = `Load More (${totalApps - visibleCount} remaining)`;
      loadMoreBtn.onclick = () => {
        visibleCount += 10;
        renderApps(filter);
      };
      listEl.appendChild(loadMoreBtn);
    }
  };
  if (!categoryList.dataset.listener) {
    categoryList.dataset.listener = "true";
    categoryList.addEventListener("click", (e) => {
      const target = e.target.closest("li");
      if (target) {
        categoryList.querySelector(".active")?.classList.remove("active");
        target.classList.add("active");
        const category = target.dataset.category;
        visibleCount = 10;
        renderApps(category);
      }
    });
  }
  if (!untrustedToggle.dataset.listener) {
    untrustedToggle.dataset.listener = "true";
    untrustedToggle.checked = storeState.untrustedEnabled;
    untrustedToggle.addEventListener("change", () => {
      storeState.untrustedEnabled = untrustedToggle.checked;
      if (categoryList.querySelector(".active")?.dataset.category === "all") {
        renderApps("all");
      }
    });
  }
  const refreshView = () => {
    const activeCat = categoryList.querySelector(".active")?.dataset.category || "all";
    renderApps(activeCat);
  };
  if (searchInput && !searchInput.dataset.listener) {
    searchInput.addEventListener("input", refreshView);
    searchInput.dataset.listener = "true";
  }
  if (sortSelect && !sortSelect.dataset.listener) {
    sortSelect.addEventListener("change", refreshView);
    sortSelect.dataset.listener = "true";
  }
  if (refreshBtn && !refreshBtn.dataset.listener) {
    refreshBtn.dataset.listener = "true";
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      refreshBtn.classList.add("rotating");
      storeState.hasFetched = false;
      storeState.externalApps = [];
      listEl.innerHTML = `<div style="padding:20px; text-align:center;">Refreshing...</div>`;
      await fetchExternalApps();
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("rotating");
      refreshView();
    });
  }
  if (!storeState.hasFetched && CONFIG.GITHUB_USER && CONFIG.GITHUB_REPO) {
    const loadingItem = document.createElement("div");
    loadingItem.className = "app-store-item";
    loadingItem.innerHTML = `<p>${getText("appstore_status_fetching")}</p>`;
    listEl.insertBefore(loadingItem, listEl.firstChild);
    await fetchExternalApps();
    if (loadingItem.parentNode === listEl) listEl.removeChild(loadingItem);
  }
  storeState.installedApps = loadInstalledApps();
  renderApps("all");
}

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImFwcF9hcHBTdG9yZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJcbi8qKlxuICogQGxpY2Vuc2VcbiAqIFNQRFgtTGljZW5zZS1JZGVudGlmaWVyOiBBcGFjaGUtMi4wXG4gKi9cbmltcG9ydCB7IG9wZW5BcHBzLCBwaW5uZWRBcHBzLCBzZXRQaW5uZWRBcHBzIH0gZnJvbSAnLi9zdGF0ZSc7XG5pbXBvcnQgeyBnZXRUZXh0IH0gZnJvbSAnLi9pMThuJztcbmltcG9ydCB7IG9wZW5BcHAsIHNwYXduQ2xvbmVkV2luZG93LCBvcGVuRXh0ZXJuYWxBcHAsIGNsb3NlQXBwLCByZW5kZXJUYXNrYmFyIH0gZnJvbSAnLi93aW5kb3dNYW5hZ2VyJztcbmltcG9ydCB7IGRlc2t0b3AgfSBmcm9tICcuL2RvbSc7XG5pbXBvcnQgeyB1cGRhdGVBbGxUZXh0LCB1cGRhdGVTdGFydE1lbnVQaW5zLCBzaG93VG9hc3QgfSBmcm9tICcuL3VpJztcbmltcG9ydCB7IHNldHVwSWNvbkludGVyYWN0aW9uLCBwbGFjZUljb25Jbk5leHRTbG90IH0gZnJvbSAnLi9pY29uTWFuYWdlcic7XG5pbXBvcnQgeyBQSU5ORURfQVBQU19TVE9SQUdFX0tFWSB9IGZyb20gJy4vY29uc3RhbnRzJztcbmltcG9ydCB7IENPTkZJRyB9IGZyb20gJy4vZ2VtaW5pU3R1ZGlvL2NvbW1vbic7IC8vIFVzZSBzaGFyZWQgY29uZmlnXG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIC0tLSBVU0VSIENPTkZJR1VSQVRJT04gLS0tXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBXZSBub3cgdXNlIENPTkZJRyBmcm9tIGdlbWluaVN0dWRpby9jb21tb24udHMgdG8gc2hhcmUgdGhlIHRva2VuIGFuZCB1c2VyIGRldGFpbHNcbmNvbnN0IEdJVEhVQl9CUkFOQ0ggPSAnbWFpbic7IFxuY29uc3QgQVBQU19QQVRIID0gJ2FwcHMnOyBcblxuaW50ZXJmYWNlIEFwcERhdGEge1xuICAgIGlkOiBzdHJpbmc7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIGljb246IHN0cmluZztcbiAgICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICAgIGNhdGVnb3J5OiBzdHJpbmc7XG4gICAgdmVyc2lvbj86IHN0cmluZzsgLy8gQWRkIG9wdGlvbmFsIHZlcnNpb24gZmllbGRcbiAgICBpc0V4dGVybmFsPzogYm9vbGVhbjtcbiAgICBmb2xkZXJOYW1lPzogc3RyaW5nO1xuICAgIGdpdGh1YlVzZXI/OiBzdHJpbmc7XG4gICAgZ2l0aHViUmVwbz86IHN0cmluZztcbiAgICBnaXRodWJCcmFuY2g/OiBzdHJpbmc7XG4gICAgYXBwc1BhdGg/OiBzdHJpbmc7XG4gICAgZmVhdHVyZWQ/OiBib29sZWFuOyAvLyBOZXcgZmllbGQgZm9yIEZlYXR1cmVkIEFwcHNcbiAgICBjYXBhYmlsaXRpZXM/OiBzdHJpbmdbXTsgLy8gQWRkZWQgY2FwYWJpbGl0aWVzXG4gICAgZG93bmxvYWRDb3VudD86IG51bWJlcjsgLy8gVHJhY2sgZG93bmxvYWRzXG59XG5cbi8vIFBsYWNlaG9sZGVyIGRhdGEgZm9yIGFwcHMgdGhhdCBjb3VsZCBiZSBpbiB0aGUgc3RvcmVcbmNvbnN0IHBsYWNlaG9sZGVyQXBwczogQXBwRGF0YVtdID0gW107XG5cbi8vIC0tLSBTdGF0cyBIZWxwZXJzIC0tLVxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hEb3dubG9hZFN0YXRzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgbnVtYmVyPj4ge1xuICAgIGNvbnN0IHVzZXIgPSBDT05GSUcuR0lUSFVCX1VTRVI7XG4gICAgY29uc3QgcmVwbyA9IENPTkZJRy5HSVRIVUJfUkVQTztcbiAgICBpZiAoIXVzZXIgfHwgIXJlcG8pIHJldHVybiB7fTtcblxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYGh0dHBzOi8vYXBpLmdpdGh1Yi5jb20vcmVwb3MvJHt1c2VyfS8ke3JlcG99L2NvbnRlbnRzL2FwcHMvc3RhdHMuanNvbmAsIHtcbiAgICAgICAgICAgIGhlYWRlcnM6IHsgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi92bmQuZ2l0aHViLnYzLnJhdycgfSxcbiAgICAgICAgICAgIGNhY2hlOiAnbm8tc3RvcmUnXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAocmVzcG9uc2Uub2spIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcIkZhaWxlZCB0byBmZXRjaCBkb3dubG9hZCBzdGF0c1wiLCBlKTtcbiAgICB9XG4gICAgcmV0dXJuIHt9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB1cGRhdGVEb3dubG9hZFN0YXRzKGFwcElkOiBzdHJpbmcpIHtcbiAgICBjb25zdCB1c2VyID0gQ09ORklHLkdJVEhVQl9VU0VSO1xuICAgIGNvbnN0IHJlcG8gPSBDT05GSUcuR0lUSFVCX1JFUE87XG4gICAgY29uc3QgdG9rZW4gPSBDT05GSUcuR0lUSFVCX1RPS0VOO1xuICAgIFxuICAgIGlmICghdXNlciB8fCAhcmVwbyB8fCAhdG9rZW4pIHJldHVybjtcblxuICAgIHRyeSB7XG4gICAgICAgIC8vIDEuIEdldCBjdXJyZW50IHN0YXRzIGFuZCBTSEFcbiAgICAgICAgbGV0IHN0YXRzOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge307XG4gICAgICAgIGxldCBzaGEgPSBcIlwiO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgZ2V0UmVzID0gYXdhaXQgZmV0Y2goYGh0dHBzOi8vYXBpLmdpdGh1Yi5jb20vcmVwb3MvJHt1c2VyfS8ke3JlcG99L2NvbnRlbnRzL2FwcHMvc3RhdHMuanNvbmAsIHtcbiAgICAgICAgICAgIGhlYWRlcnM6IHsgXG4gICAgICAgICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgdG9rZW4gJHt0b2tlbn1gLFxuICAgICAgICAgICAgICAgICdBY2NlcHQnOiAnYXBwbGljYXRpb24vdm5kLmdpdGh1Yi52Mytqc29uJyBcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBjYWNoZTogJ25vLXN0b3JlJ1xuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoZ2V0UmVzLm9rKSB7XG4gICAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgZ2V0UmVzLmpzb24oKTtcbiAgICAgICAgICAgIHNoYSA9IGRhdGEuc2hhO1xuICAgICAgICAgICAgc3RhdHMgPSBKU09OLnBhcnNlKGF0b2IoZGF0YS5jb250ZW50KSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyAyLiBJbmNyZW1lbnRcbiAgICAgICAgc3RhdHNbYXBwSWRdID0gKHN0YXRzW2FwcElkXSB8fCAwKSArIDE7XG5cbiAgICAgICAgLy8gMy4gV3JpdGUgYmFja1xuICAgICAgICBhd2FpdCBmZXRjaChgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy8ke3VzZXJ9LyR7cmVwb30vY29udGVudHMvYXBwcy9zdGF0cy5qc29uYCwge1xuICAgICAgICAgICAgbWV0aG9kOiAnUFVUJyxcbiAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICAnQXV0aG9yaXphdGlvbic6IGB0b2tlbiAke3Rva2VufWAsXG4gICAgICAgICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgbWVzc2FnZTogYFVwZGF0ZSBzdGF0cyBmb3IgJHthcHBJZH1gLFxuICAgICAgICAgICAgICAgIGNvbnRlbnQ6IGJ0b2EoSlNPTi5zdHJpbmdpZnkoc3RhdHMsIG51bGwsIDIpKSxcbiAgICAgICAgICAgICAgICBzaGE6IHNoYSB8fCB1bmRlZmluZWRcbiAgICAgICAgICAgIH0pXG4gICAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIkZhaWxlZCB0byB1cGRhdGUgZG93bmxvYWQgc3RhdHNcIiwgZSk7XG4gICAgfVxufVxuXG5jb25zdCBzdXNBcHA6IEFwcERhdGEgPSB7XG4gICAgaWQ6ICdzdXNBcHAnLFxuICAgIG5hbWU6IGdldFRleHQoJ2FwcF9zdXNBcHBfbmFtZScpLFxuICAgIGljb246ICdodHRwczovL2ltZy5pY29uczguY29tL2ZsdWVuY3kvOTYvdmlydXMucG5nJyxcbiAgICBkZXNjcmlwdGlvbjogZ2V0VGV4dCgnYXBwX3N1c0FwcF9kZXNjJyksXG4gICAgY2F0ZWdvcnk6ICdhbGwnLCAvLyBTcGVjaWFsIGNhdGVnb3J5IHRvIG9ubHkgc2hvdyBpbiBhbGwgYXBwc1xuICAgIHZlcnNpb246ICd2MSdcbn07XG5cblxuLy8gLS0tIENvbXBvbmVudC1sZXZlbCBzdGF0ZSAtLS1cbi8vIExvYWQgaW5zdGFsbGVkIGFwcHMgZnJvbSBsb2NhbFN0b3JhZ2UgdG8gcGVyc2lzdCBzdGF0ZVxuY29uc3QgbG9hZEluc3RhbGxlZEFwcHMgPSAoKTogTWFwPHN0cmluZywgc3RyaW5nPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc3RvcmVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2dlbWluaV9pbnN0YWxsZWRfYXBwcycpO1xuICAgICAgICBpZiAoc3RvcmVkKSB7XG4gICAgICAgICAgICByZXR1cm4gbmV3IE1hcChKU09OLnBhcnNlKHN0b3JlZCkpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiRmFpbGVkIHRvIGxvYWQgaW5zdGFsbGVkIGFwcHM6XCIsIGUpO1xuICAgIH1cbiAgICByZXR1cm4gbmV3IE1hcCgpO1xufTtcblxuY29uc3Qgc2F2ZUluc3RhbGxlZEFwcHMgPSAoKSA9PiB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2dlbWluaV9pbnN0YWxsZWRfYXBwcycsIEpTT04uc3RyaW5naWZ5KEFycmF5LmZyb20oc3RvcmVTdGF0ZS5pbnN0YWxsZWRBcHBzLmVudHJpZXMoKSkpKTtcbn07XG5cbmxldCBzdG9yZVN0YXRlID0ge1xuICAgIHVudHJ1c3RlZEVuYWJsZWQ6IGZhbHNlLFxuICAgIGluc3RhbGxlZEFwcHM6IGxvYWRJbnN0YWxsZWRBcHBzKCksIC8vIElEIC0+IFZlcnNpb24gTWFwXG4gICAgZXh0ZXJuYWxBcHBzOiBbXSBhcyBBcHBEYXRhW10sXG4gICAgaGFzRmV0Y2hlZDogZmFsc2Vcbn07XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNhdGVnb3J5KHJhd0NhdGVnb3J5OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICghcmF3Q2F0ZWdvcnkpIHJldHVybiAnVXRpbGl0aWVzJztcbiAgICBjb25zdCBjYXQgPSByYXdDYXRlZ29yeS50b0xvd2VyQ2FzZSgpLnRyaW0oKTtcblxuICAgIGlmIChbJ2dhbWUnLCAnZ2FtZXMnLCAnYXJjYWRlJywgJ3B1enpsZScsICdhY3Rpb24nLCAncnBnJywgJ3NpbXVsYXRpb24nXS5pbmNsdWRlcyhjYXQpKSByZXR1cm4gJ0dhbWVzJztcbiAgICBpZiAoWyd1dGlsaXR5JywgJ3V0aWxpdGllcycsICd0b29sJywgJ3Rvb2xzJywgJ3N5c3RlbScsICdzeXMnXS5pbmNsdWRlcyhjYXQpKSByZXR1cm4gJ1V0aWxpdGllcyc7XG4gICAgaWYgKFsncHJvZHVjdGl2aXR5JywgJ29mZmljZScsICd3b3JrJywgJ3dyaXRpbmcnLCAnbm90ZScsICdmaW5hbmNlJ10uaW5jbHVkZXMoY2F0KSkgcmV0dXJuICdQcm9kdWN0aXZpdHknO1xuICAgIGlmIChbJ2VudGVydGFpbm1lbnQnLCAnbWVkaWEnLCAnbXVzaWMnLCAndmlkZW8nLCAnZnVuJywgJ2FydCcsICdzb2NpYWwnXS5pbmNsdWRlcyhjYXQpKSByZXR1cm4gJ0VudGVydGFpbm1lbnQnO1xuICAgIGlmIChbJ2VkdWNhdGlvbicsICdsZWFybmluZycsICdyZWZlcmVuY2UnLCAnc2NpZW5jZScsICdtYXRoJ10uaW5jbHVkZXMoY2F0KSkgcmV0dXJuICdFZHVjYXRpb24nO1xuICAgIFxuICAgIC8vIERlZmF1bHQgZmFsbGJhY2sgbWFwcGluZyBvciByZXR1cm4gY2FwaXRhbGl6ZWQgb3JpZ2luYWwgaWYgaXQgZG9lc24ndCBtYXRjaCBzdGFuZGFyZCBidWNrZXRzXG4gICAgcmV0dXJuIHJhd0NhdGVnb3J5LmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgcmF3Q2F0ZWdvcnkuc2xpY2UoMSk7XG59XG5cbi8vIC0tLSBFeHRlcm5hbCBBcHAgRmV0Y2hpbmcgTG9naWMgLS0tXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hFeHRlcm5hbEFwcHMoKTogUHJvbWlzZTxBcHBEYXRhW10+IHtcbiAgICBpZiAoc3RvcmVTdGF0ZS5oYXNGZXRjaGVkKSByZXR1cm4gc3RvcmVTdGF0ZS5leHRlcm5hbEFwcHM7XG4gICAgLy8gVXNlIGN1cnJlbnQgQ09ORklHIHN0YXRlXG4gICAgY29uc3QgdXNlciA9IENPTkZJRy5HSVRIVUJfVVNFUjtcbiAgICBjb25zdCByZXBvID0gQ09ORklHLkdJVEhVQl9SRVBPO1xuXG4gICAgaWYgKCF1c2VyIHx8ICFyZXBvKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcIkFwcFN0b3JlOiBHSVRIVUJfVVNFUiBvciBHSVRIVUJfUkVQTyBpcyBub3Qgc2V0LlwiKTtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGhlYWRlcnM6IEhlYWRlcnNJbml0ID0ge1xuICAgICAgICAgICAgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi92bmQuZ2l0aHViLnYzK2pzb24nXG4gICAgICAgIH07XG4gICAgICAgIGlmIChDT05GSUcuR0lUSFVCX1RPS0VOICYmIENPTkZJRy5HSVRIVUJfVE9LRU4udHJpbSgpICE9PSAnJykge1xuICAgICAgICAgICAgaGVhZGVyc1snQXV0aG9yaXphdGlvbiddID0gYHRva2VuICR7Q09ORklHLkdJVEhVQl9UT0tFTn1gO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc29sZS5sb2coYEFwcFN0b3JlOiBGZXRjaGluZyBhcHBzIGZyb20gaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy8ke3VzZXJ9LyR7cmVwb30vY29udGVudHMvJHtBUFBTX1BBVEh9IC4uLmApO1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zLyR7dXNlcn0vJHtyZXBvfS9jb250ZW50cy8ke0FQUFNfUEFUSH1gLCB7IFxuICAgICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICAgIGNhY2hlOiAnbm8tc3RvcmUnIFxuICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgICAgICAgIGNvbnN0IGVycm9yQm9keSA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICAgICAgICAgIGNvbnNvbGUud2FybihgQXBwU3RvcmU6IEdpdEh1YiBBUEkgcmV0dXJuZWQgJHtyZXNwb25zZS5zdGF0dXN9IGZvciAke0FQUFNfUEFUSH0uIEJvZHk6ICR7ZXJyb3JCb2R5fWApO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDMgJiYgZXJyb3JCb2R5LmluY2x1ZGVzKFwicmF0ZSBsaW1pdFwiKSkge1xuICAgICAgICAgICAgICAgICBzaG93VG9hc3QoXCJHaXRIdWIgUmF0ZSBMaW1pdCBFeGNlZWRlZC4gUGxlYXNlIGFkZCBhIFRva2VuIGluIFNldHRpbmdzID4gU3lzdGVtLlwiLCBcImVycm9yXCIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDQpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhcIkFwcHMgZGlyZWN0b3J5IG5vdCBmb3VuZCBpbiByZXBvIHlldC5cIik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBjb25zdCBmaWxlcyA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbiAgICAgICAgY29uc29sZS5sb2coYEFwcFN0b3JlOiBGb3VuZCAke2ZpbGVzLmxlbmd0aH0gaXRlbXMgaW4gJHtBUFBTX1BBVEh9YCk7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShmaWxlcykpIHJldHVybiBbXTtcblxuICAgICAgICBjb25zdCBmb2xkZXJzID0gZmlsZXMuZmlsdGVyKChmOiBhbnkpID0+IGYudHlwZSA9PT0gJ2RpcicpO1xuICAgICAgICBjb25zb2xlLmxvZyhgQXBwU3RvcmU6IEZvdW5kICR7Zm9sZGVycy5sZW5ndGh9IGFwcCBmb2xkZXJzYCk7XG4gICAgICAgIFxuICAgICAgICAvLyBGZXRjaCBzdGF0c1xuICAgICAgICBjb25zdCBzdGF0cyA9IGF3YWl0IGZldGNoRG93bmxvYWRTdGF0cygpO1xuXG4gICAgICAgIC8vIFBhcmFsbGVsaXplIGZldGNoaW5nIG9mIG1hbmlmZXN0c1xuICAgICAgICBjb25zdCBwcm9taXNlcyA9IGZvbGRlcnMubWFwKGFzeW5jIChmb2xkZXI6IGFueSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgbWFuaWZlc3RBcGlVcmwgPSBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy8ke3VzZXJ9LyR7cmVwb30vY29udGVudHMvJHtBUFBTX1BBVEh9LyR7Zm9sZGVyLm5hbWV9L21hbmlmZXN0Lmpzb25gO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGhlYWRlcnM6IEhlYWRlcnNJbml0ID0ge1xuICAgICAgICAgICAgICAgICAgICAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL3ZuZC5naXRodWIudjMucmF3J1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgaWYgKENPTkZJRy5HSVRIVUJfVE9LRU4gJiYgQ09ORklHLkdJVEhVQl9UT0tFTi50cmltKCkgIT09ICcnKSB7XG4gICAgICAgICAgICAgICAgICAgIGhlYWRlcnNbJ0F1dGhvcml6YXRpb24nXSA9IGB0b2tlbiAke0NPTkZJRy5HSVRIVUJfVE9LRU59YDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBtYW5pZmVzdFJlcyA9IGF3YWl0IGZldGNoKG1hbmlmZXN0QXBpVXJsLCB7XG4gICAgICAgICAgICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgICAgICAgICAgIGNhY2hlOiAnbm8tc3RvcmUnXG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBpZiAobWFuaWZlc3RSZXMub2spIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFuaWZlc3RUZXh0ID0gYXdhaXQgbWFuaWZlc3RSZXMudGV4dCgpO1xuICAgICAgICAgICAgICAgICAgICBsZXQgbWFuaWZlc3Q7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtYW5pZmVzdCA9IEpTT04ucGFyc2UobWFuaWZlc3RUZXh0KTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgQXBwU3RvcmU6IEZhaWxlZCB0byBwYXJzZSBtYW5pZmVzdCBmb3IgJHtmb2xkZXIubmFtZX0uIENvbnRlbnQ6YCwgbWFuaWZlc3RUZXh0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgaWNvblVybCA9IG1hbmlmZXN0Lmljb24gfHwgQ09ORklHLkRFRkFVTFRfSUNPTjtcbiAgICAgICAgICAgICAgICAgICAgLy8gRm9yIHRoZSBpY29uLCB1c2UgZG93bmxvYWRfdXJsIGlmIHBvc3NpYmxlLCBvdGhlcndpc2UgY29uc3RydWN0IHJhd1xuICAgICAgICAgICAgICAgICAgICBpZiAoaWNvblVybCAmJiAhaWNvblVybC5zdGFydHNXaXRoKCdodHRwJykgJiYgIWljb25Vcmwuc3RhcnRzV2l0aCgnZGF0YTonKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gQXR0ZW1wdCB0byB1c2UgYSBjYWNoZS1idXN0ZWQgcmF3IFVSTCBhcyBiYXNpYyBmYWxsYmFja1xuICAgICAgICAgICAgICAgICAgICAgICAgaWNvblVybCA9IGBodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vJHt1c2VyfS8ke3JlcG99LyR7R0lUSFVCX0JSQU5DSH0vJHtBUFBTX1BBVEh9LyR7Zm9sZGVyLm5hbWV9LyR7aWNvblVybH0/dD0ke0RhdGUubm93KCl9YDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYXBwSWQgPSBtYW5pZmVzdC5pZCB8fCBmb2xkZXIubmFtZTtcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgLi4ubWFuaWZlc3QsXG4gICAgICAgICAgICAgICAgICAgICAgICBpY29uOiBpY29uVXJsLFxuICAgICAgICAgICAgICAgICAgICAgICAgY2F0ZWdvcnk6IG5vcm1hbGl6ZUNhdGVnb3J5KG1hbmlmZXN0LmNhdGVnb3J5KSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGlzRXh0ZXJuYWw6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmb2xkZXJOYW1lOiBmb2xkZXIubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGlkOiBhcHBJZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGdpdGh1YlVzZXI6IHVzZXIsXG4gICAgICAgICAgICAgICAgICAgICAgICBnaXRodWJSZXBvOiByZXBvLFxuICAgICAgICAgICAgICAgICAgICAgICAgZ2l0aHViQnJhbmNoOiBHSVRIVUJfQlJBTkNILFxuICAgICAgICAgICAgICAgICAgICAgICAgYXBwc1BhdGg6IEFQUFNfUEFUSCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZlYXR1cmVkOiAhIW1hbmlmZXN0LmZlYXR1cmVkLCAvLyBDYXB0dXJlIGZlYXR1cmVkIHN0YXR1c1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FwYWJpbGl0aWVzOiBtYW5pZmVzdC5jYXBhYmlsaXRpZXMgfHwgW10sIC8vIENhcHR1cmUgY2FwYWJpbGl0aWVzXG4gICAgICAgICAgICAgICAgICAgICAgICBkb3dubG9hZENvdW50OiBzdGF0c1thcHBJZF0gfHwgMFxuICAgICAgICAgICAgICAgICAgICB9IGFzIEFwcERhdGE7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS53YXJuKGBGYWlsZWQgdG8gbG9hZCBtYW5pZmVzdCBmcm9tICR7Zm9sZGVyLm5hbWV9YCwgZXJyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwocHJvbWlzZXMpO1xuICAgICAgICBjb25zdCBhcHBzID0gcmVzdWx0cy5maWx0ZXIoKGFwcCk6IGFwcCBpcyBBcHBEYXRhID0+IGFwcCAhPT0gbnVsbCk7XG5cbiAgICAgICAgc3RvcmVTdGF0ZS5leHRlcm5hbEFwcHMgPSBhcHBzO1xuICAgICAgICBzdG9yZVN0YXRlLmhhc0ZldGNoZWQgPSB0cnVlO1xuICAgICAgICByZXR1cm4gYXBwcztcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLndhcm4oXCJGYWlsZWQgdG8gY29ubmVjdCB0byBHaXRIdWIgU3RvcmU6XCIsIGVycm9yKTtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbn1cblxuXG5mdW5jdGlvbiBsYXVuY2hNb2JpbGVWaXJ1cygpIHtcbiAgICBjb25zdCBhcHBTdG9yZVdpbmRvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBTdG9yZScpO1xuICAgIGlmICghYXBwU3RvcmVXaW5kb3cpIHJldHVybjtcblxuICAgIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBvdmVybGF5LmNsYXNzTmFtZSA9ICdtb2JpbGUtdmlydXMtb3ZlcmxheSc7XG5cbiAgICBjb25zdCBpY29uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW1nJyk7XG4gICAgaWNvbi5zcmMgPSBzdXNBcHAuaWNvbjtcbiAgICBpY29uLmNsYXNzTmFtZSA9ICdtb2JpbGUtdmlydXMtaWNvbic7XG5cbiAgICBjb25zdCB0ZXh0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncCcpO1xuICAgIHRleHQuY2xhc3NOYW1lID0gJ21vYmlsZS12aXJ1cy10ZXh0JztcbiAgICB0ZXh0LnRleHRDb250ZW50ID0gJ1NZU1RFTSBDT01QUk9NSVNFRCc7XG5cbiAgICBvdmVybGF5LmFwcGVuZENoaWxkKGljb24pO1xuICAgIG92ZXJsYXkuYXBwZW5kQ2hpbGQodGV4dCk7XG4gICAgYXBwU3RvcmVXaW5kb3cuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG4gICAgYXBwU3RvcmVXaW5kb3cuY2xhc3NMaXN0LmFkZCgnbW9iaWxlLXZpcnVzLWFjdGl2ZScpO1xuXG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGlmIChvdmVybGF5LnBhcmVudE5vZGUgPT09IGFwcFN0b3JlV2luZG93KSB7XG4gICAgICAgICAgICBhcHBTdG9yZVdpbmRvdy5yZW1vdmVDaGlsZChvdmVybGF5KTtcbiAgICAgICAgfVxuICAgICAgICBhcHBTdG9yZVdpbmRvdy5jbGFzc0xpc3QucmVtb3ZlKCdtb2JpbGUtdmlydXMtYWN0aXZlJyk7XG4gICAgfSwgNDAwMCk7XG59XG5cblxuZnVuY3Rpb24gbGF1bmNoRGVza3RvcFZpcnVzKCkge1xuICAgIGxldCB2aXJ1c0NvdW50ID0gMDtcbiAgICBjb25zdCBtYXhWaXJ1c2VzID0gMTU7XG4gICAgY29uc3Qgb3JpZ2luYWxCZ0NvbG9yID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Rlc2t0b3AnKT8uc3R5bGUuYmFja2dyb3VuZENvbG9yO1xuXG4gICAgY29uc3QgdmlydXNJbnRlcnZhbCA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKHZpcnVzQ291bnQgPj0gbWF4VmlydXNlcykge1xuICAgICAgICAgICAgY2xlYXJJbnRlcnZhbCh2aXJ1c0ludGVydmFsKTtcbiAgICAgICAgICAgIGNvbnN0IGRlc2t0b3AgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZGVza3RvcCcpO1xuICAgICAgICAgICAgaWYgKGRlc2t0b3AgJiYgb3JpZ2luYWxCZ0NvbG9yKSB7XG4gICAgICAgICAgICAgICAgZGVza3RvcC5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSBvcmlnaW5hbEJnQ29sb3I7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBzcGF3bkNsb25lZFdpbmRvdygndmlydXNXaW5kb3cnLCAndGl0bGVfdmlydXNXaW5kb3cnKTtcblxuICAgICAgICBjb25zdCByYW5kb21Db2xvciA9ICcjJyArIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSoxNjc3NzIxNSkudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDYsICcwJyk7XG4gICAgICAgIGNvbnN0IGRlc2t0b3AgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZGVza3RvcCcpO1xuICAgICAgICBpZiAoZGVza3RvcCkge1xuICAgICAgICAgICAgZGVza3RvcC5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSByYW5kb21Db2xvcjtcbiAgICAgICAgfVxuXG4gICAgICAgIHZpcnVzQ291bnQrKztcbiAgICB9LCA1MDApO1xufVxuXG5mdW5jdGlvbiBsYXVuY2hWaXJ1cygpIHtcbiAgICBpZiAoZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoJ21vYmlsZS1tb2RlJykpIHtcbiAgICAgICAgbGF1bmNoTW9iaWxlVmlydXMoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBsYXVuY2hEZXNrdG9wVmlydXMoKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGVuc3VyZURvd25sb2Fkc0ZvbGRlckljb24oKSB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaWNvbltkYXRhLWFwcD1cImRvd25sb2Fkc0ZvbGRlclwiXScpO1xuICAgIGlmIChleGlzdGluZykgcmV0dXJuO1xuXG4gICAgY29uc3QgaWNvbkRpdiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGljb25EaXYuY2xhc3NOYW1lID0gJ2ljb24nO1xuICAgIGljb25EaXYuZGF0YXNldC5hcHAgPSAnZG93bmxvYWRzRm9sZGVyJztcbiAgICBpY29uRGl2LmlubmVySFRNTCA9IGBcbiAgICAgICAgPGltZyBzcmM9XCJodHRwczovL2ltZy5pY29uczguY29tL2ZsdWVuY3kvOTYvZm9sZGVyLWludm9pY2VzLnBuZ1wiIGFsdD1cIkRvd25sb2Fkc1wiIHN0eWxlPVwid2lkdGg6IDQ4cHg7IGhlaWdodDogNDhweDsgbWFyZ2luLWJvdHRvbTogOHB4O1wiIC8+XG4gICAgICAgIDxzcGFuIGRhdGEtaTE4bi1rZXk9XCJpY29uX2Rvd25sb2Fkc1wiPkRvd25sb2FkZWQgQXBwczwvc3Bhbj5cbiAgICBgO1xuICAgIGljb25EaXYuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBvcGVuQXBwKCdkb3dubG9hZHNGb2xkZXInKSk7XG4gICAgXG4gICAgZGVza3RvcD8uYXBwZW5kQ2hpbGQoaWNvbkRpdik7XG4gICAgcGxhY2VJY29uSW5OZXh0U2xvdChpY29uRGl2KTtcbiAgICBzZXR1cEljb25JbnRlcmFjdGlvbihpY29uRGl2KTtcbiAgICB1cGRhdGVBbGxUZXh0KCk7XG59XG5cbmZ1bmN0aW9uIGFkZEFwcFRvRG93bmxvYWRzRm9sZGVyKGFwcDogQXBwRGF0YSkge1xuICAgIGVuc3VyZURvd25sb2Fkc0ZvbGRlckljb24oKTtcbiAgICBcbiAgICBjb25zdCBmb2xkZXJDb250ZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Rvd25sb2Fkcy1jb250ZW50Jyk7XG4gICAgaWYgKCFmb2xkZXJDb250ZW50KSByZXR1cm47XG4gICAgXG4gICAgY29uc3Qgc2FmZUlkID0gYXBwLmlzRXh0ZXJuYWwgPyBgZXh0LSR7YXBwLmlkfWAgOiBhcHAuaWQ7XG4gICAgXG4gICAgLy8gUmVmcmVzaCBJY29uIExvZ2ljOiBSZW1vdmUgZXhpc3Rpbmcgb25lIHRvIHVwZGF0ZSBsaXN0ZW5lcnMvZGF0YVxuICAgIGNvbnN0IGV4aXN0aW5nSWNvbiA9IGZvbGRlckNvbnRlbnQucXVlcnlTZWxlY3RvcihgLndpbmRvdy1pY29uW2RhdGEtYXBwPVwiJHtzYWZlSWR9XCJdYCk7XG4gICAgaWYgKGV4aXN0aW5nSWNvbikge1xuICAgICAgICBleGlzdGluZ0ljb24ucmVtb3ZlKCk7XG4gICAgfVxuXG4gICAgY29uc3QgaWNvbkRpdiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGljb25EaXYuY2xhc3NOYW1lID0gJ3dpbmRvdy1pY29uJztcbiAgICBpY29uRGl2LmRhdGFzZXQuYXBwID0gc2FmZUlkO1xuICAgIFxuICAgIGNvbnN0IGltZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2ltZycpO1xuICAgIGltZy5zcmMgPSBhcHAuaWNvbjtcbiAgICBpbWcuc3R5bGUud2lkdGggPSAnMzJweCc7XG4gICAgaW1nLnN0eWxlLmhlaWdodCA9ICczMnB4JztcbiAgICBpbWcuc3R5bGUubWFyZ2luQm90dG9tID0gJzVweCc7XG4gICAgXG4gICAgY29uc3Qgc3BhbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcbiAgICBzcGFuLnRleHRDb250ZW50ID0gYXBwLm5hbWU7XG4gICAgXG4gICAgaWNvbkRpdi5hcHBlbmRDaGlsZChpbWcpO1xuICAgIGljb25EaXYuYXBwZW5kQ2hpbGQoc3Bhbik7XG4gICAgXG4gICAgaWNvbkRpdi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgaWYgKGFwcC5pc0V4dGVybmFsKSB7XG4gICAgICAgICAgICBvcGVuRXh0ZXJuYWxBcHAoe1xuICAgICAgICAgICAgICAgIC4uLmFwcCxcbiAgICAgICAgICAgICAgICBnaXRodWJVc2VyOiBhcHAuZ2l0aHViVXNlciB8fCBDT05GSUcuR0lUSFVCX1VTRVIsXG4gICAgICAgICAgICAgICAgZ2l0aHViUmVwbzogYXBwLmdpdGh1YlJlcG8gfHwgQ09ORklHLkdJVEhVQl9SRVBPLFxuICAgICAgICAgICAgICAgIGdpdGh1YkJyYW5jaDogYXBwLmdpdGh1YkJyYW5jaCB8fCBHSVRIVUJfQlJBTkNILFxuICAgICAgICAgICAgICAgIGFwcHNQYXRoOiBhcHAuYXBwc1BhdGggfHwgQVBQU19QQVRIXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChhcHAuaWQgPT09ICdzdXNBcHAnKSB7XG4gICAgICAgICAgICBsYXVuY2hWaXJ1cygpO1xuICAgICAgICB9IGVsc2UgaWYgKGFwcC5pZCA9PT0gJ2Rvb20nKSB7XG4gICAgICAgICAgICBvcGVuQXBwKCdkb29tJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzaG93VG9hc3QoZ2V0VGV4dCgnYWxlcnRfZmFrZV9hcHBfb3BlbicsIHsgYXBwTmFtZTogYXBwLm5hbWUgfSksICd3YXJuaW5nJyk7XG4gICAgICAgIH1cbiAgICB9KTtcbiAgICBcbiAgICBmb2xkZXJDb250ZW50LmFwcGVuZENoaWxkKGljb25EaXYpO1xuICAgIHNldHVwSWNvbkludGVyYWN0aW9uKGljb25EaXYpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBkb3dubG9hZEFwcChhcHA6IEFwcERhdGEsIGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIHJlZnJlc2hMaXN0OiAoKSA9PiB2b2lkKSB7XG4gICAgY29uc3QgaXNVcGRhdGUgPSBzdG9yZVN0YXRlLmluc3RhbGxlZEFwcHMuaGFzKGFwcC5pZCk7XG4gICAgY29uc3Qgc2FmZUlkID0gYXBwLmlzRXh0ZXJuYWwgPyBgZXh0LSR7YXBwLmlkfWAgOiBhcHAuaWQ7XG5cbiAgICAvLyBGb3JjZSBDbG9zZSBSdW5uaW5nIEFwcCBpZiBVcGRhdGluZyB0byBwcmV2ZW50IHN0YWxlIGNhY2hlIGluIG1lbW9yeS9ET01cbiAgICBpZiAoaXNVcGRhdGUgJiYgb3BlbkFwcHMuaGFzKHNhZmVJZCkpIHtcbiAgICAgICAgY2xvc2VBcHAoc2FmZUlkKTtcbiAgICB9XG5cbiAgICBidXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdkb3dubG9hZGluZycpO1xuICAgIFxuICAgIGNvbnN0IHVwZGF0ZVByb2dyZXNzID0gKHBjdDogbnVtYmVyKSA9PiB7XG4gICAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGAke01hdGguZmxvb3IocGN0KX0lYDtcbiAgICAgICAgYnV0dG9uLnN0eWxlLnNldFByb3BlcnR5KCctLXByb2dyZXNzJywgYCR7cGN0fSVgKTtcbiAgICB9O1xuXG4gICAgdXBkYXRlUHJvZ3Jlc3MoMCk7XG5cbiAgICAvLyBUcmFjayBkb3dubG9hZCBzdGF0c1xuICAgIGlmIChhcHAuaXNFeHRlcm5hbCkge1xuICAgICAgICB1cGRhdGVEb3dubG9hZFN0YXRzKGFwcC5pZCk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgICAgbGV0IGRvd25sb2FkZWRDb250ZW50ID0gXCJcIjtcblxuICAgICAgICBpZiAoYXBwLmlzRXh0ZXJuYWwpIHtcbiAgICAgICAgICAgIGNvbnN0IHVzZXIgPSBhcHAuZ2l0aHViVXNlciB8fCBDT05GSUcuR0lUSFVCX1VTRVI7XG4gICAgICAgICAgICBjb25zdCByZXBvID0gYXBwLmdpdGh1YlJlcG8gfHwgQ09ORklHLkdJVEhVQl9SRVBPO1xuICAgICAgICAgICAgLy8gY29uc3QgYnJhbmNoID0gYXBwLmdpdGh1YkJyYW5jaCB8fCBHSVRIVUJfQlJBTkNIOyBcbiAgICAgICAgICAgIGNvbnN0IHBhdGggPSBhcHAuYXBwc1BhdGggfHwgQVBQU19QQVRIO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBGSVhFRDogQWRkZWQgL2NvbnRlbnRzLyB0byBlbnN1cmUgY29ycmVjdCBHaXRIdWIgQVBJIGVuZHBvaW50XG4gICAgICAgICAgICBjb25zdCBhcGlVcmwgPSBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy8ke3VzZXJ9LyR7cmVwb30vY29udGVudHMvJHtwYXRofS8ke2FwcC5mb2xkZXJOYW1lfS9pbmRleC5odG1sYDtcblxuICAgICAgICAgICAgbGV0IHZpc3VhbFByb2dyZXNzID0gMDtcbiAgICAgICAgICAgIGNvbnN0IHByb2dyZXNzSW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgdmlzdWFsUHJvZ3Jlc3MgKz0gKDkwIC0gdmlzdWFsUHJvZ3Jlc3MpICogMC4xO1xuICAgICAgICAgICAgICAgIHVwZGF0ZVByb2dyZXNzKHZpc3VhbFByb2dyZXNzKTtcbiAgICAgICAgICAgIH0sIDIwMCk7XG5cbiAgICAgICAgICAgIC8vIEZldGNoaW5nIGZvciByZWFsIGRvd25sb2FkXG4gICAgICAgICAgICBjb25zdCBoZWFkZXJzOiBIZWFkZXJzSW5pdCA9IHtcbiAgICAgICAgICAgICAgICAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL3ZuZC5naXRodWIudjMucmF3J1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGlmIChDT05GSUcuR0lUSFVCX1RPS0VOICYmIENPTkZJRy5HSVRIVUJfVE9LRU4udHJpbSgpICE9PSAnJykge1xuICAgICAgICAgICAgICAgIGhlYWRlcnNbJ0F1dGhvcml6YXRpb24nXSA9IGB0b2tlbiAke0NPTkZJRy5HSVRIVUJfVE9LRU59YDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChhcGlVcmwsIHsgXG4gICAgICAgICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICAgICAgICBjYWNoZTogJ25vLXN0b3JlJyBcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjbGVhckludGVydmFsKHByb2dyZXNzSW50ZXJ2YWwpO1xuXG4gICAgICAgICAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBTZXJ2ZXIgcmV0dXJuZWQgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIENvbnN1bWUgYm9keSB0byBzaW11bGF0ZSBkb3dubG9hZCBhbmQgQ0FQVFVSRSBjb250ZW50XG4gICAgICAgICAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5Py5nZXRSZWFkZXIoKTtcbiAgICAgICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoXCJ1dGYtOFwiKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHJlYWRlcikge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnRMZW5ndGggPSArKHJlc3BvbnNlLmhlYWRlcnMuZ2V0KCdDb250ZW50LUxlbmd0aCcpIHx8IDApO1xuICAgICAgICAgICAgICAgIGxldCByZWNlaXZlZCA9IDA7XG4gICAgICAgICAgICAgICAgd2hpbGUodHJ1ZSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCB7ZG9uZSwgdmFsdWV9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGRvbmUpIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgLy8gQWNjdW11bGF0ZSBjaHVua1xuICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvd25sb2FkZWRDb250ZW50ICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7c3RyZWFtOiB0cnVlfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNlaXZlZCArPSB2YWx1ZS5sZW5ndGg7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoY29udGVudExlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlYWxQY3QgPSAocmVjZWl2ZWQgLyBjb250ZW50TGVuZ3RoKSAqIDEwMDtcbiAgICAgICAgICAgICAgICAgICAgICAgIHVwZGF0ZVByb2dyZXNzKE1hdGgubWF4KHZpc3VhbFByb2dyZXNzLCByZWFsUGN0KSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgLy8gRmx1c2ggZGVjb2RlclxuICAgICAgICAgICAgICAgIGRvd25sb2FkZWRDb250ZW50ICs9IGRlY29kZXIuZGVjb2RlKCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGRvd25sb2FkZWRDb250ZW50ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBTYXZlIHRvIFBlcnNpc3RlbnQgU3RvcmFnZVxuICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oYGdlbWluaV9hcHBfY29udGVudF8ke2FwcC5pZH1gLCBkb3dubG9hZGVkQ29udGVudCk7XG5cbiAgICAgICAgICAgIC8vIC0tLSBBdHRlbXB0IHRvIGZldGNoIHdpZGdldC5odG1sIC0tLVxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCB3aWRnZXRBcGlVcmwgPSBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy8ke3VzZXJ9LyR7cmVwb30vY29udGVudHMvJHtwYXRofS8ke2FwcC5mb2xkZXJOYW1lfS93aWRnZXQuaHRtbGA7XG4gICAgICAgICAgICAgICAgY29uc3Qgd2lkZ2V0UmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh3aWRnZXRBcGlVcmwsIHsgaGVhZGVycywgY2FjaGU6ICduby1zdG9yZScgfSk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHdpZGdldFJlc3BvbnNlLm9rKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIEl0IGV4aXN0cyEgRG93bmxvYWQgaXQuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHdpZGdldENvbnRlbnQgPSBhd2FpdCB3aWRnZXRSZXNwb25zZS50ZXh0KCk7IC8vIEFzc3VtaW5nIHNtYWxsIGZpbGUsIHRleHQoKSBpcyBmaW5lXG4gICAgICAgICAgICAgICAgICAgIC8vIE9yIHVzZSB0aGUgc2FtZSByZWFkZXIgbG9naWMgaWYgbmVlZGVkLCBidXQgd2lkZ2V0cyBhcmUgdXN1YWxseSBzbWFsbFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgLy8gQnV0IHdhaXQsIHRoZSBBUEkgcmV0dXJucyBKU09OIHdpdGggYmFzZTY0IGNvbnRlbnQgaWYgaXQncyBzbWFsbCwgb3IgZG93bmxvYWRfdXJsIGlmIGxhcmdlP1xuICAgICAgICAgICAgICAgICAgICAvLyBObywgd2UgdXNlZCAnYXBwbGljYXRpb24vdm5kLmdpdGh1Yi52My5yYXcnIGhlYWRlciwgc28gaXQgc2hvdWxkIGJlIHJhdyBjb250ZW50LlxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oYGdlbWluaV9hcHBfd2lkZ2V0XyR7YXBwLmlkfWAsIHdpZGdldENvbnRlbnQpO1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgQXBwU3RvcmU6IERvd25sb2FkZWQgY3VzdG9tIHdpZGdldCBmb3IgJHthcHAubmFtZX1gKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBObyB3aWRnZXQuaHRtbCBmb3VuZCwgY2xlYXIgYW55IG9sZCBvbmUganVzdCBpbiBjYXNlXG4gICAgICAgICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKGBnZW1pbmlfYXBwX3dpZGdldF8ke2FwcC5pZH1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoICh3RXJyKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS53YXJuKFwiQXBwU3RvcmU6IEZhaWxlZCB0byBjaGVjayBmb3Igd2lkZ2V0Lmh0bWxcIiwgd0Vycik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgICAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoMTAwKTtcbiAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCAyMDApKTtcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gSW50ZXJuYWwgQXBwcyAoRmFrZSBkb3dubG9hZClcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IDEwMDsgaSArPSAxMCkge1xuICAgICAgICAgICAgICAgIHVwZGF0ZVByb2dyZXNzKGkpO1xuICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgc3RvcmVTdGF0ZS5pbnN0YWxsZWRBcHBzLnNldChhcHAuaWQsIGFwcC52ZXJzaW9uIHx8ICd2MScpO1xuICAgICAgICBzYXZlSW5zdGFsbGVkQXBwcygpOyAvLyBQZXJzaXN0IGluc3RhbGxlZCBzdGF0ZVxuICAgICAgICBcbiAgICAgICAgLy8gLS0tIE5FVzogU2F2ZSBmdWxsIG1ldGFkYXRhIGZvciBXaWRnZXQgU3lzdGVtIC0tLVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgaW5zdGFsbGVkQXBwc1N0ciA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdnZW1pbmk5Ni1pbnN0YWxsZWQtYXBwcycpO1xuICAgICAgICAgICAgbGV0IGluc3RhbGxlZEFwcHNMaXN0OiBBcHBEYXRhW10gPSBpbnN0YWxsZWRBcHBzU3RyID8gSlNPTi5wYXJzZShpbnN0YWxsZWRBcHBzU3RyKSA6IFtdO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBSZW1vdmUgZXhpc3RpbmcgZW50cnkgaWYgdXBkYXRpbmdcbiAgICAgICAgICAgIGluc3RhbGxlZEFwcHNMaXN0ID0gaW5zdGFsbGVkQXBwc0xpc3QuZmlsdGVyKGEgPT4gYS5pZCAhPT0gYXBwLmlkKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gQWRkIG5ldyBlbnRyeVxuICAgICAgICAgICAgaW5zdGFsbGVkQXBwc0xpc3QucHVzaChhcHApO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnZ2VtaW5pOTYtaW5zdGFsbGVkLWFwcHMnLCBKU09OLnN0cmluZ2lmeShpbnN0YWxsZWRBcHBzTGlzdCkpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKFwiRmFpbGVkIHRvIHNhdmUgYXBwIG1ldGFkYXRhIGZvciB3aWRnZXRzXCIsIGUpO1xuICAgICAgICB9XG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgICAgICBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2Rvd25sb2FkaW5nJyk7XG4gICAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGdldFRleHQoJ2J0bl9sYXVuY2gnKTtcbiAgICAgICAgYnV0dG9uLnN0eWxlLnJlbW92ZVByb3BlcnR5KCctLXByb2dyZXNzJyk7XG4gICAgICAgIFxuICAgICAgICBhZGRBcHBUb0Rvd25sb2Fkc0ZvbGRlcihhcHApO1xuICAgICAgICBcbiAgICAgICAgaWYgKGlzVXBkYXRlKSB7XG4gICAgICAgICAgICBzaG93VG9hc3QoYFwiJHthcHAubmFtZX1cIiB1cGRhdGVkIHRvIHZlcnNpb24gJHthcHAudmVyc2lvbiB8fCAnbGF0ZXN0J30hYCwgJ3N1Y2Nlc3MnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNob3dUb2FzdChnZXRUZXh0KCdhcHBzdG9yZV9kb3dubG9hZF9jb21wbGV0ZScsIHsgYXBwTmFtZTogYXBwLm5hbWUgfSksICdzdWNjZXNzJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJlZnJlc2hMaXN0KCk7XG5cbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJEb3dubG9hZCBmYWlsZWQ6XCIsIGVycm9yKTtcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2Rvd25sb2FkaW5nJyk7XG4gICAgICAgIGJ1dHRvbi5zdHlsZS5yZW1vdmVQcm9wZXJ0eSgnLS1wcm9ncmVzcycpO1xuICAgICAgICBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgYnV0dG9uLnRleHRDb250ZW50ID0gZ2V0VGV4dCgnYnRuX2dldCcpIHx8IFwiR0VUXCI7XG4gICAgICAgIHNob3dUb2FzdChgRG93bmxvYWQgZmFpbGVkOiAke2Vycm9yLm1lc3NhZ2UgfHwgXCJOZXR3b3JrIEVycm9yXCJ9YCwgJ2Vycm9yJyk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBzaG93QXBwRGV0YWlscyhhcHA6IEFwcERhdGEsIHJlZnJlc2hGbjogKCkgPT4gdm9pZCkge1xuICAgIGNvbnN0IGluc3RhbGxlZFZlcnNpb24gPSBzdG9yZVN0YXRlLmluc3RhbGxlZEFwcHMuZ2V0KGFwcC5pZCk7XG4gICAgY29uc3QgY3VycmVudFN0b3JlVmVyc2lvbiA9IGFwcC52ZXJzaW9uIHx8ICd2MSc7XG4gICAgY29uc3QgaXNJbnN0YWxsZWQgPSAhIWluc3RhbGxlZFZlcnNpb247XG4gICAgY29uc3QgaXNVcGRhdGVBdmFpbGFibGUgPSBpc0luc3RhbGxlZCAmJiBpbnN0YWxsZWRWZXJzaW9uICE9PSBjdXJyZW50U3RvcmVWZXJzaW9uO1xuXG4gICAgY29uc3QgYXV0aG9yID0gYXBwLmdpdGh1YlVzZXIgfHwgQ09ORklHLkdJVEhVQl9VU0VSO1xuICAgIGNvbnN0IHJlcG8gPSBhcHAuZ2l0aHViUmVwbyB8fCBDT05GSUcuR0lUSFVCX1JFUE87XG4gICAgY29uc3QgcmVwb1VybCA9IGBodHRwczovL2dpdGh1Yi5jb20vJHthdXRob3J9LyR7cmVwb31gO1xuXG4gICAgY29uc3QgY29udGVudEh0bWwgPSBgXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzdG9yZS1kZXRhaWxzLWhlYWRlclwiPlxuICAgICAgICAgICAgPGltZyBzcmM9XCIke2FwcC5pY29ufVwiIGNsYXNzPVwic3RvcmUtZGV0YWlscy1pY29uXCIgb25lcnJvcj1cInRoaXMuc3JjPSdodHRwczovL2ltZy5pY29uczguY29tL2ZsdWVuY3kvOTYvYXBwbGljYXRpb24td2luZG93LnBuZydcIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzdG9yZS1kZXRhaWxzLXRpdGxlLWJsb2NrXCI+XG4gICAgICAgICAgICAgICAgPGgzPiR7YXBwLm5hbWV9PC9oMz5cbiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic3RvcmUtZGV0YWlscy1tZXRhXCI+XG4gICAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic3RvcmUtZGV0YWlscy12ZXJzaW9uXCI+JHthcHAudmVyc2lvbiB8fCAndjEnfTwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzdG9yZS1kZXRhaWxzLWNhdGVnb3J5XCI+JHthcHAuY2F0ZWdvcnl9PC9zcGFuPlxuICAgICAgICAgICAgICAgICAgICAke2FwcC5kb3dubG9hZENvdW50ICE9PSB1bmRlZmluZWQgPyBgPHNwYW4gY2xhc3M9XCJzdG9yZS1kZXRhaWxzLWRvd25sb2Fkc1wiIHRpdGxlPVwiVG90YWwgRG93bmxvYWRzXCI+4qyH77iPICR7YXBwLmRvd25sb2FkQ291bnR9PC9zcGFuPmAgOiAnJ31cbiAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic3RvcmUtZGV0YWlscy1hdXRob3JcIj5cbiAgICAgICAgICAgICAgICAgICAgYnkgPGEgaHJlZj1cIiR7cmVwb1VybH1cIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lciBub3JlZmVycmVyXCI+QCR7YXV0aG9yfTwvYT5cbiAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInN0b3JlLWRldGFpbHMtYm9keVwiPlxuICAgICAgICAgICAgPHA+JHthcHAuZGVzY3JpcHRpb259PC9wPlxuICAgICAgICA8L2Rpdj5cbiAgICBgO1xuXG4gICAgY29uc3QgYWN0aW9uczogeyBsYWJlbDogc3RyaW5nLCBwcmltYXJ5PzogYm9vbGVhbiwgZGFuZ2VyPzogYm9vbGVhbiwgb25DbGljazogKCkgPT4gdm9pZCB9W10gPSBbXTtcblxuICAgIGlmIChpc0luc3RhbGxlZCkge1xuICAgICAgICBpZiAoaXNVcGRhdGVBdmFpbGFibGUpIHtcbiAgICAgICAgICAgIGFjdGlvbnMucHVzaCh7XG4gICAgICAgICAgICAgICAgbGFiZWw6IGdldFRleHQoJ2J0bl91cGRhdGUnKSxcbiAgICAgICAgICAgICAgICBwcmltYXJ5OiB0cnVlLFxuICAgICAgICAgICAgICAgIG9uQ2xpY2s6ICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7IC8vIER1bW15IGJ1dHRvbiBmb3IgbG9naWNcbiAgICAgICAgICAgICAgICAgICAgZG93bmxvYWRBcHAoYXBwLCBidG4sIHJlZnJlc2hGbik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhY3Rpb25zLnB1c2goe1xuICAgICAgICAgICAgICAgIGxhYmVsOiBnZXRUZXh0KCdidG5fbGF1bmNoJyksXG4gICAgICAgICAgICAgICAgcHJpbWFyeTogdHJ1ZSxcbiAgICAgICAgICAgICAgICBvbkNsaWNrOiAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcHAuaXNFeHRlcm5hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgb3BlbkV4dGVybmFsQXBwKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5hcHAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZ2l0aHViVXNlcjogYXBwLmdpdGh1YlVzZXIgfHwgQ09ORklHLkdJVEhVQl9VU0VSLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGdpdGh1YlJlcG86IGFwcC5naXRodWJSZXBvIHx8IENPTkZJRy5HSVRIVUJfUkVQTyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBnaXRodWJCcmFuY2g6IGFwcC5naXRodWJCcmFuY2ggfHwgR0lUSFVCX0JSQU5DSCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcHBzUGF0aDogYXBwLmFwcHNQYXRoIHx8IEFQUFNfUEFUSFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYXBwLmlkID09PSAnc3VzQXBwJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF1bmNoVmlydXMoKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChhcHAuaWQgPT09ICdkb29tJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgb3BlbkFwcCgnZG9vbScpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2hvd1RvYXN0KGdldFRleHQoJ2FsZXJ0X2Zha2VfYXBwX29wZW4nLCB7IGFwcE5hbWU6IGFwcC5uYW1lIH0pLCAnd2FybmluZycpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYWN0aW9ucy5wdXNoKHtcbiAgICAgICAgICAgIGxhYmVsOiBcIlVuaW5zdGFsbFwiLFxuICAgICAgICAgICAgZGFuZ2VyOiB0cnVlLFxuICAgICAgICAgICAgb25DbGljazogKCkgPT4gaGFuZGxlVW5pbnN0YWxsKGFwcCwgcmVmcmVzaEZuKVxuICAgICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBhY3Rpb25zLnB1c2goe1xuICAgICAgICAgICAgbGFiZWw6IGdldFRleHQoJ2J0bl9nZXQnKSxcbiAgICAgICAgICAgIHByaW1hcnk6IHRydWUsXG4gICAgICAgICAgICBvbkNsaWNrOiAoKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7IC8vIER1bW15IGJ1dHRvblxuICAgICAgICAgICAgICAgIGRvd25sb2FkQXBwKGFwcCwgYnRuLCByZWZyZXNoRm4pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBhY3Rpb25zLnB1c2goeyBsYWJlbDogXCJDbG9zZVwiLCBvbkNsaWNrOiAoKSA9PiB7fSB9KTtcblxuICAgIHNob3dTdG9yZU1vZGFsKGFwcC5uYW1lLCBjb250ZW50SHRtbCwgYWN0aW9ucyk7XG59XG5cbmZ1bmN0aW9uIHNob3dTdG9yZU1vZGFsKHRpdGxlOiBzdHJpbmcsIGNvbnRlbnRIdG1sOiBzdHJpbmcsIGFjdGlvbnM6IHsgbGFiZWw6IHN0cmluZywgcHJpbWFyeT86IGJvb2xlYW4sIGRhbmdlcj86IGJvb2xlYW4sIG9uQ2xpY2s6ICgpID0+IHZvaWQgfVtdKSB7XG4gICAgY29uc3QgYXBwU3RvcmVXaW5kb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwU3RvcmUnKTtcbiAgICBpZiAoIWFwcFN0b3JlV2luZG93KSByZXR1cm47XG4gICAgXG4gICAgY29uc3Qgb3ZlcmxheSA9IGFwcFN0b3JlV2luZG93LnF1ZXJ5U2VsZWN0b3IoJy5zdG9yZS1tb2RhbC1vdmVybGF5JykgYXMgSFRNTERpdkVsZW1lbnQ7XG4gICAgY29uc3QgdGl0bGVFbCA9IGFwcFN0b3JlV2luZG93LnF1ZXJ5U2VsZWN0b3IoJy5zdG9yZS1tb2RhbC10aXRsZScpIGFzIEhUTUxTcGFuRWxlbWVudDtcbiAgICBjb25zdCBjb250ZW50RWwgPSBhcHBTdG9yZVdpbmRvdy5xdWVyeVNlbGVjdG9yKCcuc3RvcmUtbW9kYWwtY29udGVudCcpIGFzIEhUTUxEaXZFbGVtZW50O1xuICAgIGNvbnN0IGZvb3RlckVsID0gYXBwU3RvcmVXaW5kb3cucXVlcnlTZWxlY3RvcignLnN0b3JlLW1vZGFsLWZvb3RlcicpIGFzIEhUTUxEaXZFbGVtZW50O1xuICAgIGNvbnN0IGNsb3NlQnRuID0gYXBwU3RvcmVXaW5kb3cucXVlcnlTZWxlY3RvcignLnN0b3JlLW1vZGFsLWNsb3NlJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG5cbiAgICBpZiAoIW92ZXJsYXkgfHwgIXRpdGxlRWwgfHwgIWNvbnRlbnRFbCB8fCAhZm9vdGVyRWwpIHJldHVybjtcblxuICAgIHRpdGxlRWwudGV4dENvbnRlbnQgPSB0aXRsZTtcbiAgICBjb250ZW50RWwuaW5uZXJIVE1MID0gY29udGVudEh0bWw7XG4gICAgZm9vdGVyRWwuaW5uZXJIVE1MID0gJyc7XG5cbiAgICBjb25zdCBoaWRlTW9kYWwgPSAoKSA9PiBvdmVybGF5LnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG5cbiAgICBhY3Rpb25zLmZvckVhY2goYWN0aW9uID0+IHtcbiAgICAgICAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGJ0bi5jbGFzc05hbWUgPSBgc3RvcmUtbW9kYWwtYnRuICR7YWN0aW9uLnByaW1hcnkgPyAncHJpbWFyeScgOiAnJ30gJHthY3Rpb24uZGFuZ2VyID8gJ2RhbmdlcicgOiAnJ31gO1xuICAgICAgICBidG4udGV4dENvbnRlbnQgPSBhY3Rpb24ubGFiZWw7XG4gICAgICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgICAgICAgYWN0aW9uLm9uQ2xpY2soKTtcbiAgICAgICAgICAgIGlmIChhY3Rpb24ubGFiZWwgPT09IFwiQ2xvc2VcIiB8fCBhY3Rpb24ubGFiZWwgPT09IFwiRGVsZXRlXCIpIGhpZGVNb2RhbCgpO1xuICAgICAgICAgICAgLy8gRm9yIGluc3RhbGwvbGF1bmNoLCB3ZSBtaWdodCB3YW50IHRvIGtlZXAgaXQgb3BlbiBvciBjbG9zZSBpdCBkZXBlbmRpbmcgb24gVVguIFxuICAgICAgICAgICAgLy8gTGV0J3MgY2xvc2UgaXQgZm9yIG5vdyB0byBhdm9pZCBzdGF0ZSBtaXNtYXRjaCBpZiBkb3dubG9hZCBpcyBhc3luYy5cbiAgICAgICAgICAgIGlmIChhY3Rpb24ubGFiZWwgPT09IGdldFRleHQoJ2J0bl9sYXVuY2gnKSkgaGlkZU1vZGFsKCk7XG4gICAgICAgIH07XG4gICAgICAgIGZvb3RlckVsLmFwcGVuZENoaWxkKGJ0bik7XG4gICAgfSk7XG5cbiAgICBjbG9zZUJ0bi5vbmNsaWNrID0gaGlkZU1vZGFsO1xuICAgIG92ZXJsYXkuc3R5bGUuZGlzcGxheSA9ICdmbGV4Jztcbn1cblxuZnVuY3Rpb24gaGFuZGxlVW5pbnN0YWxsKGFwcDogQXBwRGF0YSwgcmVmcmVzaExpc3Q6ICgpID0+IHZvaWQpIHtcbiAgICBzaG93U3RvcmVNb2RhbChcbiAgICAgICAgXCJVbmluc3RhbGwgQXBwXCIsXG4gICAgICAgIGA8cD5BcmUgeW91IHN1cmUgeW91IHdhbnQgdG8gZGVsZXRlIDxzdHJvbmc+JHthcHAubmFtZX08L3N0cm9uZz4/PC9wPlxuICAgICAgICAgPHAgc3R5bGU9XCJmb250LXNpemU6MC44cmVtOyBjb2xvcjojNjY2OyBtYXJnaW4tdG9wOjVweDtcIj5UaGlzIHdpbGwgcmVtb3ZlIGl0IGZyb20geW91ciBEb3dubG9hZGVkIEFwcHMgZm9sZGVyIGFuZCB0YXNrYmFyLjwvcD5gLFxuICAgICAgICBbXG4gICAgICAgICAgICB7IGxhYmVsOiBcIkNhbmNlbFwiLCBvbkNsaWNrOiAoKSA9PiB7fSB9LFxuICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICBsYWJlbDogXCJEZWxldGVcIiwgXG4gICAgICAgICAgICAgICAgZGFuZ2VyOiB0cnVlLFxuICAgICAgICAgICAgICAgIG9uQ2xpY2s6ICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgc2FmZUlkID0gYXBwLmlzRXh0ZXJuYWwgPyBgZXh0LSR7YXBwLmlkfWAgOiBhcHAuaWQ7XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAob3BlbkFwcHMuaGFzKHNhZmVJZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsb3NlQXBwKHNhZmVJZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBzdG9yZVN0YXRlLmluc3RhbGxlZEFwcHMuZGVsZXRlKGFwcC5pZCk7XG4gICAgICAgICAgICAgICAgICAgIHNhdmVJbnN0YWxsZWRBcHBzKCk7IC8vIFBlcnNpc3QgcmVtb3ZhbFxuICAgICAgICAgICAgICAgICAgICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShgZ2VtaW5pX2FwcF9jb250ZW50XyR7YXBwLmlkfWApOyAvLyBSZW1vdmUgY2FjaGVkIGNvbnRlbnRcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oYGdlbWluaV9hcHBfd2lkZ2V0XyR7YXBwLmlkfWApOyAvLyBSZW1vdmUgY2FjaGVkIHdpZGdldFxuXG4gICAgICAgICAgICAgICAgICAgIC8vIC0tLSBORVc6IFJlbW92ZSBmcm9tIFdpZGdldCBTeXN0ZW0gbWV0YWRhdGEgLS0tXG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBpbnN0YWxsZWRBcHBzU3RyID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2dlbWluaTk2LWluc3RhbGxlZC1hcHBzJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5zdGFsbGVkQXBwc1N0cikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBpbnN0YWxsZWRBcHBzTGlzdDogQXBwRGF0YVtdID0gSlNPTi5wYXJzZShpbnN0YWxsZWRBcHBzU3RyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbnN0YWxsZWRBcHBzTGlzdCA9IGluc3RhbGxlZEFwcHNMaXN0LmZpbHRlcihhID0+IGEuaWQgIT09IGFwcC5pZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2dlbWluaTk2LWluc3RhbGxlZC1hcHBzJywgSlNPTi5zdHJpbmdpZnkoaW5zdGFsbGVkQXBwc0xpc3QpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihcIkZhaWxlZCB0byByZW1vdmUgYXBwIG1ldGFkYXRhIGZvciB3aWRnZXRzXCIsIGUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBmb2xkZXJDb250ZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Rvd25sb2Fkcy1jb250ZW50Jyk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChmb2xkZXJDb250ZW50KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBpY29uID0gZm9sZGVyQ29udGVudC5xdWVyeVNlbGVjdG9yKGAud2luZG93LWljb25bZGF0YS1hcHA9XCIke3NhZmVJZH1cIl1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpY29uKSBpY29uLnJlbW92ZSgpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZGVza3RvcEljb24gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKGAjZGVza3RvcCA+IC5pY29uW2RhdGEtYXBwPVwiJHtzYWZlSWR9XCJdYCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChkZXNrdG9wSWNvbikgZGVza3RvcEljb24ucmVtb3ZlKCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHBpbm5lZEFwcHMuaW5jbHVkZXMoc2FmZUlkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2V0UGlubmVkQXBwcyhwaW5uZWRBcHBzLmZpbHRlcihpZCA9PiBpZCAhPT0gc2FmZUlkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShQSU5ORURfQVBQU19TVE9SQUdFX0tFWSwgSlNPTi5zdHJpbmdpZnkocGlubmVkQXBwcykpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVuZGVyVGFza2JhcigpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdXBkYXRlU3RhcnRNZW51UGlucygpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmVmcmVzaExpc3QoKTtcbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgfVxuICAgICAgICBdXG4gICAgKTtcbn1cblxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5pdGlhbGl6ZUFwcFN0b3JlKGFwcElkOiBzdHJpbmcpIHtcbiAgICBjb25zdCB3aW5kb3dFbCA9IG9wZW5BcHBzLmdldChhcHBJZCk/LndpbmRvd0VsO1xuICAgIGlmICghd2luZG93RWwpIHJldHVybjtcblxuICAgIGNvbnN0IGxpc3RFbCA9IHdpbmRvd0VsLnF1ZXJ5U2VsZWN0b3IoJyNhcHAtc3RvcmUtcmVndWxhci1saXN0JykgYXMgSFRNTERpdkVsZW1lbnQ7XG4gICAgY29uc3QgZmVhdHVyZWRMaXN0RWwgPSB3aW5kb3dFbC5xdWVyeVNlbGVjdG9yKCcjYXBwLXN0b3JlLWZlYXR1cmVkLWxpc3QnKSBhcyBIVE1MRGl2RWxlbWVudDtcbiAgICBjb25zdCBmZWF0dXJlZFNlY3Rpb24gPSB3aW5kb3dFbC5xdWVyeVNlbGVjdG9yKCcjYXBwLXN0b3JlLWZlYXR1cmVkLXNlY3Rpb24nKSBhcyBIVE1MRGl2RWxlbWVudDtcbiAgICBcbiAgICBjb25zdCBzZXR0aW5nc1ZpZXcgPSB3aW5kb3dFbC5xdWVyeVNlbGVjdG9yKCcuYXBwLXN0b3JlLXNldHRpbmdzLXZpZXcnKSBhcyBIVE1MRGl2RWxlbWVudDtcbiAgICBjb25zdCBjYXRlZ29yeUxpc3QgPSB3aW5kb3dFbC5xdWVyeVNlbGVjdG9yKCcuYXBwLXN0b3JlLWNhdGVnb3JpZXMtbGlzdCcpIGFzIEhUTUxVTGlzdEVsZW1lbnQ7XG4gICAgY29uc3QgdW50cnVzdGVkVG9nZ2xlID0gd2luZG93RWwucXVlcnlTZWxlY3RvcignI3VudHJ1c3RlZC10b2dnbGUnKSBhcyBIVE1MSW5wdXRFbGVtZW50O1xuICAgIGNvbnN0IHJlZnJlc2hCdG4gPSB3aW5kb3dFbC5xdWVyeVNlbGVjdG9yKCcjc3RvcmUtcmVmcmVzaC1idG4nKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbiAgICBcbiAgICAvLyBOZXcgY29udHJvbHNcbiAgICBjb25zdCBzZWFyY2hJbnB1dCA9IHdpbmRvd0VsLnF1ZXJ5U2VsZWN0b3IoJyNzdG9yZS1zZWFyY2gtaW5wdXQnKSBhcyBIVE1MSW5wdXRFbGVtZW50O1xuICAgIGNvbnN0IHNvcnRTZWxlY3QgPSB3aW5kb3dFbC5xdWVyeVNlbGVjdG9yKCcjc3RvcmUtc29ydC1zZWxlY3QnKSBhcyBIVE1MU2VsZWN0RWxlbWVudDtcblxuICAgIGlmICghbGlzdEVsIHx8ICFjYXRlZ29yeUxpc3QgfHwgIXNldHRpbmdzVmlldyB8fCAhdW50cnVzdGVkVG9nZ2xlKSByZXR1cm47XG4gICAgXG4gICAgLy8gLS0tIEV2ZW50IExpc3RlbmVyIGZvciBBdXRvLVJlZnJlc2ggb24gUHVibGlzaCAtLS1cbiAgICBpZiAoISh3aW5kb3dFbCBhcyBhbnkpLl9oYXNSZWZyZXNoTGlzdGVuZXIpIHtcbiAgICAgICAgKHdpbmRvd0VsIGFzIGFueSkuX2hhc1JlZnJlc2hMaXN0ZW5lciA9IHRydWU7XG4gICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdzdG9yZTpyZWZyZXNoJywgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKGRvY3VtZW50LmJvZHkuY29udGFpbnMod2luZG93RWwpICYmIHdpbmRvd0VsLnN0eWxlLmRpc3BsYXkgIT09ICdub25lJykge1xuICAgICAgICAgICAgICAgIGlmIChyZWZyZXNoQnRuKSByZWZyZXNoQnRuLmNsaWNrKCk7IFxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzdG9yZVN0YXRlLmhhc0ZldGNoZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBzdG9yZVN0YXRlLmV4dGVybmFsQXBwcyA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyAtLS0gQmFjayBCdXR0b24gSGFuZGxlciAtLS1cbiAgICB3aW5kb3dFbC5hZGRFdmVudExpc3RlbmVyKCdnZW1pbmktb3MtYmFjaycsIChlKSA9PiB7XG4gICAgICAgIGNvbnN0IG92ZXJsYXkgPSB3aW5kb3dFbC5xdWVyeVNlbGVjdG9yKCcuc3RvcmUtbW9kYWwtb3ZlcmxheScpIGFzIEhUTUxEaXZFbGVtZW50O1xuICAgICAgICBpZiAob3ZlcmxheSAmJiBvdmVybGF5LnN0eWxlLmRpc3BsYXkgIT09ICdub25lJykge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOyAvLyBQcmV2ZW50IGFwcCBjbG9zaW5nXG4gICAgICAgICAgICBvdmVybGF5LnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IGNhdGVnb3JpZXNUb0FkZCA9IFtcbiAgICAgICAgeyBpZDogJ1Byb2R1Y3Rpdml0eScsIGtleTogJ2FwcHN0b3JlX2NhdF9wcm9kJywgbGFiZWw6ICdQcm9kdWN0aXZpdHknIH0sXG4gICAgICAgIHsgaWQ6ICdFbnRlcnRhaW5tZW50Jywga2V5OiAnYXBwc3RvcmVfY2F0X2VudCcsIGxhYmVsOiAnRW50ZXJ0YWlubWVudCcgfSxcbiAgICAgICAgeyBpZDogJ0VkdWNhdGlvbicsIGtleTogJ2FwcHN0b3JlX2NhdF9lZHUnLCBsYWJlbDogJ0VkdWNhdGlvbicgfSxcbiAgICAgICAgeyBpZDogJ2RldicsIGtleTogJ2FwcHN0b3JlX2NhdF9kZXYnLCBsYWJlbDogJ0RldmVsb3BlcicgfVxuICAgIF07XG5cbiAgICBjYXRlZ29yaWVzVG9BZGQuZm9yRWFjaChjYXQgPT4ge1xuICAgICAgICBpZiAoIWNhdGVnb3J5TGlzdC5xdWVyeVNlbGVjdG9yKGBbZGF0YS1jYXRlZ29yeT1cIiR7Y2F0LmlkfVwiXWApKSB7XG4gICAgICAgICAgICBjb25zdCBzZXR0aW5nc0xpID0gY2F0ZWdvcnlMaXN0LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWNhdGVnb3J5PVwic2V0dGluZ3NcIl0nKTtcbiAgICAgICAgICAgIGNvbnN0IG5ld0xpID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGknKTtcbiAgICAgICAgICAgIG5ld0xpLmRhdGFzZXQuY2F0ZWdvcnkgPSBjYXQuaWQ7XG4gICAgICAgICAgICBuZXdMaS5kYXRhc2V0LmkxOG5LZXkgPSBjYXQua2V5O1xuICAgICAgICAgICAgbmV3TGkudGV4dENvbnRlbnQgPSBnZXRUZXh0KGNhdC5rZXkpIHx8IGNhdC5sYWJlbDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHNldHRpbmdzTGkgJiYgY2F0LmlkICE9PSAnZGV2Jykge1xuICAgICAgICAgICAgICAgIGNhdGVnb3J5TGlzdC5pbnNlcnRCZWZvcmUobmV3TGksIHNldHRpbmdzTGkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjYXRlZ29yeUxpc3QuYXBwZW5kQ2hpbGQobmV3TGkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSk7XG4gICAgXG4gICAgbGV0IGRldlZpZXcgPSB3aW5kb3dFbC5xdWVyeVNlbGVjdG9yKCcuYXBwLXN0b3JlLWRldi12aWV3JykgYXMgSFRNTERpdkVsZW1lbnQ7XG4gICAgaWYgKCFkZXZWaWV3KSB7XG4gICAgICAgIGRldlZpZXcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgZGV2Vmlldy5jbGFzc05hbWUgPSAnYXBwLXN0b3JlLWRldi12aWV3JztcbiAgICAgICAgZGV2Vmlldy5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgICAgICBkZXZWaWV3LnN0eWxlLnBhZGRpbmcgPSAnMjBweCc7XG4gICAgICAgIGRldlZpZXcuaW5uZXJIVE1MID0gYFxuICAgICAgICAgICAgPHAgc3R5bGU9XCJtYXJnaW4tYm90dG9tOjE1cHg7IGZvbnQtc2l6ZTowLjlyZW07XCI+JHtnZXRUZXh0KCdkZXZfaW50cm8nKX08L3A+XG4gICAgICAgICAgICA8ZGl2IHN0eWxlPVwiZGlzcGxheTpmbGV4OyBmbGV4LWRpcmVjdGlvbjpjb2x1bW47IGdhcDoxMHB4O1wiPlxuICAgICAgICAgICAgICAgIDxsYWJlbCBzdHlsZT1cImZvbnQtc2l6ZTowLjhyZW07XCI+JHtnZXRUZXh0KCdkZXZfdXNlcl9sYWJlbCcpfSA8aW5wdXQgdHlwZT1cInRleHRcIiBpZD1cImRldi11c2VyXCIgY2xhc3M9XCJzZXR0aW5ncy1zZWxlY3RcIiB2YWx1ZT1cIiR7Q09ORklHLkdJVEhVQl9VU0VSfVwiIHBsYWNlaG9sZGVyPVwiZS5nLiB5b3VyLXVzZXJuYW1lXCI+PC9sYWJlbD5cbiAgICAgICAgICAgICAgICA8bGFiZWwgc3R5bGU9XCJmb250LXNpemU6MC44cmVtO1wiPiR7Z2V0VGV4dCgnZGV2X3JlcG9fbGFiZWwnKX0gPGlucHV0IHR5cGU9XCJ0ZXh0XCIgaWQ9XCJkZXYtcmVwb1wiIGNsYXNzPVwic2V0dGluZ3Mtc2VsZWN0XCIgdmFsdWU9XCIke0NPTkZJRy5HSVRIVUJfUkVQT31cIiBwbGFjZWhvbGRlcj1cImUuZy4gZ2VtaW5pLW9zLWFwcHNcIj48L2xhYmVsPlxuICAgICAgICAgICAgICAgIDxsYWJlbCBzdHlsZT1cImZvbnQtc2l6ZTowLjhyZW07XCI+JHtnZXRUZXh0KCdkZXZfdG9rZW5fbGFiZWwnKX0gPGlucHV0IHR5cGU9XCJwYXNzd29yZFwiIGlkPVwiZGV2LXRva2VuXCIgY2xhc3M9XCJzZXR0aW5ncy1zZWxlY3RcIiB2YWx1ZT1cIiR7Q09ORklHLkdJVEhVQl9UT0tFTn1cIiBwbGFjZWhvbGRlcj1cImdocF8uLi5cIj48L2xhYmVsPlxuICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJkZXYtdXBkYXRlLWJ0blwiIHN0eWxlPVwibWFyZ2luLXRvcDoxMHB4OyBwYWRkaW5nOjhweDtcIiBjbGFzcz1cImFwcC1zdG9yZS1nZXQtYnRuXCI+JHtnZXRUZXh0KCdkZXZfZGVwbG95X2J0bicpfTwvYnV0dG9uPlxuICAgICAgICAgICAgICAgIDxwIGlkPVwiZGV2LXN0YXR1c1wiIHN0eWxlPVwiZm9udC1zaXplOjAuOHJlbTsgbWFyZ2luLXRvcDoxMHB4O1wiPjwvcD5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICBgO1xuICAgICAgICB3aW5kb3dFbC5xdWVyeVNlbGVjdG9yKCcuYXBwLXN0b3JlLW1haW4nKT8uYXBwZW5kQ2hpbGQoZGV2Vmlldyk7XG5cbiAgICAgICAgY29uc3QgdXBkYXRlQnRuID0gZGV2Vmlldy5xdWVyeVNlbGVjdG9yKCcjZGV2LXVwZGF0ZS1idG4nKTtcbiAgICAgICAgY29uc3Qgc3RhdHVzRWwgPSBkZXZWaWV3LnF1ZXJ5U2VsZWN0b3IoJyNkZXYtc3RhdHVzJykgYXMgSFRNTEVsZW1lbnQ7XG4gICAgICAgIGNvbnN0IHVzZXJJbnB1dCA9IGRldlZpZXcucXVlcnlTZWxlY3RvcignI2Rldi11c2VyJykgYXMgSFRNTElucHV0RWxlbWVudDtcbiAgICAgICAgY29uc3QgcmVwb0lucHV0ID0gZGV2Vmlldy5xdWVyeVNlbGVjdG9yKCcjZGV2LXJlcG8nKSBhcyBIVE1MSW5wdXRFbGVtZW50O1xuICAgICAgICBjb25zdCB0b2tlbklucHV0ID0gZGV2Vmlldy5xdWVyeVNlbGVjdG9yKCcjZGV2LXRva2VuJykgYXMgSFRNTElucHV0RWxlbWVudDtcblxuICAgICAgICB1cGRhdGVCdG4/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgIGNvbnN0IHVzZXIgPSB1c2VySW5wdXQudmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgIGNvbnN0IHJlcG8gPSByZXBvSW5wdXQudmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgIGNvbnN0IHRva2VuID0gdG9rZW5JbnB1dC52YWx1ZS50cmltKCk7XG4gICAgICAgICAgICAgXG4gICAgICAgICAgICAgaWYgKHVzZXIgJiYgcmVwbykge1xuICAgICAgICAgICAgICAgICBDT05GSUcuR0lUSFVCX1VTRVIgPSB1c2VyO1xuICAgICAgICAgICAgICAgICBDT05GSUcuR0lUSFVCX1JFUE8gPSByZXBvO1xuICAgICAgICAgICAgICAgICBpZiAodG9rZW4pIENPTkZJRy5HSVRIVUJfVE9LRU4gPSB0b2tlbjtcbiAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgIHN0b3JlU3RhdGUuaGFzRmV0Y2hlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICBzdG9yZVN0YXRlLmV4dGVybmFsQXBwcyA9IFtdO1xuICAgICAgICAgICAgICAgICBzdGF0dXNFbC50ZXh0Q29udGVudCA9IGdldFRleHQoJ2Rldl9zdGF0dXNfc3VjY2VzcycpO1xuICAgICAgICAgICAgICAgICBzdGF0dXNFbC5zdHlsZS5jb2xvciA9IFwiZ3JlZW5cIjtcbiAgICAgICAgICAgICAgICAgc2V0VGltZW91dCgoKSA9PiBzdGF0dXNFbC50ZXh0Q29udGVudCA9ICcnLCAzMDAwKTtcbiAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICBzdGF0dXNFbC50ZXh0Q29udGVudCA9IGdldFRleHQoJ2Rldl9zdGF0dXNfZXJyb3InLCB7IGVycm9yOiAnTWlzc2luZyBVc2VyIG9yIFJlcG8nIH0pO1xuICAgICAgICAgICAgICAgICBzdGF0dXNFbC5zdHlsZS5jb2xvciA9IFwicmVkXCI7XG4gICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCByZW5kZXJBcHBJdGVtID0gKGFwcDogQXBwRGF0YSwgY29udGFpbmVyOiBIVE1MRWxlbWVudCwgcmVmcmVzaEZuOiAoKSA9PiB2b2lkLCBpc0ZlYXR1cmVkID0gZmFsc2UpID0+IHtcbiAgICAgICAgY29uc3QgaXRlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBpdGVtLmNsYXNzTmFtZSA9IGBhcHAtc3RvcmUtaXRlbSAke2lzRmVhdHVyZWQgPyAnZmVhdHVyZWQnIDogJyd9YDtcblxuICAgICAgICBjb25zdCBpY29uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW1nJyk7XG4gICAgICAgIGljb24uc3JjID0gYXBwLmljb247XG4gICAgICAgIGljb24uYWx0ID0gYXBwLm5hbWU7XG4gICAgICAgIGljb24uY2xhc3NOYW1lID0gJ2FwcC1zdG9yZS1pdGVtLWljb24nO1xuICAgICAgICBpY29uLnN0eWxlLmN1cnNvciA9ICdwb2ludGVyJztcbiAgICAgICAgaWNvbi5vbmVycm9yID0gKCkgPT4geyBpY29uLnNyYyA9ICdodHRwczovL2ltZy5pY29uczguY29tL2ZsdWVuY3kvOTYvYXBwbGljYXRpb24td2luZG93LnBuZyc7IH07XG4gICAgICAgIGljb24ub25jbGljayA9ICgpID0+IHNob3dBcHBEZXRhaWxzKGFwcCwgcmVmcmVzaEZuKTtcblxuICAgICAgICBjb25zdCBpbmZvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGluZm8uY2xhc3NOYW1lID0gJ2FwcC1zdG9yZS1pdGVtLWluZm8nO1xuICAgICAgICBpbmZvLnN0eWxlLmN1cnNvciA9ICdwb2ludGVyJztcbiAgICAgICAgaW5mby5vbmNsaWNrID0gKCkgPT4gc2hvd0FwcERldGFpbHMoYXBwLCByZWZyZXNoRm4pO1xuXG4gICAgICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdoNCcpO1xuICAgICAgICBpZiAoYXBwLmlzRXh0ZXJuYWwpIHtcbiAgICAgICAgICAgIG5hbWUudGV4dENvbnRlbnQgPSBhcHAubmFtZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG5hbWUudGV4dENvbnRlbnQgPSBnZXRUZXh0KGFwcC5pZCA9PT0gJ3N1c0FwcCcgPyAnYXBwX3N1c0FwcF9uYW1lJyA6IGFwcC5pZCk7XG4gICAgICAgICAgICBpZiAoIW5hbWUudGV4dENvbnRlbnQgfHwgbmFtZS50ZXh0Q29udGVudC5zdGFydHNXaXRoKCdbJykpIG5hbWUudGV4dENvbnRlbnQgPSBhcHAubmFtZTsgXG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmIChhcHAudmVyc2lvbikge1xuICAgICAgICAgICAgY29uc3QgdmVyc2lvblNwYW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XG4gICAgICAgICAgICB2ZXJzaW9uU3Bhbi5jbGFzc05hbWUgPSAnYXBwLXN0b3JlLXZlcnNpb24tdGFnJztcbiAgICAgICAgICAgIHZlcnNpb25TcGFuLnRleHRDb250ZW50ID0gYXBwLnZlcnNpb247XG4gICAgICAgICAgICBuYW1lLmFwcGVuZENoaWxkKHZlcnNpb25TcGFuKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChhcHAuZG93bmxvYWRDb3VudCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBjb25zdCBkbFNwYW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XG4gICAgICAgICAgICBkbFNwYW4uY2xhc3NOYW1lID0gJ3N0b3JlLWRldGFpbHMtZG93bmxvYWRzJztcbiAgICAgICAgICAgIGRsU3Bhbi5pbm5lckhUTUwgPSBg4qyH77iPICR7YXBwLmRvd25sb2FkQ291bnR9YDtcbiAgICAgICAgICAgIG5hbWUuYXBwZW5kQ2hpbGQoZGxTcGFuKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3AnKTtcbiAgICAgICAgaWYgKGFwcC5pc0V4dGVybmFsKSB7XG4gICAgICAgICAgICBkZXNjLnRleHRDb250ZW50ID0gYXBwLmRlc2NyaXB0aW9uO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZGVzYy50ZXh0Q29udGVudCA9IGdldFRleHQoYXBwLmlkID09PSAnc3VzQXBwJyA/ICdhcHBfc3VzQXBwX2Rlc2MnIDogYXBwLmlkICsgJ19kZXNjJyk7XG4gICAgICAgICAgICBpZiAoIWRlc2MudGV4dENvbnRlbnQgfHwgZGVzYy50ZXh0Q29udGVudC5zdGFydHNXaXRoKCdbJykpIGRlc2MudGV4dENvbnRlbnQgPSBhcHAuZGVzY3JpcHRpb247XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGluZm8uYXBwZW5kQ2hpbGQobmFtZSk7XG4gICAgICAgIGluZm8uYXBwZW5kQ2hpbGQoZGVzYyk7XG5cbiAgICAgICAgY29uc3QgYWN0aW9uc0NvbnRhaW5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBhY3Rpb25zQ29udGFpbmVyLmNsYXNzTmFtZSA9ICdhcHAtc3RvcmUtYWN0aW9ucyc7XG5cbiAgICAgICAgY29uc3QgYWN0aW9uQnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGFjdGlvbkJ0bi5jbGFzc05hbWUgPSAnYXBwLXN0b3JlLWdldC1idG4nO1xuXG4gICAgICAgIGNvbnN0IGluc3RhbGxlZFZlcnNpb24gPSBzdG9yZVN0YXRlLmluc3RhbGxlZEFwcHMuZ2V0KGFwcC5pZCk7XG4gICAgICAgIGNvbnN0IGN1cnJlbnRTdG9yZVZlcnNpb24gPSBhcHAudmVyc2lvbiB8fCAndjEnO1xuXG4gICAgICAgIGlmIChpbnN0YWxsZWRWZXJzaW9uKSB7XG4gICAgICAgICAgICBpZiAoaW5zdGFsbGVkVmVyc2lvbiAhPT0gY3VycmVudFN0b3JlVmVyc2lvbikge1xuICAgICAgICAgICAgICAgIGFjdGlvbkJ0bi50ZXh0Q29udGVudCA9IGdldFRleHQoJ2J0bl91cGRhdGUnKTtcbiAgICAgICAgICAgICAgICBhY3Rpb25CdG4ub25jbGljayA9ICgpID0+IGRvd25sb2FkQXBwKGFwcCwgYWN0aW9uQnRuLCByZWZyZXNoRm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhY3Rpb25CdG4udGV4dENvbnRlbnQgPSBnZXRUZXh0KCdidG5fbGF1bmNoJyk7XG4gICAgICAgICAgICAgICAgYWN0aW9uQnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcHAuaXNFeHRlcm5hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgb3BlbkV4dGVybmFsQXBwKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5hcHAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZ2l0aHViVXNlcjogYXBwLmdpdGh1YlVzZXIgfHwgQ09ORklHLkdJVEhVQl9VU0VSLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGdpdGh1YlJlcG86IGFwcC5naXRodWJSZXBvIHx8IENPTkZJRy5HSVRIVUJfUkVQTyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBnaXRodWJCcmFuY2g6IGFwcC5naXRodWJCcmFuY2ggfHwgR0lUSFVCX0JSQU5DSCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcHBzUGF0aDogYXBwLmFwcHNQYXRoIHx8IEFQUFNfUEFUSFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYXBwLmlkID09PSAnc3VzQXBwJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF1bmNoVmlydXMoKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChhcHAuaWQgPT09ICdkb29tJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgb3BlbkFwcCgnZG9vbScpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2hvd1RvYXN0KGdldFRleHQoJ2FsZXJ0X2Zha2VfYXBwX29wZW4nLCB7IGFwcE5hbWU6IGFwcC5uYW1lIH0pLCAnd2FybmluZycpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgZGVsZXRlQnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgICAgICBkZWxldGVCdG4uY2xhc3NOYW1lID0gJ2FwcC1zdG9yZS1kZWxldGUtYnRuJztcbiAgICAgICAgICAgIGRlbGV0ZUJ0bi50aXRsZSA9IFwiVW5pbnN0YWxsXCI7XG4gICAgICAgICAgICBkZWxldGVCdG4uaW5uZXJIVE1MID0gJ/Cfl5HvuI8nO1xuICAgICAgICAgICAgZGVsZXRlQnRuLm9uY2xpY2sgPSAoKSA9PiBoYW5kbGVVbmluc3RhbGwoYXBwLCByZWZyZXNoRm4pO1xuICAgICAgICAgICAgYWN0aW9uc0NvbnRhaW5lci5hcHBlbmRDaGlsZChkZWxldGVCdG4pO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhY3Rpb25CdG4udGV4dENvbnRlbnQgPSBnZXRUZXh0KCdidG5fZ2V0Jyk7XG4gICAgICAgICAgICBhY3Rpb25CdG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgICAgICAgICAgICBkb3dubG9hZEFwcChhcHAsIGFjdGlvbkJ0biwgcmVmcmVzaEZuKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBhY3Rpb25zQ29udGFpbmVyLmluc2VydEJlZm9yZShhY3Rpb25CdG4sIGFjdGlvbnNDb250YWluZXIuZmlyc3RDaGlsZCk7XG5cbiAgICAgICAgaXRlbS5hcHBlbmRDaGlsZChpY29uKTtcbiAgICAgICAgaXRlbS5hcHBlbmRDaGlsZChpbmZvKTtcbiAgICAgICAgaXRlbS5hcHBlbmRDaGlsZChhY3Rpb25zQ29udGFpbmVyKTtcbiAgICAgICAgY29udGFpbmVyLmFwcGVuZENoaWxkKGl0ZW0pO1xuICAgIH07XG5cbiAgICAvLyBJbmplY3QgU3R5bGVzIGZvciBWZXJ0aWNhbCBMYXlvdXRcbiAgICBjb25zdCBzdHlsZUlkID0gJ2FwcC1zdG9yZS12ZXJ0aWNhbC1zdHlsZSc7XG4gICAgaWYgKCFkb2N1bWVudC5nZXRFbGVtZW50QnlJZChzdHlsZUlkKSkge1xuICAgICAgICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3N0eWxlJyk7XG4gICAgICAgIHN0eWxlLmlkID0gc3R5bGVJZDtcbiAgICAgICAgc3R5bGUudGV4dENvbnRlbnQgPSBgXG4gICAgICAgICAgICAuYXBwLXN0b3JlLWxpc3QsICNhcHAtc3RvcmUtZmVhdHVyZWQtbGlzdCwgI2FwcC1zdG9yZS1yZWd1bGFyLWxpc3Qge1xuICAgICAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICAgICAgICAgICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcbiAgICAgICAgICAgICAgICBnYXA6IDEwcHg7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAuYXBwLXN0b3JlLWl0ZW0ge1xuICAgICAgICAgICAgICAgIHdpZHRoOiAxMDAlO1xuICAgICAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICAgICAgICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICAgICAgICAgICAgICBwYWRkaW5nOiAxMnB4O1xuICAgICAgICAgICAgICAgIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCByZ2JhKDAsMCwwLDAuMDUpO1xuICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC40KTtcbiAgICAgICAgICAgICAgICBib3JkZXItcmFkaXVzOiA4cHg7XG4gICAgICAgICAgICAgICAgbWFyZ2luLWJvdHRvbTogNHB4O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLmFwcC1zdG9yZS1pdGVtOmxhc3QtY2hpbGQgeyBib3JkZXItYm90dG9tOiBub25lOyB9XG4gICAgICAgICAgICAuYXBwLXN0b3JlLWl0ZW0taWNvbiB7XG4gICAgICAgICAgICAgICAgd2lkdGg6IDU2cHg7XG4gICAgICAgICAgICAgICAgaGVpZ2h0OiA1NnB4O1xuICAgICAgICAgICAgICAgIG1hcmdpbi1yaWdodDogMTZweDtcbiAgICAgICAgICAgICAgICBmbGV4LXNocmluazogMDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC5hcHAtc3RvcmUtaXRlbS1pbmZvIHtcbiAgICAgICAgICAgICAgICBmbGV4OiAxO1xuICAgICAgICAgICAgICAgIG1pbi13aWR0aDogMDsgLyogVGV4dCB0cnVuY2F0aW9uIGZpeCAqL1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLmFwcC1zdG9yZS1pdGVtLWluZm8gaDQge1xuICAgICAgICAgICAgICAgIG1hcmdpbjogMCAwIDRweCAwO1xuICAgICAgICAgICAgICAgIGZvbnQtc2l6ZTogMXJlbTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC5hcHAtc3RvcmUtaXRlbS1pbmZvIHAge1xuICAgICAgICAgICAgICAgIG1hcmdpbjogMDtcbiAgICAgICAgICAgICAgICBmb250LXNpemU6IDAuODVyZW07XG4gICAgICAgICAgICAgICAgY29sb3I6ICM2NjY7XG4gICAgICAgICAgICAgICAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgICAgICAgICAgICAgICBvdmVyZmxvdzogaGlkZGVuO1xuICAgICAgICAgICAgICAgIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLmFwcC1zdG9yZS1hY3Rpb25zIHtcbiAgICAgICAgICAgICAgICBtYXJnaW4tbGVmdDogMTZweDtcbiAgICAgICAgICAgICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgICAgICAgICAgIGdhcDogOHB4O1xuICAgICAgICAgICAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAuYXBwLXN0b3JlLWxvYWQtbW9yZSB7XG4gICAgICAgICAgICAgICAgd2lkdGg6IDEwMCU7XG4gICAgICAgICAgICAgICAgcGFkZGluZzogMTJweDtcbiAgICAgICAgICAgICAgICBtYXJnaW4tdG9wOiAyMHB4O1xuICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6IHJnYmEoMCwwLDAsMC4wNSk7XG4gICAgICAgICAgICAgICAgYm9yZGVyOiBub25lO1xuICAgICAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IDhweDtcbiAgICAgICAgICAgICAgICBjdXJzb3I6IHBvaW50ZXI7XG4gICAgICAgICAgICAgICAgZm9udC13ZWlnaHQ6IDYwMDtcbiAgICAgICAgICAgICAgICBjb2xvcjogIzU1NTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC5hcHAtc3RvcmUtbG9hZC1tb3JlOmhvdmVyIHtcbiAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiByZ2JhKDAsMCwwLDAuMSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAuc3RvcmUtZGV0YWlscy1kb3dubG9hZHMge1xuICAgICAgICAgICAgICAgIG1hcmdpbi1sZWZ0OiA4cHg7XG4gICAgICAgICAgICAgICAgZm9udC1zaXplOiAwLjg1cmVtO1xuICAgICAgICAgICAgICAgIGNvbG9yOiAjNTU1O1xuICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6IHJnYmEoMCwwLDAsMC4wNSk7XG4gICAgICAgICAgICAgICAgcGFkZGluZzogMnB4IDZweDtcbiAgICAgICAgICAgICAgICBib3JkZXItcmFkaXVzOiA0cHg7XG4gICAgICAgICAgICAgICAgZGlzcGxheTogaW5saW5lLWZsZXg7XG4gICAgICAgICAgICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICAgICAgICAgICAgICBnYXA6IDRweDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgYDtcbiAgICAgICAgZG9jdW1lbnQuaGVhZC5hcHBlbmRDaGlsZChzdHlsZSk7XG4gICAgfVxuXG4gICAgLy8gQWRkIFBvcHVsYXJpdHkgU29ydCBPcHRpb25cbiAgICBpZiAoc29ydFNlbGVjdCAmJiAhc29ydFNlbGVjdC5xdWVyeVNlbGVjdG9yKCdvcHRpb25bdmFsdWU9XCJwb3B1bGFyaXR5XCJdJykpIHtcbiAgICAgICAgY29uc3QgcG9wT3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgIHBvcE9wdGlvbi52YWx1ZSA9ICdwb3B1bGFyaXR5JztcbiAgICAgICAgcG9wT3B0aW9uLnRleHRDb250ZW50ID0gJ1BvcHVsYXJpdHknO1xuICAgICAgICBzb3J0U2VsZWN0Lmluc2VydEJlZm9yZShwb3BPcHRpb24sIHNvcnRTZWxlY3QuZmlyc3RDaGlsZCk7XG4gICAgICAgIHNvcnRTZWxlY3QudmFsdWUgPSAncG9wdWxhcml0eSc7IC8vIERlZmF1bHQgdG8gcG9wdWxhcml0eVxuICAgIH1cblxuICAgIGxldCB2aXNpYmxlQ291bnQgPSAxMDtcblxuICAgIGNvbnN0IHJlbmRlckFwcHMgPSAoZmlsdGVyOiBzdHJpbmcpID0+IHtcbiAgICAgICAgbGlzdEVsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgICAgIGZlYXR1cmVkU2VjdGlvbi5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgICAgICBzZXR0aW5nc1ZpZXcuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgICAgZGV2Vmlldy5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuXG4gICAgICAgIGlmIChmaWx0ZXIgPT09ICdzZXR0aW5ncycpIHtcbiAgICAgICAgICAgIHNldHRpbmdzVmlldy5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJztcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZmlsdGVyID09PSAnZGV2Jykge1xuICAgICAgICAgICAgZGV2Vmlldy5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJztcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGlzdEVsLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7XG4gICAgICAgIGxpc3RFbC5pbm5lckhUTUwgPSAnJztcbiAgICAgICAgZmVhdHVyZWRMaXN0RWwuaW5uZXJIVE1MID0gJyc7XG4gICAgICAgIFxuICAgICAgICBsZXQgYWxsQXBwcyA9IFsuLi5wbGFjZWhvbGRlckFwcHMsIC4uLnN0b3JlU3RhdGUuZXh0ZXJuYWxBcHBzXTtcbiAgICAgICAgY29uc29sZS5sb2coYEFwcFN0b3JlOiBSZW5kZXJpbmcgJHthbGxBcHBzLmxlbmd0aH0gYXBwcyAoZmlsdGVyOiAke2ZpbHRlcn0pYCk7XG5cbiAgICAgICAgLy8gQXBwbHkgU2VhcmNoIEZpbHRlciAoRW5oYW5jZWQpXG4gICAgICAgIGNvbnN0IHNlYXJjaFRlcm0gPSBzZWFyY2hJbnB1dC52YWx1ZS50b0xvd2VyQ2FzZSgpLnRyaW0oKTtcbiAgICAgICAgaWYgKHNlYXJjaFRlcm0pIHtcbiAgICAgICAgICAgIGFsbEFwcHMgPSBhbGxBcHBzLmZpbHRlcihhcHAgPT4gXG4gICAgICAgICAgICAgICAgYXBwLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2hUZXJtKSB8fCBcbiAgICAgICAgICAgICAgICBhcHAuZGVzY3JpcHRpb24udG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2hUZXJtKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFwcGx5IENhdGVnb3J5IEZpbHRlclxuICAgICAgICBsZXQgYXBwc1RvUmVuZGVyID0gZmlsdGVyID09PSAnYWxsJ1xuICAgICAgICAgICAgPyBhbGxBcHBzXG4gICAgICAgICAgICA6IGFsbEFwcHMuZmlsdGVyKGFwcCA9PiBhcHAuY2F0ZWdvcnkgPT09IGZpbHRlcik7XG4gICAgICAgIFxuICAgICAgICBpZiAoc3RvcmVTdGF0ZS51bnRydXN0ZWRFbmFibGVkICYmIGZpbHRlciA9PT0gJ2FsbCcgJiYgIXNlYXJjaFRlcm0pIHtcbiAgICAgICAgICAgIGFwcHNUb1JlbmRlciA9IFsuLi5hcHBzVG9SZW5kZXIsIHN1c0FwcF07XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBcHBseSBTb3J0aW5nXG4gICAgICAgIGNvbnN0IHNvcnRNb2RlID0gc29ydFNlbGVjdC52YWx1ZTtcbiAgICAgICAgaWYgKHNvcnRNb2RlID09PSAnbmFtZS1hc2MnKSB7XG4gICAgICAgICAgICBhcHBzVG9SZW5kZXIuc29ydCgoYSwgYikgPT4gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc29ydE1vZGUgPT09ICduYW1lLWRlc2MnKSB7XG4gICAgICAgICAgICBhcHBzVG9SZW5kZXIuc29ydCgoYSwgYikgPT4gYi5uYW1lLmxvY2FsZUNvbXBhcmUoYS5uYW1lKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc29ydE1vZGUgPT09ICdyYW5kb20nKSB7XG4gICAgICAgICAgICBhcHBzVG9SZW5kZXIuc29ydCgoKSA9PiBNYXRoLnJhbmRvbSgpIC0gMC41KTtcbiAgICAgICAgfSBlbHNlIGlmIChzb3J0TW9kZSA9PT0gJ3BvcHVsYXJpdHknKSB7XG4gICAgICAgICAgICBhcHBzVG9SZW5kZXIuc29ydCgoYSwgYikgPT4gKGIuZG93bmxvYWRDb3VudCB8fCAwKSAtIChhLmRvd25sb2FkQ291bnQgfHwgMCkpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRkVBVFVSRUQgU0VDVElPTiBMT0dJQ1xuICAgICAgICAvLyBPbmx5IHNob3cgc2VwYXJhdGUgZmVhdHVyZWQgc2VjdGlvbiBpZiBpbiBcIkFsbCBBcHBzXCIgYW5kIG5vdCBzZWFyY2hpbmdcbiAgICAgICAgY29uc3Qgc2hvd0ZlYXR1cmVkU2VwYXJhdGUgPSBmaWx0ZXIgPT09ICdhbGwnICYmICFzZWFyY2hUZXJtO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgZmVhdHVyZWRBcHBzID0gc2hvd0ZlYXR1cmVkU2VwYXJhdGUgXG4gICAgICAgICAgICA/IGFwcHNUb1JlbmRlci5maWx0ZXIoYXBwID0+IGFwcC5mZWF0dXJlZCkgXG4gICAgICAgICAgICA6IFtdO1xuICAgICAgICAgICAgXG4gICAgICAgIGNvbnN0IHJlZ3VsYXJBcHBzID0gc2hvd0ZlYXR1cmVkU2VwYXJhdGUgXG4gICAgICAgICAgICA/IGFwcHNUb1JlbmRlci5maWx0ZXIoYXBwID0+ICFhcHAuZmVhdHVyZWQpXG4gICAgICAgICAgICA6IGFwcHNUb1JlbmRlcjtcblxuICAgICAgICAvLyBSZW5kZXIgRmVhdHVyZWRcbiAgICAgICAgaWYgKGZlYXR1cmVkQXBwcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBmZWF0dXJlZFNlY3Rpb24uc3R5bGUuZGlzcGxheSA9ICdmbGV4JztcbiAgICAgICAgICAgIGZlYXR1cmVkQXBwcy5mb3JFYWNoKGFwcCA9PiByZW5kZXJBcHBJdGVtKGFwcCwgZmVhdHVyZWRMaXN0RWwsICgpID0+IHJlbmRlckFwcHMoZmlsdGVyKSwgdHJ1ZSkpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUGFnaW5hdGlvbiBMb2dpY1xuICAgICAgICBjb25zdCB0b3RhbEFwcHMgPSByZWd1bGFyQXBwcy5sZW5ndGg7XG4gICAgICAgIGNvbnN0IHZpc2libGVBcHBzID0gcmVndWxhckFwcHMuc2xpY2UoMCwgdmlzaWJsZUNvdW50KTtcblxuICAgICAgICAvLyBSZW5kZXIgUmVndWxhclxuICAgICAgICBpZiAodmlzaWJsZUFwcHMubGVuZ3RoID09PSAwICYmIGZlYXR1cmVkQXBwcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgIGxpc3RFbC5pbm5lckhUTUwgPSBgPGRpdiBzdHlsZT1cInBhZGRpbmc6MjBweDsgdGV4dC1hbGlnbjpjZW50ZXI7IGNvbG9yOiM2NjY7XCI+Tm8gYXBwcyBmb3VuZC48L2Rpdj5gO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdmlzaWJsZUFwcHMuZm9yRWFjaChhcHAgPT4gcmVuZGVyQXBwSXRlbShhcHAsIGxpc3RFbCwgKCkgPT4gcmVuZGVyQXBwcyhmaWx0ZXIpKSk7XG5cbiAgICAgICAgLy8gTG9hZCBNb3JlIEJ1dHRvblxuICAgICAgICBpZiAodG90YWxBcHBzID4gdmlzaWJsZUNvdW50KSB7XG4gICAgICAgICAgICBjb25zdCBsb2FkTW9yZUJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICAgICAgbG9hZE1vcmVCdG4uY2xhc3NOYW1lID0gJ2FwcC1zdG9yZS1sb2FkLW1vcmUnO1xuICAgICAgICAgICAgbG9hZE1vcmVCdG4udGV4dENvbnRlbnQgPSBgTG9hZCBNb3JlICgke3RvdGFsQXBwcyAtIHZpc2libGVDb3VudH0gcmVtYWluaW5nKWA7XG4gICAgICAgICAgICBsb2FkTW9yZUJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgICAgICAgICAgIHZpc2libGVDb3VudCArPSAxMDtcbiAgICAgICAgICAgICAgICByZW5kZXJBcHBzKGZpbHRlcik7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgbGlzdEVsLmFwcGVuZENoaWxkKGxvYWRNb3JlQnRuKTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBpZiAoIWNhdGVnb3J5TGlzdC5kYXRhc2V0Lmxpc3RlbmVyKSB7XG4gICAgICAgIGNhdGVnb3J5TGlzdC5kYXRhc2V0Lmxpc3RlbmVyID0gJ3RydWUnO1xuICAgICAgICBjYXRlZ29yeUxpc3QuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdGFyZ2V0ID0gKGUudGFyZ2V0IGFzIEhUTUxFbGVtZW50KS5jbG9zZXN0KCdsaScpO1xuICAgICAgICAgICAgaWYgKHRhcmdldCkge1xuICAgICAgICAgICAgICAgIGNhdGVnb3J5TGlzdC5xdWVyeVNlbGVjdG9yKCcuYWN0aXZlJyk/LmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpO1xuICAgICAgICAgICAgICAgIHRhcmdldC5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTtcbiAgICAgICAgICAgICAgICBjb25zdCBjYXRlZ29yeSA9IHRhcmdldC5kYXRhc2V0LmNhdGVnb3J5ITtcbiAgICAgICAgICAgICAgICB2aXNpYmxlQ291bnQgPSAxMDsgLy8gUmVzZXQgcGFnaW5hdGlvbiBvbiBjYXRlZ29yeSBjaGFuZ2VcbiAgICAgICAgICAgICAgICByZW5kZXJBcHBzKGNhdGVnb3J5KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKCF1bnRydXN0ZWRUb2dnbGUuZGF0YXNldC5saXN0ZW5lcikge1xuICAgICAgICB1bnRydXN0ZWRUb2dnbGUuZGF0YXNldC5saXN0ZW5lciA9ICd0cnVlJztcbiAgICAgICAgdW50cnVzdGVkVG9nZ2xlLmNoZWNrZWQgPSBzdG9yZVN0YXRlLnVudHJ1c3RlZEVuYWJsZWQ7XG4gICAgICAgIHVudHJ1c3RlZFRvZ2dsZS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBzdG9yZVN0YXRlLnVudHJ1c3RlZEVuYWJsZWQgPSB1bnRydXN0ZWRUb2dnbGUuY2hlY2tlZDtcbiAgICAgICAgICAgIGlmICgoY2F0ZWdvcnlMaXN0LnF1ZXJ5U2VsZWN0b3IoJy5hY3RpdmUnKSBhcyBIVE1MRWxlbWVudCk/LmRhdGFzZXQuY2F0ZWdvcnkgPT09ICdhbGwnKSB7XG4gICAgICAgICAgICAgICAgcmVuZGVyQXBwcygnYWxsJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICBcbiAgICAvLyBTZWFyY2ggJiBTb3J0IExpc3RlbmVyc1xuICAgIGNvbnN0IHJlZnJlc2hWaWV3ID0gKCkgPT4ge1xuICAgICAgICBjb25zdCBhY3RpdmVDYXQgPSAoY2F0ZWdvcnlMaXN0LnF1ZXJ5U2VsZWN0b3IoJy5hY3RpdmUnKSBhcyBIVE1MRWxlbWVudCk/LmRhdGFzZXQuY2F0ZWdvcnkgfHwgJ2FsbCc7XG4gICAgICAgIHJlbmRlckFwcHMoYWN0aXZlQ2F0KTtcbiAgICB9O1xuXG4gICAgaWYgKHNlYXJjaElucHV0ICYmICFzZWFyY2hJbnB1dC5kYXRhc2V0Lmxpc3RlbmVyKSB7XG4gICAgICAgIHNlYXJjaElucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgcmVmcmVzaFZpZXcpO1xuICAgICAgICBzZWFyY2hJbnB1dC5kYXRhc2V0Lmxpc3RlbmVyID0gJ3RydWUnO1xuICAgIH1cblxuICAgIGlmIChzb3J0U2VsZWN0ICYmICFzb3J0U2VsZWN0LmRhdGFzZXQubGlzdGVuZXIpIHtcbiAgICAgICAgc29ydFNlbGVjdC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCByZWZyZXNoVmlldyk7XG4gICAgICAgIHNvcnRTZWxlY3QuZGF0YXNldC5saXN0ZW5lciA9ICd0cnVlJztcbiAgICB9XG4gICAgXG4gICAgaWYgKHJlZnJlc2hCdG4gJiYgIXJlZnJlc2hCdG4uZGF0YXNldC5saXN0ZW5lcikge1xuICAgICAgICByZWZyZXNoQnRuLmRhdGFzZXQubGlzdGVuZXIgPSAndHJ1ZSc7XG4gICAgICAgIHJlZnJlc2hCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICByZWZyZXNoQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHJlZnJlc2hCdG4uY2xhc3NMaXN0LmFkZCgncm90YXRpbmcnKTtcbiAgICAgICAgICAgIHN0b3JlU3RhdGUuaGFzRmV0Y2hlZCA9IGZhbHNlO1xuICAgICAgICAgICAgc3RvcmVTdGF0ZS5leHRlcm5hbEFwcHMgPSBbXTtcbiAgICAgICAgICAgIGxpc3RFbC5pbm5lckhUTUwgPSBgPGRpdiBzdHlsZT1cInBhZGRpbmc6MjBweDsgdGV4dC1hbGlnbjpjZW50ZXI7XCI+UmVmcmVzaGluZy4uLjwvZGl2PmA7XG4gICAgICAgICAgICBhd2FpdCBmZXRjaEV4dGVybmFsQXBwcygpO1xuICAgICAgICAgICAgcmVmcmVzaEJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgcmVmcmVzaEJ0bi5jbGFzc0xpc3QucmVtb3ZlKCdyb3RhdGluZycpO1xuICAgICAgICAgICAgcmVmcmVzaFZpZXcoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG5cbiAgICBpZiAoIXN0b3JlU3RhdGUuaGFzRmV0Y2hlZCAmJiBDT05GSUcuR0lUSFVCX1VTRVIgJiYgQ09ORklHLkdJVEhVQl9SRVBPKSB7XG4gICAgICAgIGNvbnN0IGxvYWRpbmdJdGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGxvYWRpbmdJdGVtLmNsYXNzTmFtZSA9ICdhcHAtc3RvcmUtaXRlbSc7XG4gICAgICAgIGxvYWRpbmdJdGVtLmlubmVySFRNTCA9IGA8cD4ke2dldFRleHQoJ2FwcHN0b3JlX3N0YXR1c19mZXRjaGluZycpfTwvcD5gO1xuICAgICAgICBsaXN0RWwuaW5zZXJ0QmVmb3JlKGxvYWRpbmdJdGVtLCBsaXN0RWwuZmlyc3RDaGlsZCk7XG4gICAgICAgIFxuICAgICAgICBhd2FpdCBmZXRjaEV4dGVybmFsQXBwcygpO1xuICAgICAgICBpZiAobG9hZGluZ0l0ZW0ucGFyZW50Tm9kZSA9PT0gbGlzdEVsKSBsaXN0RWwucmVtb3ZlQ2hpbGQobG9hZGluZ0l0ZW0pO1xuICAgIH1cblxuICAgIC8vIFJlZnJlc2ggaW5zdGFsbGVkIGxpc3QgaW4gY2FzZSBvZiBleHRlcm5hbCBjaGFuZ2VzXG4gICAgc3RvcmVTdGF0ZS5pbnN0YWxsZWRBcHBzID0gbG9hZEluc3RhbGxlZEFwcHMoKTtcbiAgICByZW5kZXJBcHBzKCdhbGwnKTtcbn1cbiJdLCJtYXBwaW5ncyI6IkFBQ0E7QUFBQTtBQUFBO0FBQUE7QUFJQSxTQUFTLFVBQVUsWUFBWSxxQkFBcUI7QUFDcEQsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsU0FBUyxtQkFBbUIsaUJBQWlCLFVBQVUscUJBQXFCO0FBQ3JGLFNBQVMsZUFBZTtBQUN4QixTQUFTLGVBQWUscUJBQXFCLGlCQUFpQjtBQUM5RCxTQUFTLHNCQUFzQiwyQkFBMkI7QUFDMUQsU0FBUywrQkFBK0I7QUFDeEMsU0FBUyxjQUFjO0FBTXZCLE1BQU0sZ0JBQWdCO0FBQ3RCLE1BQU0sWUFBWTtBQXFCbEIsTUFBTSxrQkFBNkIsQ0FBQztBQUdwQyxlQUFlLHFCQUFzRDtBQUNqRSxRQUFNLE9BQU8sT0FBTztBQUNwQixRQUFNLE9BQU8sT0FBTztBQUNwQixNQUFJLENBQUMsUUFBUSxDQUFDLEtBQU0sUUFBTyxDQUFDO0FBRTVCLE1BQUk7QUFDQSxVQUFNLFdBQVcsTUFBTSxNQUFNLGdDQUFnQyxJQUFJLElBQUksSUFBSSw2QkFBNkI7QUFBQSxNQUNsRyxTQUFTLEVBQUUsVUFBVSxnQ0FBZ0M7QUFBQSxNQUNyRCxPQUFPO0FBQUEsSUFDWCxDQUFDO0FBQ0QsUUFBSSxTQUFTLElBQUk7QUFDYixhQUFPLE1BQU0sU0FBUyxLQUFLO0FBQUEsSUFDL0I7QUFBQSxFQUNKLFNBQVMsR0FBRztBQUNSLFlBQVEsS0FBSyxrQ0FBa0MsQ0FBQztBQUFBLEVBQ3BEO0FBQ0EsU0FBTyxDQUFDO0FBQ1o7QUFFQSxlQUFl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